/*
  把方案里的网络名打到符号的引脚上——原来那条「EDA 导出 CSV → 规划器填表 →
  EDA 导入 CSV」往返链路，在这里被一条命令取代。

  ── 为什么原来要绕 CSV ──────────────────────────────────────────────
  规划器在浏览器里，拿不到符号上的引脚名（库里写作 VSS_1、PC13-TAMPER-RTC，和
  数据手册对不上），只能让 EDA 先导出一份扇出模板，在模板上改 netname 一列再导
  回去。而扩展跑在 EDA 里，getState_PinName() 直接就能读到——那份模板从一开始
  就是多余的，它只是把扩展本来就有的数据用文件绕了一圈。

  ── 为什么用导线而不是 createNetLabel ───────────────────────────────
  eda.sch_PrimitiveAttribute.createNetLabel(x, y, net) 是存在的（属性图元，不在
  「原理图 & 符号」图元分类下，按图元类去找会漏掉）。但没用它，两个原因：

    · SCH_PrimitiveAttribute.delete() 标着 @internal，注释写明"属性图元不支持
      删除，本接口调用将不会有任何效果"。**建了就删不掉的东西不能拿来做可重放
      的导入**——改方案是常态，第二次应用必须能先清干净上一次。
    · 它标着 ADD since EDA v4，而本扩展声明支持 ^3.2.0。

  SCH_PrimitiveWire 建、删、查都齐全。导线带显式 net 就是专业版意义上的网络
  标签，扇出功能本身产出的也是这个。

  ── 重放靠图元 ID，不靠网络名 ───────────────────────────────────────
  按网络名清（getAll(net)）只能清掉"新方案里还存在的名字"，上一版有、这一版
  没有的会变成孤儿留在图上。所以每次应用都把创建出来的导线 ID 记进
  sys_Storage，下次先按 ID 删——改名和删除的那些才能一起清干净。

  按坐标清也能做到这一点，但会连用户自己手画的线一起删掉。所以坐标只用来
  **发现**（这个脚上已经有线了 → 跳过并报出来），不用来删。
*/

import type { PinPlan } from "./plan.js";
import type { PinOrigin, Point, SymbolPin } from "./geometry.js";
import { TITLE, askNumber, confirm, readPlanFile, report } from "./plan.js";
import { checkAgainstSymbol, looksLikeWrongDevice } from "./match.js";
import {
  centroidOf,
  connectionPointOf,
  normalizeLengthMultiple,
  pointsOfLine,
  readPin,
  samePoint,
  stubOf,
} from "./geometry.js";
import { listComponents, readSelectedComponentIds, resolveTargetComponent } from "./target.js";

const APPLY_TITLE = "应用引脚方案";

/* (x, y) 是引脚的连接点还是根部——文档没说，靠试画一根问出来，答案存这里。 */
const ORIGIN_KEY = "pinOrigin";
/* 标签导线长度，单位是 pinLength 的倍数。见「设置标签长度」。 */
const LENGTH_KEY = "labelLengthMultiple";
/* { [componentId]: { designator, at, wireIds } } */
const APPLIED_KEY = "appliedWires";
const LAST_COMPONENT_KEY = "lastAppliedComponentId";

/* 没设置过时 getExtensionUserConfig 回 undefined，normalizeLengthMultiple 认得
   这一档并回默认值——所以这里不必再 ?? 一次。 */
function readLengthMultiple(): number {
  return normalizeLengthMultiple(eda.sys_Storage.getExtensionUserConfig(LENGTH_KEY));
}

interface AppliedRecord {
  designator: string;
  at: string;
  wireIds: string[];
}

type AppliedMap = Record<string, AppliedRecord>;

function readAppliedMap(): AppliedMap {
  const stored = eda.sys_Storage.getExtensionUserConfig(APPLIED_KEY);
  return (stored && typeof stored === "object" ? stored : {}) as AppliedMap;
}

/*
  电源脚不在求解结果里（它们不参与分配），但打标签的时候一样要打，否则整片
  电源引脚都是空的，还得在 EDA 里手填九次。

  和 src/lib/fanout.js 的 powerNetOf 是同一套判断，按**数据手册的引脚名**（方案
  里的 name）而不是符号名——符号名可能是 VSS_1、VSS_3 这种带序号的写法。
  VREF+/VCAP 这类没有通用叫法的不猜，跳过并在报告里点名。
*/
const POWER_NETS = { ground: "GND", supply: "+3V3" };

function powerNetOf(planPinName: string): string | null {
  const name = String(planPinName || "").toUpperCase();
  if (name.startsWith("VSS") || name === "GND") return POWER_NETS.ground;
  if (name.startsWith("VDD") || name === "VBAT") return POWER_NETS.supply;
  return null;
}

interface Assignment {
  pin: SymbolPin;
  net: string;
  point: Point;
  line: number[];
}

/* 删一批导线。delete() 接受数组，一次调用删完——这既比循环快，也让"撤销上次
   应用"在用户那边尽量表现成一步而不是一百步。 */
async function deleteWires(wireIds: string[]): Promise<void> {
  if (wireIds.length === 0) return;
  try {
    await eda.sch_PrimitiveWire.delete(wireIds);
  } catch {
    /* 图元可能已被用户手动删掉了，删不掉不算错——本来就是要它不存在。 */
  }
}

/*
  校准 (x, y) 的语义：先画一根，让用户看一眼。

  这一步是整个写入流程里唯一无法从 API 推出来的东西，也是唯一可能"看起来成功
  但实际错位"的地方，所以它是强制的，不能跳过。答案存进 sys_Storage，之后
  不再问——一次校准，永久生效。

  返回 null 表示用户两种都否掉了，或者中途取消。
*/
async function calibrateOrigin(
  sample: SymbolPin,
  centroid: Point,
  multiple: number,
  created: string[],
): Promise<PinOrigin | null> {
  const stored = eda.sys_Storage.getExtensionUserConfig(ORIGIN_KEY);
  if (stored === "tip" || stored === "root") return stored;

  const candidates: PinOrigin[] = ["tip", "root"];
  for (const origin of candidates) {
    const line = stubOf(sample, centroid, origin, multiple);
    const wire = await eda.sch_PrimitiveWire.create(line, `__PINPLAN_CALIBRATE__`);
    const wireId = wire?.getState_PrimitiveId();
    if (!wireId) continue;

    const ok = await confirm([
      "第一次使用，先画一根线校准一下坐标——只画了这一根，还没动其它引脚。",
      "",
      `画在了脚 ${sample.designator}（${sample.name}）上。请看画布：`,
      "",
      "  这根线是**接在引脚的末端**、并且**朝符号外面**延伸的吗？",
      "",
      "  是 → 校准完成，继续打完剩下的标签",
      "  否 → 换另一种算法再画一次给你看",
      "",
      `（线段：(${line[0]}, ${line[1]}) → (${line[2]}, ${line[3]})）`,
    ], "是，位置对", "否，位置不对", APPLY_TITLE);

    await deleteWires([wireId]);

    if (ok) {
      await eda.sys_Storage.setExtensionUserConfig(ORIGIN_KEY, origin);
      return origin;
    }
  }

  report([
    "两种算法画出来的位置你都否了，已经把试画的线删掉，没有改动原理图。",
    "",
    "可能是这颗符号的引脚几何和常规写法不同。请把下面这些数字反馈给规划器项目：",
    "",
    `  脚号 ${sample.designator}  名称 ${sample.name}`,
    `  x=${sample.x}  y=${sample.y}  rotation=${sample.rotation}  pinLength=${sample.pinLength}`,
    `  重心 (${centroid.x.toFixed(2)}, ${centroid.y.toFixed(2)})`,
    "",
    "在这之前，仍然可以走「导出扇出表格 → 规划器填表 → 导入」那条老路。",
  ], APPLY_TITLE);
  /* created 里此刻应该是空的，但保险起见清一遍——绝不留半成品在图上 */
  await deleteWires(created);
  return null;
}

export async function applyPinPlan(): Promise<void> {
  /* 顺序要紧：选中状态必须在文件选择框之前读，理由见 readSelectedComponentIds。 */
  const components = await listComponents();
  const preselected = await readSelectedComponentIds(new Set(components.map((item) => item.id)));

  const plan = await readPlanFile();
  if (!plan) return;

  const targetId = await resolveTargetComponent(components, preselected, plan, APPLY_TITLE);
  if (!targetId) return;

  const rawPins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(targetId);
  if (!rawPins || rawPins.length === 0) {
    report([
      "这个器件读不到任何引脚。",
      "",
      "如果它是多 part 符号，试试选中带引脚的那个 part。",
    ], APPLY_TITLE);
    return;
  }
  const targetLabel = components.find((item) => item.id === targetId)?.label ?? "（未知器件）";

  /* ── 写之前先核对。核对不过就不写——这是整个扩展的前提。 ── */
  const check = checkAgainstSymbol(rawPins, plan);
  if (check.fatal) {
    const lines = [
      `不能应用：符号和方案对不上。`,
      "",
      `方案器件：${plan.device.partNumber}  ${plan.device.pinCount} 脚`,
      `目标器件：${targetLabel}  ${check.byDesignator.size} 脚`,
      "",
    ];
    if (check.byDesignator.size !== plan.device.pinCount) {
      lines.push(check.byDesignator.size < plan.device.pinCount
        ? "符号的引脚编号比方案少。如果这颗符号被拆成了多个 part（电源一个 part、"
          + "GPIO 另一个），当前只能处理选中的这一个 part。"
        : "符号的引脚编号比方案多，可能选错了器件。");
    }
    if (check.missing.length > 0) {
      lines.push(
        "",
        `符号上找不到这 ${check.missing.length} 个引脚编号：`,
        `  ${check.missing.slice(0, 12).join(", ")}${check.missing.length > 12 ? " …" : ""}`,
      );
    }
    if (check.duplicates.length > 0) {
      lines.push("", `符号里有重复的引脚编号：${check.duplicates.slice(0, 10).join(", ")}`);
    }
    report(lines, APPLY_TITLE);
    return;
  }

  if (looksLikeWrongDevice(check, plan)) {
    report([
      "不能应用：这颗符号和方案不是同一片子。",
      "",
      `脚数一样（都是 ${plan.device.pinCount}），但 ${check.mismatched.length} 个脚的名字对不上：`,
      ...check.mismatched.slice(0, 10),
      check.mismatched.length > 10 ? `  …还有 ${check.mismatched.length - 10} 个` : "",
      "",
      "脚数相同只说明封装一样。整片名字对不上通常是选错了器件，"
        + "在这种符号上打标签会得到一整套张冠李戴的网络名，而且看不出来。",
    ], APPLY_TITLE);
    return;
  }

  if (check.mismatched.length > 0) {
    const go = await confirm([
      `有 ${check.mismatched.length} 个脚的名字和方案不一样：`,
      ...check.mismatched.slice(0, 10),
      check.mismatched.length > 10 ? `  …还有 ${check.mismatched.length - 10} 个` : "",
      "",
      "数量不多，多半只是元件库里的引脚名写法不同（库里常把复用功能写进名字）。",
      "标签是**按脚号**打的，不受名字影响。确认这些脚确实对得上就可以继续。",
    ], "确认无误，继续", "取消", APPLY_TITLE);
    if (!go) return;
  }

  /* ── 算出每个脚该打什么 ── */
  const pins = rawPins.map(readPin);
  const centroid = centroidOf(pins);
  const netByDesignator = new Map(plan.labels.map((label) => [label.designator, label.net]));
  const planPinByDesignator = new Map(plan.pinout.map((pin) => [pin.designator, pin]));

  const unnamedPower: string[] = [];
  const targets: SymbolPin[] = [];
  const netOf = new Map<string, string>();
  for (const pin of pins) {
    const signalNet = netByDesignator.get(pin.designator);
    if (signalNet) {
      targets.push(pin);
      netOf.set(pin.designator, signalNet);
      continue;
    }
    const planPin = planPinByDesignator.get(pin.designator);
    if (!planPin || planPin.kind !== "supply") continue;
    const powerNet = powerNetOf(planPin.name);
    if (powerNet) {
      targets.push(pin);
      netOf.set(pin.designator, powerNet);
    } else {
      unnamedPower.push(`${pin.designator} ${planPin.name}`);
    }
  }

  if (targets.length === 0) {
    report(["这份方案里没有任何要打标签的引脚。"], APPLY_TITLE);
    return;
  }

  /* ── 清掉上一次应用留下的线（按 ID，不按网络名）── */
  const applied = readAppliedMap();
  const previous = applied[targetId];
  const removed = previous?.wireIds?.length ?? 0;
  if (removed > 0) {
    const go = await confirm([
      `${targetLabel} 上一次应用（${previous.at}）打了 ${removed} 根标签导线。`,
      "",
      "继续的话会先把那些线删掉，再按新方案重打一遍。",
      "你自己手画的线不受影响——只删本扩展记录在案的那些。",
    ], "删掉旧的，重新应用", "取消", APPLY_TITLE);
    if (!go) return;
    await deleteWires(previous.wireIds);
  }

  /*
    ── 图上已有的导线端点 ──
    必须在自己动手之前采样：清完上一次的线之后、画任何新线（含校准那一根）之前。
    这份快照有两个用处，都依赖"里面一根自己的线都没有"这个前提。
  */
  const existingPoints: Point[] = [];
  const existingWires = await eda.sch_PrimitiveWire.getAll();
  for (const wire of existingWires || []) {
    existingPoints.push(...pointsOfLine(wire.getState_Line()));
  }
  const isFree = (point: Point): boolean =>
    !existingPoints.some((existing) => samePoint(existing, point));

  /*
    ── 校准坐标语义（只在第一次问）──
    试画的那根线要挑一个**两种解释下都空着**的脚。create() 在"坐标上已有图元
    显式指定了网络"时会失败，挑到一个已经连了线的脚，校准就会莫名其妙地两种
    都画不出来，而真正的原因和坐标语义毫无关系。
  */
  const created: string[] = [];
  const multiple = readLengthMultiple();
  const sample = targets.find((pin) =>
    isFree(connectionPointOf(pin, centroid, "tip"))
    && isFree(connectionPointOf(pin, centroid, "root"))) ?? targets[0];
  const origin = await calibrateOrigin(sample, centroid, multiple, created);
  if (!origin) return;

  /* ── 已经有线的脚，跳过而不是覆盖 ──
     快照是自己动手之前取的，所以里面的线都是别人的：用户手画的，或者上一次
     应用之后被改动过、已不在记账里的。覆盖别人的连接是不可接受的副作用。 */
  const assignments: Assignment[] = targets.map((pin) => ({
    pin,
    net: netOf.get(pin.designator)!,
    point: connectionPointOf(pin, centroid, origin),
    line: stubOf(pin, centroid, origin, multiple),
  }));

  const occupied = new Set<string>();
  for (const assignment of assignments) {
    if (!isFree(assignment.point)) occupied.add(assignment.pin.designator);
  }

  const pending = assignments.filter((item) => !occupied.has(item.pin.designator));
  if (pending.length === 0) {
    report([
      "所有要打标签的脚上都已经有导线了，没有改动原理图。",
      "",
      "如果那些是上一次应用留下的，用「撤销上次应用」清掉后再试；",
      "如果是你自己画的，先手动删掉要重打的那些。",
    ], APPLY_TITLE);
    return;
  }

  /* ── 画 ── */
  const failed: string[] = [];
  eda.sys_LoadingAndProgressBar.showProgressBar(0, `${APPLY_TITLE}：${targetLabel}`);
  try {
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      let wireId: string | undefined;
      try {
        const wire = await eda.sch_PrimitiveWire.create(item.line, item.net);
        wireId = wire?.getState_PrimitiveId();
      } catch {
        wireId = undefined;
      }
      if (wireId) created.push(wireId);
      else failed.push(`${item.pin.designator} → ${item.net}`);
      eda.sys_LoadingAndProgressBar.showProgressBar(
        Math.round(((index + 1) / pending.length) * 100),
        `${APPLY_TITLE}：${index + 1} / ${pending.length}`,
      );
    }
  } finally {
    eda.sys_LoadingAndProgressBar.destroyProgressBar();
  }

  /* ── 记账。即使部分失败也要记：画出去的那些必须可撤销。 ── */
  applied[targetId] = {
    designator: targetLabel,
    at: new Date().toLocaleString(),
    wireIds: created,
  };
  await eda.sys_Storage.setExtensionUserConfig(APPLIED_KEY, applied);
  await eda.sys_Storage.setExtensionUserConfig(LAST_COMPONENT_KEY, targetId);

  const signalCount = pending.filter((item) => netByDesignator.has(item.pin.designator)).length;
  const lines = [
    failed.length === 0
      ? `✓ 打了 ${created.length} 根标签导线。`
      : `打了 ${created.length} 根，另有 ${failed.length} 根失败。`,
    "",
    `目标器件：${targetLabel}`,
    `信号 ${signalCount} 根，电源 ${pending.length - signalCount} 根。`,
  ];
  if (removed > 0) lines.push(`已清掉上一次应用的 ${removed} 根。`);
  if (occupied.size > 0) {
    lines.push(
      "",
      `这 ${occupied.size} 个脚上原本就有导线，跳过了（没有覆盖）：`,
      `  ${[...occupied].slice(0, 12).join(", ")}${occupied.size > 12 ? " …" : ""}`,
    );
  }
  if (unnamedPower.length > 0) {
    lines.push("", `这些电源脚没有通用的网络名，没打，请手工处理：${unnamedPower.join("、")}`);
  }
  if (failed.length > 0) {
    lines.push(
      "",
      `这些没画上（多半是该坐标上已有其它网络的图元）：`,
      `  ${failed.slice(0, 12).join("、")}${failed.length > 12 ? " …" : ""}`,
    );
  }
  if (plan.warnings.length > 0) {
    lines.push("", "规划器在导出时有以下提示：", ...plan.warnings.map((text) => `  · ${text}`));
  }
  lines.push(
    "",
    `导线长度为引脚长度的 ${multiple} 倍，嫌长嫌短用菜单里的「设置标签长度」改，`
    + `再应用一次即可。不满意的话用「撤销上次应用」一次清干净。`,
  );
  report(lines, APPLY_TITLE);
}

/*
  撤销上次应用。

  存在的理由：类型定义里没有任何事务 / 批量接口，100 个脚就是 100 次 create，
  各自独立进撤销栈——指望用户按 100 次 Ctrl+Z 是不现实的。按记下来的图元 ID
  一次 delete 掉，比 Ctrl+Z 干净也可控。
*/
export async function undoLastApply(): Promise<void> {
  const applied = readAppliedMap();
  const lastId = eda.sys_Storage.getExtensionUserConfig(LAST_COMPONENT_KEY);
  const record = typeof lastId === "string" ? applied[lastId] : undefined;

  if (!record || record.wireIds.length === 0) {
    report([
      "没有可撤销的记录。",
      "",
      "本扩展只能撤销它自己打的标签导线，并且只记得最近一次。",
    ], APPLY_TITLE);
    return;
  }

  const go = await confirm([
    `要删掉 ${record.designator} 在 ${record.at} 打的 ${record.wireIds.length} 根标签导线吗？`,
    "",
    "只删本扩展记录在案的那些，你自己手画的线不受影响。",
  ], "删掉", "取消", APPLY_TITLE);
  if (!go) return;

  await deleteWires(record.wireIds);
  delete applied[lastId as string];
  await eda.sys_Storage.setExtensionUserConfig(APPLIED_KEY, applied);
  await eda.sys_Storage.deleteExtensionUserConfig(LAST_COMPONENT_KEY);

  report([`已删掉 ${record.wireIds.length} 根标签导线。`], APPLY_TITLE);
}

/*
  设置标签导线的长度。

  单位是 pinLength 的**整数倍**，不是绝对尺寸——理由和 stubOf 里写的一样：栅格
  设置问不到，而 pinLength 的整数倍必然还落在栅格上。取 1.5 倍这种会掉出栅格，
  导线端点不在栅格上连接就不成立，所以输入框 step=1 且取值时还会再取整一次。

  改完不会动已经画好的线——重新「应用引脚方案」才会按新长度重画（会先清掉旧的）。
*/
export async function setLabelLength(): Promise<void> {
  const current = readLengthMultiple();
  const input = await askNumber(
    "标签导线的长度，单位是引脚长度的倍数：",
    `当前 ${current} 倍。数字越大，网络名离符号越远、越不容易和符号挤在一起，`
    + `但也越占版面。必须是整数——非整数会让导线端点掉出栅格，那样就连不上了。`,
    current,
    { min: 1, max: 20 },
    APPLY_TITLE,
  );
  if (input === null) return;

  const multiple = normalizeLengthMultiple(input);
  await eda.sys_Storage.setExtensionUserConfig(LENGTH_KEY, multiple);
  report([
    multiple === input
      ? `标签导线长度已设为引脚长度的 ${multiple} 倍。`
      : `输入的 ${input} 已调整为 ${multiple}（必须是 1～20 的整数）。`,
    "",
    "已经画好的线不受影响。重新「应用引脚方案」会先清掉旧的，再按新长度重画。",
  ], APPLY_TITLE);
}

/*
  重置坐标校准。

  正常情况下用不到——校准一次就对了。留这个入口是因为校准结果是"这台机器上的
  所有符号"共用的，万一遇到一颗几何写法不同的符号，得有办法重新问一遍。
*/
export async function resetCalibration(): Promise<void> {
  const stored = eda.sys_Storage.getExtensionUserConfig(ORIGIN_KEY);
  if (stored !== "tip" && stored !== "root") {
    report(["还没有校准过，下次应用方案时会自动问。"], TITLE);
    return;
  }
  await eda.sys_Storage.deleteExtensionUserConfig(ORIGIN_KEY);
  report([
    `已清掉校准结果（原为 "${stored}"）。`,
    "",
    "下次应用方案时会重新画一根线让你确认。",
  ], TITLE);
}
