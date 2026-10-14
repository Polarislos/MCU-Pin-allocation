import { peripheralFunctions } from "./peripherals.js";
import { checkUsage, defaultParams } from "./peripheralUsage.js";

/* 从封装引脚复用表提取外设实例；侧栏目录可能不展示 FMC 等并行外设。 */
export function checkGuideUsage(mcu, usage) {
  if (!mcu || !usage) return { checks: [], matches: [], partial: [] };
  const names = mcu.pins.flatMap((pin) => [
    ...(pin.functions || []).map((item) => item.name),
    ...(pin.additionalFunctions || []),
  ]);
  const instances = new Set();
  for (const type of usage.types) {
    const matcher = new RegExp(`^${type}\\d*_`);
    for (const name of names) if (matcher.test(name)) instances.add(name.split("_")[0]);
  }
  const checks = [...instances].map((instance) => {
    const signals = [...new Set(peripheralFunctions(mcu, instance).map(([name]) => name))];
    const entry = { instance, signals };
    return { entry, result: checkUsage(usage, defaultParams(usage), entry) };
  });
  return {
    checks,
    matches: checks.filter(({ result }) => result.ok),
    partial: checks.filter(({ result }) => !result.ok),
  };
}
