/*
  导入后的冒烟求解，两个厂商的导入器共用。

  "结构上没毛病"和"求解器认得出来"是两回事：厂商的信号命名与 DEFINITIONS /
  dialect.js 对不上时，引脚照样都在、界面照样打得开，只是每一路需求都无解。
  这种静默失败最难发现，所以在导入这一步就报出来。H7 的以太网就是这样发现的
  （CubeMX 库用模式中立的 ETH_TXD0，而变体表要 ETH_RMII_TXD0）。

  报告要分清两种"排不出来"，否则会把正确的求解结果误报成数据错误：
  - 命名对不上   → 数据问题，要修导入器或补方言
  - 脚不够用     → 真实约束。小封装上唯一的落点常常正好是 SWD 脚，被默认的
                   调试口保护排除掉，那是求解器判断正确。
*/
import { DEFINITIONS, allocatePins, instancesForType } from "../../src/lib/allocator.js";
import { requestTypesFor } from "../../src/lib/peripherals.js";

export function smokeSolve(device) {
  const unsolvable = [];
  for (const type of requestTypesFor(device, device.uiProfile)) {
    const instances = instancesForType(device, type);
    if (instances.length === 0) continue; // 这颗片子没有这种外设，正常
    if (allocatePins(device, [{ id: "smoke", type }], { maxSolutions: 1 }).solutions.length > 0) continue;
    const relaxed = allocatePins(device, [{ id: "smoke", type }], {
      maxSolutions: 1, protectDebug: false, protectOscillator: false,
    });
    unsolvable.push({ type, instances, blockedByProtection: relaxed.solutions.length > 0 });
  }
  return {
    naming: unsolvable.filter((item) => !item.blockedByProtection),
    protectionOnly: unsolvable.filter((item) => item.blockedByProtection),
  };
}

export function reportSmokeSolve(device) {
  const { naming, protectionOnly } = smokeSolve(device);
  if (naming.length > 0) {
    console.warn("\n⚠ 以下外设解析出了实例、却一路都排不出来——多半是信号命名与");
    console.warn("  src/lib/allocator.js 的变体表对不上，需要补 src/lib/dialect.js 或导入器的映射：");
    for (const { type, instances } of naming) {
      console.warn(`    ${type}: ${instances.slice(0, 4).join(" / ")}${instances.length > 4 ? " …" : ""}`);
      const wanted = DEFINITIONS[type].variants[DEFINITIONS[type].defaultVariant]?.signals;
      if (wanted) console.warn(`      默认变体要的信号: ${wanted.join(", ")}`);
    }
  }
  if (protectionOnly.length > 0) {
    console.log(
      `\n提示：${protectionOnly.map((item) => item.type).join(" / ")} 只有关掉调试口/晶振保护才排得出来——`
      + "\n      落点与 SWD 或晶振脚重合，属于真实约束，数据没问题。",
    );
  }
  if (naming.length === 0) console.log("冒烟求解通过：命名与变体表对得上。");
  return { naming, protectionOnly };
}
