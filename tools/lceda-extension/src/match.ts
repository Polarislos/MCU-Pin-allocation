/*
  符号引脚 ↔ 方案引脚的比对。

  这一套规则和 src/lib/fanout.js 的 pinNameMatches 是同一份（那边比对的是扇出
  表格里的 pinName，来源其实是同一个符号）。**两处实现要一起改。**
*/

import type { PinPlan } from "./plan.js";

/*
  符号上的引脚名和数据手册名很少逐字相同：库里常写成 PA5/SPI1_SCK、PA5-CK，
  或者给重复的电源脚编号（VSS_1 / VSS_2 / VSS_3，而 CubeMX 里三个都叫 VSS）。
  所以比对不能用相等，取"归一化后一边是另一边加了后缀"。

  归一化把分隔符压成一个 "/" 而不是删掉——删掉就丢了词的边界：VSS_1 会变成
  VSS1，和 PA15 这种"编号是名字本身一部分"的写法再也分不开，于是要么放过
  PA1≈PA15 这种真错位，要么误报 VSS_1≠VSS。保留边界两个都能判对。
*/
export function normalize(name: string): string {
  return String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/*
  full 是不是 base 加了后缀？只认两种后缀，别的都算对不上：
    · 从分隔符开始的       PA5 → PA5/SPI1/SCK、VSS → VSS/1
    · 紧跟在字母后的纯数字  VDD → VDD2（库里不加分隔符的电源序号）
  第二条要求 base 以字母结尾，这样 PA1 不会匹配上 PA15——那才是真错位。
  也不接受直接续字母（VSS → VSSA 是另一个脚，不是后缀）。
*/
function extendsName(full: string, base: string): boolean {
  if (!full.startsWith(base)) return false;
  const rest = full.slice(base.length);
  if (rest.startsWith("/")) return true;
  return /[A-Z]$/.test(base) && /^\d+$/.test(rest);
}

export function nameMatches(symbolPinName: string, planPinName: string): boolean {
  const symbol = normalize(symbolPinName);
  const plan = normalize(planPinName);
  if (!plan) return true; // 方案里没给名字就不校验这一脚
  if (symbol === plan) return true;
  /* 两个方向都试：后缀既可能在符号这边（库里把复用功能写进名字、给电源脚编号），
     也可能在方案这边（数据源写 VSS_1，而库里就叫 VSS）。 */
  return extendsName(symbol, plan) || extendsName(plan, symbol);
}

export interface CheckResult {
  /* 引脚编号 → 符号上的引脚名 */
  byDesignator: Map<string, string>;
  duplicates: string[];
  /* 方案里有、符号上找不到的引脚编号 */
  missing: string[];
  /* 脚号对得上但名字对不上的，已格式化成可直接展示的行 */
  mismatched: string[];
  /* 脚数不符 / 有缺脚——这类不能靠人工判断放过，写入必须拒绝 */
  fatal: boolean;
}

/*
  比一遍符号和方案。

  分成 fatal 和非 fatal 两档，是因为两种失败的性质完全不同：

    脚数不符、有缺脚  → 结构性错误（选错器件、多 part 符号只选中一个 part）。
                       在这种符号上打标签一定是错的，拒绝。
    零星名字对不上    → 库里引脚名写法不同是常态（PC13-TAMPER-RTC vs PC13）。
                       整片对不上才说明选错了片子，而"整片"由调用方按比例判断。
*/
export function checkAgainstSymbol(
  pins: Array<{ getState_PinNumber: () => string; getState_PinName: () => string }>,
  plan: PinPlan,
): CheckResult {
  const byDesignator = new Map<string, string>();
  const duplicates: string[] = [];
  for (const pin of pins) {
    const key = String(pin.getState_PinNumber() ?? "").trim();
    if (!key) continue;
    if (byDesignator.has(key)) duplicates.push(key);
    else byDesignator.set(key, String(pin.getState_PinName() ?? ""));
  }

  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const planPin of plan.pinout) {
    const symbolName = byDesignator.get(planPin.designator);
    if (symbolName === undefined) {
      missing.push(`${planPin.designator} (${planPin.name})`);
    } else if (!nameMatches(symbolName, planPin.name)) {
      mismatched.push(`  脚 ${planPin.designator}：符号「${symbolName}」 ≠ 方案「${planPin.name}」`);
    }
  }

  return {
    byDesignator,
    duplicates,
    missing,
    mismatched,
    fatal: byDesignator.size !== plan.device.pinCount || missing.length > 0,
  };
}

/*
  名字对不上多少个才算"选错了片子"。

  和 fanout.js 的 IDENTITY_MISMATCH_LIMIT 是同一个阈值、同一个理由：库里零星几个
  脚写法不同是常态，整片对不上才是选错了器件。
*/
export const IDENTITY_MISMATCH_LIMIT = 0.2;

export function looksLikeWrongDevice(result: CheckResult, plan: PinPlan): boolean {
  return result.mismatched.length > plan.device.pinCount * IDENTITY_MISMATCH_LIMIT;
}
