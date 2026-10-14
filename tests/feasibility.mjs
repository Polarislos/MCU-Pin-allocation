/*
  组合可行性（第 3 层）：把搜索条件交给引脚求解器。

  用仓库里固化的 STM32H743VIT6（LQFP100，按 DS12110 录入）做真实器件，事实
  逐条对照过引脚表：
    - SDRAM：LQFP100 没引出 SDCLK / SDNRAS / BA0…，一个候选都没有 → 证明无解
    - RGB565 + RMII：LCD_G5 只在 PB11，而 PB11 也是 ETH_TX_EN 唯一的脚 → 证明无解
    - SDMMC2 4 位：D2/D3 只在 PB3/PB4，这两个是 JTAG 脚 → 保留调试口时无解，
      不保留时有解
  另用合成器件覆盖"宽总线的便宜组合全都撞车"这种预枚举会漏掉的情形。
*/
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { conditionLabel, parseConditions, peripheralVocabulary, profileOf } from "../src/lib/deviceSearch.js";
import { checkFeasibility, planRequests } from "../src/lib/feasibility.js";
import { allocatePins } from "../src/lib/allocator.js";
import { ensureMcuLoaded } from "../src/lib/mcuCatalog.js";

const index = JSON.parse(await readFile(new URL("../src/data/deviceIndex.json", import.meta.url), "utf8"));
const vocabulary = peripheralVocabulary(index);
const h743 = await ensureMcuLoaded("st-stm32h743vit6-lqfp100");
const h743Profile = profileOf(index, index.devices.find((device) => device.part === "STM32H743VITx"));
const cond = (text) => {
  const { parsed, unknown } = parseConditions(text, vocabulary);
  assert.deepEqual(unknown, [], `"${text}" 有认不出的词`);
  return parsed;
};
const check = (text, options = {}) => checkFeasibility(h743, cond(text), {
  vendor: "st", profile: h743Profile, labelOf: conditionLabel, ...options,
});

/* ---------- 真实器件 ---------- */

const combo = check("SD4位 RMII QSPI");
assert.equal(combo.status, "feasible");
const pins = combo.solution.flatMap((group) => group.pins.map((item) => item.number));
assert.equal(new Set(pins).size, pins.length, "方案里不能有脚被用两次");
assert.equal(pins.length, 6 + 9 + 6);
for (const group of combo.solution) assert.ok(group.label, "每组都要能对回是哪个条件");
const debugPins = h743.pins.filter((pin) => pin.protection.includes("debug")).map((pin) => pin.number);
assert.ok(pins.every((number) => !debugPins.includes(number)), "默认保留调试脚");

assert.equal(check("SDRAM").status, "infeasible", "LQFP100 没有 SDRAM 信号");
assert.equal(check("RGB565").status, "feasible");
assert.equal(check("RMII").status, "feasible");
assert.equal(check("RGB565 RMII").status, "infeasible", "PB11 只能给 LCD_G5 或 ETH_TX_EN 其一");

assert.equal(check("SDMMC2").status, "infeasible", "SDMMC2 的 D2/D3 只在 JTAG 脚上");
assert.equal(check("SDMMC2", { protectDebug: false }).status, "feasible", "放开调试脚后可行");

/* 叠加当前工程的需求：RGB565 单独可行，加上工程里已有的 RMII 就不行了 */
const withProject = check("RGB565", { extraRequests: [{ type: "ETH", variant: "rmii" }] });
assert.equal(withProject.status, "infeasible");
assert.ok(withProject.requests.some((item) => item.label.startsWith("工程：")));

/* 默认接法要写明 */
const spi = check("SPI≥2");
assert.equal(spi.status, "feasible");
assert.ok(spi.requests.every((item) => item.note === "全双工 3 线"));

/* 求解器没有对应类型的条件：不参与，但要列出来 */
const partial = check("SD4位 CRC");
assert.equal(partial.status, "feasible");
assert.deepEqual(partial.unchecked.length, 1);
assert.match(partial.unchecked[0], /^CRC/);
assert.equal(check("CRC").status, "skipped");

/* 分组落到这颗片子实际有的类型上：H743 的 CAN 是 FDCAN */
const can = planRequests(cond("CAN总线×2"), { vendor: "st", profile: h743Profile });
assert.equal(can.templates.length, 2);
assert.equal(can.templates[0].request.type, "FDCAN");
assert.equal(check("CAN总线×2").status, "feasible");

/* 任意一个模式没有"一起分配"的问题 */
assert.equal(check("SD4位 RMII", { mode: "any" }).status, "skipped");

/* 用途检查不覆盖 TI：不能因此判无解 */
const ti = checkFeasibility(h743, cond("SD4位"), { vendor: "ti", profile: h743Profile, labelOf: conditionLabel });
assert.equal(ti.status, "skipped");
assert.match(ti.unchecked[0], /未覆盖/);

/* ---------- 合成器件：宽总线的便宜组合全都撞车 ---------- */
/*
  8 根总线信号 BUS_S0..S7，每根有两个候选脚：便宜的 Ai（功能少）和贵的 Bi。
  另一路外设 OTHER 的 8 根信号只能落在 Ai 上。预先按代价枚举总线组合时，
  2^8 = 256 种里最便宜的 80 种都会占用某个 Ai，与 OTHER 必然冲突——唯一可行的
  "全走 Bi"排在最后，从未进入搜索。搜索时现挑则能直接找到它。
*/
const synthetic = {
  id: "synthetic-bus",
  partNumber: "SYNTH32",
  package: "LQFP32",
  pinCount: 32,
  packageGeometry: { shape: "LQFP", pinsPerSide: 8 },
  pins: Array.from({ length: 32 }, (_, index) => {
    const number = index + 1;
    const lane = index % 16;
    const cheap = index < 16;
    const functions = [];
    if (lane < 8) {
      functions.push({ name: `LTDC_R${lane}`, af: 14 });
      if (cheap) functions.push({ name: `FMC_D${lane}`, af: 12 });
      else functions.push(...Array.from({ length: 6 }, (_, k) => ({ name: `X${k}_PAD${lane}`, af: k })));
    }
    return { number, name: `P${number}`, kind: "gpio", functions, additionalFunctions: [], protection: [] };
  }),
};
const lanes = Array.from({ length: 8 }, (_, lane) => `R${lane}`);
const bus = { id: "bus", type: "LTDC", instancePattern: "LTDC", signals: lanes };
const other = { id: "other", type: "FMC", instancePattern: "FMC", signals: Array.from({ length: 8 }, (_, lane) => `D${lane}`) };
const result = allocatePins(synthetic, [other, bus], { maxSolutions: 1 });
assert.equal(result.solutions.length, 1, "搜索时现挑应该找到全走 B 脚的那一种");
const busPins = result.solutions[0].groups.find((group) => group.requestId === "bus").assignments.map((item) => item.pin.number);
assert.ok(busPins.every((number) => number > 16));

/* 真冲突时仍能证明无解：OTHER 再要一根只在 B0 上的信号 */
synthetic.pins[16].functions.push({ name: "FMC_NE1", af: 12 });
const blocked = allocatePins(synthetic, [{ ...other, signals: [...other.signals, "NE1"] }, bus], { maxSolutions: 1 });
assert.equal(blocked.solutions.length, 0);
assert.equal(blocked.proven, true, "无冲突组合不存在时，现挑为空且未封顶，可以证明无解");

console.log(`feasibility: ok（H743 SD4+RMII+QSPI ${pins.length} 脚，RGB565+RMII / SDRAM 证明无解）`);
