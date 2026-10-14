/*
  用途筛选（第 2 层：封装信号满足）。

  事实来源同 tests/deviceSearch.mjs：仓库里的 deviceIndex.json，对照过 CubeMX
  db/mcu/<RefName>.xml 的 <Signal> 记录：
    STM32H743VITx LQFP100  FMC 只引出 A16–A23、D0–D15、SDCKE0/SDNE0/SDNWE，
                           没有 SDCLK、SDNRAS、SDNCAS、BA0/1、A0–A15 → 不能接 SDRAM
    STM32H743ZITx LQFP144  FMC 有完整 16 位 SDRAM 信号，但没有 D16–D31
    STM32F407VGTx LQFP100  SDIO 8 位、FSMC（没有 SDRAM 信号，FSMC 本来就不支持）
    STM32F407ZGTx LQFP144  FSMC 地址线 A0–A25
*/
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  conditionLabel, describeHit, evaluateCondition, parseConditions, peripheralVocabulary, profileOf,
  searchDevices, suggestConditions,
} from "../src/lib/deviceSearch.js";
import { USAGES, checkUsage, compactSignals, normalizeParams, usageById } from "../src/lib/peripheralUsage.js";

const index = JSON.parse(await readFile(new URL("../src/data/deviceIndex.json", import.meta.url), "utf8"));
const vocabulary = peripheralVocabulary(index);
const device = (part) => {
  const found = index.devices.find((item) => item.part === part);
  assert.ok(found, `索引里没有 ${part}`);
  return found;
};
const one = (text) => {
  const { parsed, unknown } = parseConditions(text, vocabulary);
  assert.deepEqual(unknown, [], `"${text}" 有认不出的词`);
  assert.equal(parsed.length, 1, `"${text}" 应解析成一个条件`);
  return parsed[0];
};
const usage = (id, params = {}, min = 1) => ({ kind: "usage", value: id, params: normalizeParams(usageById(id), params), min });
const verdict = (part, condition) => {
  const result = evaluateCondition(profileOf(index, device(part)), condition);
  return result.hits ? "ok" : result.partial.length ? "incomplete" : "absent";
};
const all = (options) => new Set(searchDevices(index, { ...options, pageSize: 1e6 }).items.map((item) => item.device.part));

/* ---------- 定义自检：每个用途在真实库里至少有一颗片子满足 ---------- */
/* 信号名凭印象写错时整个用途会永远不匹配，这条能挡住。 */
for (const item of USAGES) {
  assert.ok(searchDevices(index, { conditions: [usage(item.id)] }).total > 0, `${item.label} 默认参数一颗都没有`);
  for (const param of item.params) {
    if (param.key === "addr") continue; /* 地址档太多，下面单独测 */
    for (const value of param.values) {
      const condition = usage(item.id, { [param.key]: value });
      const count = searchDevices(index, { conditions: [condition] }).total;
      assert.ok(count > 0, `${conditionLabel(condition)} 在整个库里一颗都没有，信号名可能写错了`);
    }
  }
}

/* ---------- 解析 ---------- */

assert.deepEqual(one("SD 4位").params, { bits: 4 });
assert.deepEqual(one("sd8").params, { bits: 8 });
assert.deepEqual(one("eMMC").params, { bits: 8 }, "eMMC 默认 8 位");
assert.equal(one("SD卡").kind, "group", "不带位宽的 SD 卡仍是第一阶段的存在条件");
assert.deepEqual(one("SDRAM").params, { data: 16, rows: 12 });
assert.deepEqual(one("SDRAM 32位").params, { data: 32, rows: 12 });
assert.equal(one("NAND").value, "fmc-nand");
assert.equal(one("psram").value, "fmc-sram");
assert.equal(one("8080").value, "fmc-lcd");
assert.equal(one("RMII").params.phy, "RMII");
assert.equal(one("RGB888").params.format, "RGB888");
assert.equal(one("QSPI").value, "qspi");
assert.equal(one("SD4位×2").min, 2, "用途也能要求多个实例");
assert.equal(one("FMC").kind, "type", "FMC 仍是严格的存在条件");
assert.deepEqual(normalizeParams(usageById("sd"), { bits: 3 }), { bits: 4 }, "定义外的参数退回默认");

assert.ok(suggestConditions("sdram", vocabulary).some((item) => item.condition.kind === "usage" && item.condition.value === "fmc-sdram"));
assert.ok(suggestConditions("SDMMC", vocabulary).some((item) => item.condition.value === "sd"), "输入外设名也提示它的用途");
assert.ok(suggestConditions("以太网", vocabulary).some((item) => item.condition.value === "eth"));

/* ---------- 判断：对照厂商数据 ---------- */

const sdram16 = usage("fmc-sdram");
assert.equal(verdict("STM32H743VITx", sdram16), "incomplete", "LQFP100 有 FMC 但没引出 SDRAM 信号");
assert.equal(verdict("STM32H743ZITx", sdram16), "ok");
assert.equal(verdict("STM32H743ZITx", usage("fmc-sdram", { data: 32 })), "incomplete", "LQFP144 没有 D16–D31");
assert.equal(verdict("STM32F407VGTx", sdram16), "absent", "FSMC 不支持 SDRAM，不能算作'缺信号'");
assert.equal(verdict("STM32F103C8Tx", sdram16), "absent");

const h743Fmc = profileOf(index, device("STM32H743VITx")).find((item) => item.name === "FMC");
const missing = checkUsage(usageById("fmc-sdram"), { data: 16, rows: 12 }, h743Fmc).missing;
for (const signal of ["SDCLK", "SDNRAS", "SDNCAS", "BA0", "BA1", "A0", "A11"]) assert.ok(missing.includes(signal), `应报告缺 ${signal}`);
assert.ok(!missing.includes("D0") && !missing.includes("SDNWE"), "已引出的信号不能报缺");
assert.equal(compactSignals(["A0", "A1", "A2", "SDCLK", "BA0", "BA1"]), "A0–A2、SDCLK、BA0–BA1");

/* SDRAM bank：时钟使能与片选必须配对 */
const fakeFmc = (signals) => ({ name: "FMC", type: "FMC", signals });
const sdramBase = ["SDCLK", "SDNRAS", "SDNCAS", "SDNWE", "BA0", "BA1",
  ...Array.from({ length: 12 }, (_, i) => `A${i}`), ...Array.from({ length: 16 }, (_, i) => `D${i}`), "NBL0", "NBL1"];
assert.equal(checkUsage(usageById("fmc-sdram"), {}, fakeFmc([...sdramBase, "SDCKE1", "SDNE1"])).ok, true);
assert.equal(checkUsage(usageById("fmc-sdram"), {}, fakeFmc([...sdramBase, "SDCKE0", "SDNE1"])).ok, false, "SDCKE0 + SDNE1 不是同一个 bank");

/* SD：按实例判断，不能跨实例凑 */
assert.equal(verdict("STM32F407VGTx", usage("sd", { bits: 8 })), "ok");
const split = [
  { name: "SDMMC1", type: "SDMMC", signals: ["D0", "D1", "D2", "D3"] },
  { name: "SDMMC2", type: "SDMMC", signals: ["CK", "CMD", "D0"] },
];
const splitResult = evaluateCondition(split, usage("sd", { bits: 4 }));
assert.equal(splitResult.hits, null, "SDMMC1 的数据线 + SDMMC2 的时钟不算一个 4 位 SD");
assert.deepEqual(splitResult.partial.map((item) => item.name), ["SDMMC1", "SDMMC2"]);
assert.ok(evaluateCondition(split, usage("sd", { bits: 1 })).hits.some((item) => item.name === "SDMMC2"));

/* SRAM 地址线 */
assert.equal(verdict("STM32F407ZGTx", usage("fmc-sram", { addr: 26 })), "ok", "LQFP144 FSMC 有 A0–A25");
assert.equal(verdict("STM32F407VGTx", usage("fmc-sram", { addr: 19 })), "incomplete", "LQFP100 FSMC 地址线不够 A0–A18");
assert.equal(verdict("STM32F407VGTx", usage("fmc-lcd", { data: 16 })), "ok", "LQFP100 FSMC 足够接 16 位 8080 屏");

/* 以太网新旧命名都认 */
assert.equal(verdict("STM32F407VGTx", usage("eth", { phy: "RMII" })), "ok");
assert.equal(verdict("STM32H743VITx", usage("eth", { phy: "MII" })), "ok");

/* ---------- 搜索 ---------- */

const sdramParts = all({ conditions: [sdram16] });
const fmcParts = all({ conditions: parseConditions("FMC", vocabulary).parsed });
for (const part of sdramParts) assert.ok(fmcParts.has(part), "能接 SDRAM 的一定有 FMC");
assert.ok(sdramParts.size < fmcParts.size, "有 FMC 不等于能接 SDRAM");

const incomplete = searchDevices(index, { conditions: [sdram16], incomplete: true, pageSize: 1e6 });
const incompleteParts = new Set(incomplete.items.map((item) => item.device.part));
assert.equal(incomplete.incompleteCount, incomplete.total);
assert.equal(sdramParts.size + incompleteParts.size, fmcParts.size, "SDRAM 满足 + 缺信号 = 有 FMC");
assert.ok(incompleteParts.has("STM32H743VITx"));
const line = describeHit(incomplete.items.find((item) => item.device.part === "STM32H743VITx").hits[0]);
assert.match(line, /^FMC 缺 .*SDCLK/);

/* 与存在条件、文本叠加 */
const combo = all({ text: "H743", conditions: [usage("sd", { bits: 4 }), sdram16] });
assert.ok(combo.has("STM32H743ZITx") && !combo.has("STM32H743VITx"));
const okLine = describeHit(searchDevices(index, { text: "STM32H743ZITx", conditions: [sdram16] }).items[0].hits[0]);
assert.match(okLine, /^FMC ✓\d+ 信号$/);

/* 组合时，缺信号的列表里只列至少有对应外设的片子 */
const comboIncomplete = searchDevices(index, { text: "F103", conditions: [sdram16], incomplete: true });
assert.equal(comboIncomplete.total, 0, "F103 没有 FMC，不该出现在'信号不全'里");

console.log(`usage search: ok（SDRAM16 ${sdramParts.size} / FMC ${fmcParts.size}，缺信号 ${incompleteParts.size}）`);
