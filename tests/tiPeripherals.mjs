/*
  TI 外设摘要（SysConfig 器件族数据）。

  对照过的事实（SysConfig 1.28 deviceData，与 TI datasheet 的外设表一致）：
    MSPM0G3507  有 CAN-FD（CANFD0 → 按 datasheet 写作 CAN0，接口类型 MCAN）
    MSPM0G1507  同一代但没有 CAN-FD
    TM4C123GH6PM 有 USB0、PWM0/1；同族的 TM4C1231H6PZ 没有——族数据里按型号列了外设
    AM3358      MMC0–2、GPMC、EMIF、LCDC（处理器线，类型由 interfacePin 反推）
    TMS320F28069 SPIA/SCIA 等 C2000 命名
*/
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseConditions, peripheralVocabulary, profileOf, searchDevices } from "../src/lib/deviceSearch.js";

const index = JSON.parse(await readFile(new URL("../src/data/deviceIndex.json", import.meta.url), "utf8"));
const vocabulary = peripheralVocabulary(index);
const ti = index.devices.filter((device) => device.vendor === "ti");
const find = (part, pkg) => {
  const found = ti.find((device) => device.part === part && (!pkg || device.package === pkg));
  assert.ok(found, `索引里没有 ${part} ${pkg || ""}`);
  return found;
};
const instances = (part, pkg) => profileOf(index, find(part, pkg));
const names = (part, pkg) => new Set(instances(part, pkg).map((item) => item.name));
const types = (part, pkg) => new Set(instances(part, pkg).map((item) => item.type));
const cond = (text) => parseConditions(text, vocabulary).parsed;
const parts = (options) => new Set(searchDevices(index, { ...options, pageSize: 1e6 }).items.map((item) => item.device.part));

/* 覆盖面：几乎每个 (型号, 封装) 都有外设档案 */
const covered = ti.filter((device) => device.pf != null).length;
assert.ok(covered / ti.length > 0.95, `TI 外设覆盖率只有 ${covered}/${ti.length}`);

/* MSPM0：datasheet 写法，类型来自接口 */
const g3507 = instances("MSPM0G3507", "LQFP-64(PM)");
const can0 = g3507.find((item) => item.name === "CAN0");
assert.ok(can0, "CANFD0 要按 datasheet 写作 CAN0，与引脚数据、求解器一致");
assert.equal(can0.type, "MCAN");
assert.deepEqual([...can0.signals].sort(), ["RX", "TX"], "CANFD0.CANTX 归一化成 TX");
assert.ok(names("MSPM0G3507", "LQFP-64(PM)").has("TIMA0"));
assert.equal(g3507.find((item) => item.name === "TIMA0").type, "GPTIMER");
assert.ok(!types("MSPM0G1507", "LQFP-64(PM)").has("MCAN"), "G150x 没有 CAN-FD");
for (const noise of ["GPIO", "IOMUX", "SYSCTL", "DEBUGSS", "DMA"]) {
  assert.ok(!types("MSPM0G3507", "LQFP-64(PM)").has(noise), `${noise} 不算外设`);
}

/* 族内按型号区分外设 */
assert.ok(names("TM4C123GH6PM").has("USB0") && names("TM4C123GH6PM").has("PWM0"));
assert.ok(!names("TM4C1231H6PZ").has("USB0") && !names("TM4C1231H6PZ").has("PWM0"), "TM4C1231 没有 USB 和 PWM");
assert.equal(find("TM4C123GH6PM").pinCount, 64, "脚数取 legacyPackage，不能数可复用焊盘");

/* 处理器线：类型由 interfacePin 反推，域前缀/实例号去掉 */
const am = types("AM3358");
for (const type of ["MMC", "GPMC", "EMIF", "LCDC", "MCASP", "DCAN", "UART"]) assert.ok(am.has(type), `AM3358 缺 ${type}`);
const tiTypes = new Set(ti.flatMap((device) => (profileOf(index, device) || []).map((item) => item.type)));
for (const type of tiTypes) {
  assert.ok(!/^(MCU|WKUP|MSS)_/.test(type), `${type} 还带着域前缀`);
  assert.ok(!/(GPIO|VDD|DEBUG)/.test(type), `${type} 是引脚分组，不是外设`);
}

/* C2000 的 SD 是 Σ-Δ 滤波，不是 SD 卡 */
const sdCard = parts({ conditions: cond("SD卡") });
assert.ok(sdCard.has("AM3358"), "AM3358 的 MMC 应计入 SD 卡分组");
assert.ok([...sdCard].every((part) => !/^TMS320F28/.test(part)), "C2000 的 SDFM 不是 SD 卡");

/* 跨厂商分组 */
const can = parts({ conditions: cond("CAN总线") });
assert.ok(can.has("MSPM0G3507") && can.has("TM4C123GH6PM") && can.has("STM32F407VGTx"));
assert.ok(!can.has("MSPM0G1507"));
const strictFdcan = parts({ conditions: cond("FDCAN") });
assert.ok(!strictFdcan.has("MSPM0G3507"), "严格的 FDCAN 只匹配 ST 的叫法");
assert.ok(parts({ conditions: cond("SPI总线") }).has("TM4C123GH6PM"), "TM4C 的 SSI 归入 SPI 总线");

/* 用途检查不覆盖 TI：不判断，不当作"不满足" */
const usage = searchDevices(index, { text: "MSPM0G3507", conditions: cond("SD4位") });
assert.equal(usage.total, 0);
assert.ok(usage.uncovered > 0, "TI 器件应计入'用途检查未覆盖'");
const withType = searchDevices(index, { text: "AM3358", conditions: cond("SD4位 UART") });
assert.equal(withType.total, 0);
assert.ok(withType.uncovered > 0);

console.log(`TI peripherals: ok（${covered}/${ti.length} 个组合有外设档案）`);
