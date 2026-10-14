/*
  按外设搜器件。

  用仓库里提交的 src/data/deviceIndex.json，不依赖本机装 CubeMX。下面引用的
  事实都对照过 CubeMX db/mcu/<RefName>.xml 的 <IP> 记录：
    STM32H743VITx  SDMMC1 SDMMC2 FMC DCMI
    STM32F407VGTx  SDIO FSMC DCMI（老命名，没有 SDMMC/FMC）
    STM32F103C8Tx  以上都没有
  重新生成索引后这些仍应成立；不成立说明提取逻辑或厂商库变了，要先查清楚。
*/
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PAGE_SIZE, describeHit, hasPeripheralData, hasPlaceholder, parseCondition, parseConditions,
  peripheralVocabulary, profileOf, searchDevices, suggestConditions,
} from "../src/lib/deviceSearch.js";

const index = JSON.parse(await readFile(new URL("../src/data/deviceIndex.json", import.meta.url), "utf8"));
const vocabulary = peripheralVocabulary(index);
const byPart = (part) => index.devices.find((device) => device.part === part);
const parts = (result) => new Set(result.items.map((item) => item.device.part));
const allParts = (options) => {
  const first = searchDevices(index, { ...options, pageSize: 100000 });
  return new Set(first.items.map((item) => item.device.part));
};
const cond = (text) => {
  const { parsed, unknown } = parseConditions(text, vocabulary);
  assert.deepEqual(unknown, [], `"${text}" 有认不出的词`);
  return parsed;
};

/* ---------- 索引本身 ---------- */

assert.ok(index.generatedAt, "索引要写明生成时间");
assert.ok(index.sources.length > 0, "索引要写明数据来源");
assert.deepEqual(index.peripherals.vendors, ["st", "ti"]);
for (const type of ["SDMMC", "SDIO", "FMC", "FSMC", "DCMI", "TIM", "USART"]) {
  assert.ok(vocabulary.types.has(type), `外设类型里缺 ${type}`);
}
for (const middleware of ["FREERTOS", "FATFS", "LWIP", "RCC", "GPIO", "NVIC", "ThreadX"]) {
  assert.ok(!vocabulary.types.has(middleware), `${middleware} 是中间件/系统模块，不该算外设`);
}

const h743 = profileOf(index, byPart("STM32H743VITx"));
const sdmmc1 = h743.find((item) => item.name === "SDMMC1");
assert.equal(sdmmc1.type, "SDMMC");
for (const signal of ["CK", "CMD", "D0", "D1", "D2", "D3"]) assert.ok(sdmmc1.signals.includes(signal), `SDMMC1 缺 ${signal}`);
const fmc = h743.find((item) => item.name === "FMC");
for (const signal of ["SDCKE0", "SDNE0", "SDNWE"]) assert.ok(fmc.signals.includes(signal), `H743 LQFP100 的 FMC 缺 ${signal}`);
assert.equal(h743.find((item) => item.name === "TIM1").type, "TIM", "定时器按 TIM 归类，而不是 IP 版本名");
assert.ok(h743.find((item) => item.name === "HDMI_CEC").signals.includes("CEC"), "CEC 脚不带实例前缀，也要归到 HDMI_CEC");
assert.ok(h743.find((item) => item.name === "USB_OTG_HS").signals.includes("ULPI_D0"), "信号按最长实例前缀归属");

/* 外设数据缺失的条目是"未收录"，不是"没有"（TI 的细节见 tests/tiPeripherals.mjs） */
const unrecordedIndex = {
  ...index,
  devices: [...index.devices, { id: "x-test", vendor: "ti", part: "UNRECORDED1", package: "QFN-8(X)", pinCount: 8, series: "X", family: "X" }],
};
const unrecordedDevice = unrecordedIndex.devices.at(-1);
assert.equal(hasPeripheralData(unrecordedDevice), false);
assert.equal(profileOf(unrecordedIndex, unrecordedDevice), null);

/* ---------- 解析 ---------- */

assert.deepEqual(parseCondition("sdmmc", vocabulary), { kind: "type", value: "SDMMC", min: 1 }, "忽略大小写");
assert.deepEqual(parseCondition("SDMMC1", vocabulary), { kind: "instance", value: "SDMMC1" });
assert.deepEqual(parseCondition("SPDIFRX1", vocabulary), { kind: "instance", value: "SPDIFRX1" }, "以 X 结尾的外设名不能被当成数量");
assert.deepEqual(parseCondition("SDMMC>=2", vocabulary), { kind: "type", value: "SDMMC", min: 2 });
assert.deepEqual(parseCondition("sdmmc≥2", vocabulary), { kind: "type", value: "SDMMC", min: 2 });
assert.deepEqual(cond("SDMMC 数量 ≥ 2"), [{ kind: "type", value: "SDMMC", min: 2 }]);
assert.deepEqual(cond("SDMMC FMC").map((item) => item.value), ["SDMMC", "FMC"]);
assert.deepEqual(parseCondition("SD卡", vocabulary), { kind: "group", value: "sd-card", min: 1 }, "中文用途");
assert.equal(parseCondition("FMC", vocabulary).kind, "type", "FMC 是严格条件，不展开成外部存储器分组");
assert.equal(parseCondition("不存在的外设", vocabulary), null);

const suggestions = suggestConditions("sd", vocabulary).map((item) => item.condition.value);
assert.ok(suggestions.includes("sd-card") && suggestions.includes("sdmmc") && suggestions.includes("sdio"), "同名的类型由能力条目代表");
assert.ok(suggestConditions("摄像头", vocabulary).some((item) => item.condition.value === "camera"), "中文提示");
assert.ok(suggestConditions("sdmmc2", vocabulary).some((item) => item.condition.value === "SDMMC2"), "带数字时提示实例");

/* ---------- 筛选 ---------- */

const sdmmc = allParts({ conditions: cond("SDMMC") });
assert.ok(sdmmc.has("STM32H743VITx"));
assert.ok(!sdmmc.has("STM32F407VGTx"), "严格 SDMMC 不匹配只有 SDIO 的 F407");
assert.ok(!sdmmc.has("STM32F103C8Tx"));

const sdCard = allParts({ conditions: cond("SD卡") });
assert.ok(sdCard.has("STM32H743VITx") && sdCard.has("STM32F407VGTx"), "用途条件同时覆盖 SDMMC 和 SDIO");
assert.ok(!sdCard.has("STM32F103C8Tx"));

const strictFmc = allParts({ conditions: cond("FMC") });
assert.ok(strictFmc.has("STM32H743VITx") && !strictFmc.has("STM32F407VGTx"), "FMC 不匹配 FSMC");
assert.ok(allParts({ conditions: cond("外部存储") }).has("STM32F407VGTx"));

/* 多条件交集 ⊆ 各自集合 */
const both = allParts({ conditions: cond("SDMMC FMC") });
assert.ok(both.has("STM32H743VITx"));
for (const part of both) assert.ok(sdmmc.has(part) && strictFmc.has(part));
const either = allParts({ conditions: cond("SDMMC FMC"), mode: "any" });
assert.equal(either.size, new Set([...sdmmc, ...strictFmc]).size, "任意一个 = 并集");

/* 实例与数量 */
const two = allParts({ conditions: cond("SDMMC>=2") });
assert.ok(two.has("STM32H743VITx") && two.size < sdmmc.size);
for (const part of two) {
  assert.ok(profileOf(index, byPart(part)).filter((item) => item.type === "SDMMC").length >= 2);
}
const instance2 = allParts({ conditions: cond("SDMMC2") });
assert.ok(instance2.has("STM32H743VITx"));
for (const part of instance2) assert.ok(sdmmc.has(part));

/* 与型号/封装文本叠加 */
const narrowed = searchDevices(index, { text: "H743 LQFP100", conditions: cond("SDMMC FMC") });
assert.ok(narrowed.total > 0);
for (const item of narrowed.items) {
  assert.match(`${item.device.part} ${item.device.series}`, /H743/);
  assert.equal(item.device.package, "LQFP100");
}
const hit = narrowed.items.find((item) => item.device.part === "STM32H743VITx").hits[0];
assert.match(describeHit(hit), /SDMMC1\(\d+\) SDMMC2\(\d+\)/);

/* 有文本命中但外设未收录：不进结果，单独计数 */
const unrecordedSearch = searchDevices(unrecordedIndex, { text: "UNRECORDED", conditions: cond("SPI") });
assert.equal(unrecordedSearch.total, 0);
assert.equal(unrecordedSearch.unrecorded, 1);
assert.equal(searchDevices(unrecordedIndex, { text: "UNRECORDED" }).total, 1, "没有外设条件时照常可搜");

/* 分页：总数准确，页之间不重叠 */
const page0 = searchDevices(index, { conditions: cond("USART") });
assert.ok(page0.total > PAGE_SIZE, "USART 应该多到要分页");
assert.equal(page0.items.length, PAGE_SIZE);
assert.equal(page0.pageCount, Math.ceil(page0.total / PAGE_SIZE));
const page1 = searchDevices(index, { conditions: cond("USART"), page: 1 });
assert.equal(page1.page, 1);
assert.ok(page1.items.every((item) => !parts(page0).has(item.device.part)));
const last = searchDevices(index, { conditions: cond("USART"), page: 9999 });
assert.equal(last.page, page0.pageCount - 1, "越界页码收到最后一页");

assert.equal(searchDevices(index, {}).total, 0, "什么都没输入时不列全部");
assert.ok(hasPlaceholder("STM32H743VITx") && !hasPlaceholder("STM32H743VIT6"));

console.log(`device search: ok（SDMMC ${sdmmc.size}，SD 卡 ${sdCard.size}，SDMMC+FMC ${both.size}，SDMMC≥2 ${two.size}）`);
