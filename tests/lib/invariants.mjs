/*
  对**每一颗**器件都成立的检查。

  以前 verify.mjs 把 H743 和 MSPM0 的断言并排硬写在一起，加到第 10 颗片子时
  这个文件会变成一坨，而且新片子漏了哪条检查根本看不出来。拆成两层：

  - 这里是通用不变量，遍历整个目录跑。加一颗片子自动被覆盖，不用改测试。
  - tests/fixtures/<id>.json 是器件专属抽检（对着 datasheet 人工核对过的
    几十条引脚 → 功能 → AF），由 verify.mjs 统一加载。

  其中最值钱的是 smokeSolve：它能抓出"数据导进来了、但方言没配对，
  求解器一个信号都匹配不上"这类静默失败——那种情况下 UI 照样打得开，
  只是每一路需求都无解。
*/
import assert from "node:assert/strict";
import { DEFINITIONS, allocatePins, instancesForType, isFiveVoltTolerant, supportsFiveVolt, usesRemapGroups } from "../../src/lib/allocator.js";
import { SIGNAL_DIALECTS, signalGrammar } from "../../src/lib/dialect.js";
import { packageLayout } from "../../src/lib/package.js";
import { buildPeripheralCatalog, requestTypesFor } from "../../src/lib/peripherals.js";

const KNOWN_ANALOG_CONVENTIONS = ["st", "ti"];
const KNOWN_STATUS = ["verified", "generated", "draft"];
/* AF 编号上限放宽到 31：15 是 ST 的 AF 位宽，TI 的 PF index 已经用到 13，
   别家 IOMUX 更多。这里只拦明显的脏数据（负数、小数、离谱的大数）。 */
const MAX_AF = 31;

function checkManifest(record, mcu, where) {
  for (const field of ["partNumber", "package", "pinCount"]) {
    assert.equal(record[field], mcu[field], `${where}: 清单里的 ${field} 与数据文件不一致（跑一次 npm run mcu:index）`);
  }
  assert.equal(mcu.id, record.id, `${where}: 数据文件里的 id 与清单不一致`);
  assert.ok(mcu.vendor, `${where}: 缺少 vendor`);
  assert.ok(mcu.source?.document && mcu.source?.revision, `${where}: 缺少 source.document / source.revision——数据没有出处就没法复核`);
  assert.ok(
    KNOWN_STATUS.includes(record.status),
    `${where}: status「${record.status}」未知，应为 ${KNOWN_STATUS.join(" / ")}`,
  );
  assert.ok(
    SIGNAL_DIALECTS.includes(mcu.signalDialect ?? "st"),
    `${where}: signalDialect「${mcu.signalDialect}」没有对应的方言表`,
  );
  assert.ok(
    KNOWN_ANALOG_CONVENTIONS.includes(mcu.analogConvention ?? "st"),
    `${where}: analogConvention「${mcu.analogConvention}」未知`,
  );
}

function checkPins(mcu, where) {
  const pins = mcu.pins;
  assert.ok(Array.isArray(pins) && pins.length > 0, `${where}: pins 为空`);
  assert.equal(pins.length, mcu.pinCount, `${where}: pins 条数与 pinCount 不符`);

  const numbers = pins.map((pin) => pin.number);
  assert.deepEqual(
    [...numbers].sort((left, right) => left - right),
    Array.from({ length: mcu.pinCount }, (_, index) => index + 1),
    `${where}: 脚号不是连续的 1..${mcu.pinCount}（有缺号或重号）`,
  );

  const names = new Set();
  for (const pin of pins) {
    const at = `${where} 脚 ${pin.number}`;
    assert.ok(pin.name, `${at}: 缺少 name`);
    /* 电源脚重名是正常的（VSS 有十几个），GPIO 重名则意味着导入把两行合并错了，
       后面所有"按名字找引脚"的地方都会拿到错的那个。 */
    if (pin.kind === "gpio") {
      assert.ok(!names.has(pin.name), `${at}: GPIO 名「${pin.name}」重复`);
      names.add(pin.name);
    }
    assert.ok(pin.kind, `${at}: 缺少 kind`);
    assert.ok(Array.isArray(pin.functions), `${at}: functions 不是数组`);
    assert.ok(Array.isArray(pin.additionalFunctions), `${at}: additionalFunctions 不是数组`);
    assert.ok(Array.isArray(pin.protection), `${at}: protection 不是数组`);

    /* 同一个脚上出现两次同名功能，说明导入时把两行 datasheet 合并错了。
       求解器会把它当成两个候选，导出时则会重复一行。

       整组重映射的器件是例外：那里 af 是重映射组号，而"部分重映射"下有些
       信号的脚本来就不动（F103 的 TIM3 部分重映射只挪 CH1/CH2，CH3/CH4 仍在
       PB0/PB1），所以 PB0 上 TIM3_CH3 必须同时登记组 0 和组 1。这种器件查重
       用 (名字, 组号) 而不是名字——同名同组重复仍然是数据错。 */
    const perInstanceAf = mcu.afGrouping === "instance";
    const seen = new Set();
    for (const item of pin.functions) {
      assert.ok(item.name, `${at}: 有一条 function 没有名字`);
      const key = perInstanceAf ? `${item.name}|${item.af}` : item.name;
      assert.ok(
        !seen.has(key),
        perInstanceAf
          ? `${at}: 复用功能「${item.name}」在重映射组 ${item.af} 里重复`
          : `${at}: 复用功能「${item.name}」重复`,
      );
      seen.add(key);
      assert.ok(
        Number.isInteger(item.af) && item.af >= 0 && item.af <= MAX_AF,
        `${at}: ${item.name} 的 ${perInstanceAf ? "重映射组号" : "AF 编号"}「${item.af}」不合法`,
      );
    }
  }

  assert.ok(
    pins.some((pin) => pin.kind === "gpio"),
    `${where}: 一个 GPIO 都没有——kind 的取值可能没归一化`,
  );
}

/*
  几何自洽。布局算出来的边和坐标是求解器"靠右/靠左"打分的唯一依据，
  也是封装图的唯一依据；覆盖不全就会有引脚在图上根本画不出来。
*/
function checkGeometry(mcu, where) {
  const layout = packageLayout(mcu);
  const placed = new Set();

  if (layout.kind === "perimeter") {
    for (const side of Object.keys(layout.sides)) {
      for (const pin of layout.sides[side]) {
        assert.ok(!placed.has(pin.number), `${where}: 脚 ${pin.number} 被排进了两条边`);
        placed.add(pin.number);
      }
    }
  } else {
    for (const row of layout.rows) {
      for (const pin of row.cells) {
        if (!pin) continue;
        assert.ok(!placed.has(pin.number), `${where}: 球 ${pin.number} 被排进了两个格子`);
        placed.add(pin.number);
      }
    }
  }
  assert.equal(
    placed.size, mcu.pins.length,
    `${where}: 布局只安置了 ${placed.size} / ${mcu.pins.length} 个引脚，其余的画不出来也算不了方位`,
  );

  for (const pin of mcu.pins) {
    const side = layout.sideOf(pin.number);
    assert.ok(
      layout.availableSides.includes(side),
      `${where}: 脚 ${pin.number} 落到了这个封装没有的边「${side}」`,
    );
    const { x, y } = layout.positionOf(pin.number);
    assert.ok(
      Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1,
      `${where}: 脚 ${pin.number} 的归一化坐标越界（${x}, ${y}）`,
    );
  }
}

/* 声明了耐压白名单，白名单里的每个 ioStructure 就该真的在数据里出现过。
   写错一个字母不会报错，只会悄悄把一批脚判成不耐压。 */
function checkElectrical(mcu, where) {
  if (!supportsFiveVolt(mcu)) {
    assert.ok(
      mcu.pins.every((pin) => isFiveVoltTolerant(mcu, pin) === null),
      `${where}: 没声明耐压白名单时，判定结果必须是 null（未知）而不是 false`,
    );
    return;
  }
  const present = new Set(mcu.pins.map((pin) => pin.ioStructure).filter(Boolean));
  for (const structure of mcu.electrical.fiveVoltTolerantIoStructures) {
    assert.ok(present.has(structure), `${where}: 耐压白名单里的「${structure}」在引脚数据里根本没出现过`);
  }
}

/* 已知的厂商写法。解析完还留着这些名字，就说明方言表漏了一条——
   而漏配的后果不是求解失败（脚照样分得出来），是导出的接线表把线标错。 */
const VENDOR_SPELLINGS = /^(PICO|POCI|SIMO|SOMI|SDI|SDO|C[0-3]N?)$/;

function checkDialect(mcu, where) {
  for (const [type, definition] of Object.entries(DEFINITIONS)) {
    if (definition.family === "analog") continue;
    const grammar = signalGrammar(mcu, type, definition);
    for (const pin of mcu.pins) {
      for (const item of pin.functions) {
        const match = item.name.match(grammar.pattern);
        if (!match) continue;
        const signal = grammar.normalize(match[2]);
        assert.ok(signal, `${where}: ${item.name} 解析出了空信号名`);
        assert.ok(
          !VENDOR_SPELLINGS.test(signal),
          `${where}: ${item.name} 解析出的信号名仍是厂商写法「${signal}」，signalDialect 表漏了一条`,
        );
      }
    }
  }
}

/*
  冒烟求解。对这颗片子上真实存在的每一种外设各要一路，必须解得出来。

  一路都排不出来通常不是"这颗片子不行"，而是数据或方言接错了——所以这条
  失败时要连类型一起报出来，直接指向该改哪张表。
*/
function checkSmokeSolve(record, mcu, where) {
  const types = requestTypesFor(mcu, record.uiProfile);
  assert.ok(types.length > 0, `${where}: 一种可分配的外设都没解析出来`);

  for (const type of types) {
    const instances = instancesForType(mcu, type);
    const plan = allocatePins(mcu, [{ id: "smoke", type }], { maxSolutions: 1 });
    assert.ok(
      plan.solutions.length > 0,
      `${where}: ${type} 有 ${instances.length} 个实例（${instances.slice(0, 3).join("/")}…）却排不出一路——`
      + "多半是方言表里少了信号别名，或数据里的信号名与 DEFINITIONS 对不上",
    );
    const group = plan.solutions[0].groups[0];
    const required = DEFINITIONS[type].variants[DEFINITIONS[type].defaultVariant];
    const expected = required.signals?.length ?? required.channels;
    assert.equal(group.assignments.length, expected, `${where}: ${type} 默认变体应占 ${expected} 个脚`);
    assert.equal(
      new Set(group.assignments.map((item) => item.pin.number)).size, expected,
      `${where}: ${type} 的一组信号里有两条落到了同一个脚`,
    );
    /* 整组重映射的器件上，混着两个重映射组的方案在硬件上根本不存在，但
       UI 照样会把它画出来、导出照样会生成——这是最容易静默漏掉的一类错。
       模拟通道不在 AF 表里、也不受 AFIO 影响（af 恒为 null），不适用。 */
    if (usesRemapGroups(mcu) && !["analog", "gpio"].includes(DEFINITIONS[type].family)) {
      const groups = new Set(group.assignments.map((item) => item.af));
      assert.equal(
        groups.size, 1,
        `${where}: ${type} 的一路方案混用了重映射组 ${[...groups].join("/")}——`
        + "AFIO_MAPR 是按外设整体切换的，这种接法在硬件上不存在",
      );
      assert.equal(group.remap, group.assignments[0].af, `${where}: ${type} 的 group.remap 与实际组号不符`);
    }
  }
}

/*
  重映射数据自洽（只对 afGrouping = "instance" 的器件）。

  组号必须从 0 起连续：0 恒为"无重映射"（复位默认接法），空号意味着导入时
  漏了一组。remapMacros 给了就得覆盖到该实例实际用到的每一组，否则导出的
  头文件里会混着宏和"请自己查手册"的注释。
*/
function checkRemapGroups(mcu, where) {
  if (!usesRemapGroups(mcu)) {
    assert.ok(
      !mcu.remapMacros,
      `${where}: 没声明 afGrouping = "instance" 却带了 remapMacros，这份数据的 af 是 AF 编号不是组号`,
    );
    return;
  }

  const groupsByInstance = new Map();
  for (const pin of mcu.pins) {
    for (const item of pin.functions) {
      const instance = item.name.split("_")[0];
      if (!groupsByInstance.has(instance)) groupsByInstance.set(instance, new Set());
      groupsByInstance.get(instance).add(item.af);
    }
  }

  for (const [instance, groups] of groupsByInstance) {
    const sorted = [...groups].sort((left, right) => left - right);
    assert.equal(sorted[0], 0, `${where}: ${instance} 没有重映射组 0——复位默认接法必须在数据里`);
    assert.deepEqual(
      sorted, sorted.map((_, index) => index),
      `${where}: ${instance} 的重映射组号不连续（${sorted.join(",")}），中间那组多半漏了`,
    );
    const macros = mcu.remapMacros?.[instance];
    if (!macros) continue;
    /* 组 0 是复位默认接法，没有要调用的宏，空串是正确的取值。
       其余档次少了宏名，导出的头文件只能让人自己去翻 hal_gpio_ex.h。 */
    for (const group of sorted.filter((item) => item > 0)) {
      assert.ok(
        macros[group],
        `${where}: ${instance} 的重映射组 ${group} 没有对应的 HAL 宏名（remapMacros 只给了 ${macros.length} 条）`,
      );
    }
  }
}

/* 外设目录：声明的 profile 和通用 profile 都要能建出东西来。
   通用 profile 是新片子的兜底，它对每颗片子都必须可用。 */
function checkCatalog(record, mcu, where) {
  for (const profileId of [record.uiProfile, "generic"]) {
    const catalog = buildPeripheralCatalog(mcu, profileId);
    assert.ok(catalog.length > 0, `${where}: profile「${profileId}」建出了空目录`);
    assert.ok(
      catalog.some((section) => section.items.some((item) => item.modeled)),
      `${where}: profile「${profileId}」里一个可分配的外设实例都没有`,
    );
    for (const section of catalog) {
      assert.ok(section.id && section.label, `${where}: profile「${profileId}」有一节缺少 id/label`);
    }
  }
}

export function checkMcuInvariants(record, mcu) {
  const where = record.partNumber || record.id;
  checkManifest(record, mcu, where);
  checkPins(mcu, where);
  checkGeometry(mcu, where);
  checkElectrical(mcu, where);
  checkRemapGroups(mcu, where);
  checkDialect(mcu, where);
  checkSmokeSolve(record, mcu, where);
  checkCatalog(record, mcu, where);
}
