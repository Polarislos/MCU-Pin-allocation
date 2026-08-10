/*
  嘉立创EDA 专业版扩展：引脚规划器

  两条命令：
    核对引脚方案    只读，回答"库里这颗符号和我的方案是同一颗片子吗"
    应用引脚方案    核对通过后，直接把方案里的网络名打到引脚上

  「应用」取代了原来那条 EDA 导出 CSV → 规划器填表 → EDA 导入 CSV 的往返链路。
  能取代是因为往返存在的唯一理由——规划器拿不到符号上的引脚名——在扩展里不成立：
  getState_PinName() 直接就能读到。详见 apply.ts 开头。

  ── 写入前必须核对 ──────────────────────────────────────────────────
  自动打网络标签最危险的失败不是"打不上"，而是**打上了但错位一格**——画完板子、
  打完样才发现。所以 applyPinPlan 里核对是强制前置的，脚数不符或整片名字对不上
  一律拒绝写入，零星几个不同才让用户确认后继续。

  ── 属性都是 protected ──────────────────────────────────────────────
  引脚的 x / y / pinNumber / pinName / rotation / pinLength 全部 protected，
  只能通过 getState_X() / getState_PinNumber() 这类访问器读。官方文档的属性表
  看起来像是可以直接读字段，还把 pinNumber 写成全小写的 pinnumber——两处都和
  @jlceda/pro-api-types 对不上，以类型定义为准。跑 npx tsc --noEmit 能提前拦住。
*/

import { TITLE, readPlanFile, report } from "./plan.js";
import { checkAgainstSymbol } from "./match.js";
import { listComponents, readSelectedComponentIds, resolveTargetComponent } from "./target.js";

export { applyPinPlan, resetCalibration, setLabelLength, undoLastApply } from "./apply.js";

/* 脚手架约定的生命周期入口。这个扩展是纯菜单触发，启动时无事可做，
   但这个 export 必须在——缺了它扩展引擎加载会报错。 */
// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: "onStartupFinished", arg?: string): void {}

const VERIFY_TITLE = "核对引脚方案";

export async function verifyPinPlan(): Promise<void> {
  /* 顺序要紧：选中状态必须在文件选择框之前读，理由见 readSelectedComponentIds。 */
  const components = await listComponents();
  const preselected = await readSelectedComponentIds(new Set(components.map((item) => item.id)));

  const plan = await readPlanFile();
  if (!plan) return;

  const targetId = await resolveTargetComponent(components, preselected, plan, VERIFY_TITLE);
  if (!targetId) return;

  const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(targetId);
  if (!pins || pins.length === 0) {
    report([
      "这个器件读不到任何引脚。",
      "",
      "如果它是多 part 符号，试试选中带引脚的那个 part。",
    ], VERIFY_TITLE);
    return;
  }
  const targetLabel = components.find((item) => item.id === targetId)?.label ?? "（未知器件）";
  const check = checkAgainstSymbol(pins, plan);

  const lines: string[] = [
    `方案器件：${plan.device.partNumber}  ${plan.device.package}  ${plan.device.pinCount} 脚`,
    `数据源：${plan.device.source}`,
    `核对对象：${targetLabel}`,
    `符号引脚：${pins.length} 个（去重后 ${check.byDesignator.size} 个编号）`,
    "",
  ];

  /* ① 脚数。多 part 符号（电源和 GPIO 拆成 A/B/C 几个 unit）在这里会表现为
     "符号脚数少于方案脚数"——这不是数据错，是只选中了其中一个 part。 */
  if (check.byDesignator.size !== plan.device.pinCount) {
    lines.push(
      `✗ 脚数对不上：符号 ${check.byDesignator.size}，方案 ${plan.device.pinCount}。`,
      "",
      check.byDesignator.size < plan.device.pinCount
        ? "如果这颗符号被拆成了多个 part（电源一个 part、GPIO 另一个），"
          + "当前只能核对选中的这一个 part。下一版会支持跨 part 合并。"
        : "符号的引脚编号比方案多，可能选错了器件。",
    );
    if (check.duplicates.length > 0) {
      lines.push("", `另外符号里有重复的引脚编号：${check.duplicates.slice(0, 10).join(", ")}`);
    }
    report(lines, VERIFY_TITLE);
    return;
  }

  /* ② 逐脚比名字。这一步才是真正防错位的部分：脚数一样但整体偏移一格，
     只有比名字才看得出来。 */
  if (check.missing.length === 0 && check.mismatched.length === 0) {
    lines.push(
      `✓ ${plan.device.pinCount} 个引脚全部匹配。`,
      "",
      `可以用「应用引脚方案...」把这 ${plan.labels.length} 条网络标签直接打上去。`,
    );
    if (plan.warnings.length > 0) {
      lines.push("", "规划器在导出时有以下提示：", ...plan.warnings.map((text) => `  · ${text}`));
    }
    report(lines, VERIFY_TITLE);
    return;
  }

  lines.push(`✗ 核对未通过，不建议套用本方案。`, "");
  if (check.missing.length > 0) {
    lines.push(
      `符号上找不到这 ${check.missing.length} 个引脚编号：`,
      `  ${check.missing.slice(0, 12).join(", ")}${check.missing.length > 12 ? " …" : ""}`,
      "",
    );
  }
  if (check.mismatched.length > 0) {
    lines.push(
      `这 ${check.mismatched.length} 个脚的名字对不上：`,
      ...check.mismatched.slice(0, 12),
      check.mismatched.length > 12 ? `  …还有 ${check.mismatched.length - 12} 个` : "",
      "",
      "整体错位（比如全部差一格）通常说明符号的引脚编号规则和数据手册不同；"
        + "零星几个对不上，多半只是库里的引脚名写法不一样，可以人工确认后忽略。",
    );
  }
  report(lines, VERIFY_TITLE);
}

/* TITLE 在 plan.ts 里定义，这里 re-export 一下，方便后续命令沿用同一个标题。 */
export { TITLE };
