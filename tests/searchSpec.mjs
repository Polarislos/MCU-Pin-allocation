/*
  按需求清单逐条核对器件搜索（数据全部来自仓库里提交的 deviceIndex.json，
  事实对照本机 CubeMX 库 DB.6.0.111 的 db/mcu/*.xml）：

    叠加筛选        厂商 / 封装形态 / 脚数范围，与型号文本、外设条件同时生效
    三态            确定有 / 确定没有 / 数据未知，未知单独成一个视图
    USB 细分        HS 控制器、片上 HS PHY、OTG、主机模式分别判断
    内部功能        CORDIC、FMAC、HASH 没有脚也能检索
    认不出的名称    给候选
    旧索引          没有外设摘要时型号搜索照常、外设条件全部"未收录"
    选中流程        结果条目带着 fetchRuntimeMcu 需要的字段，型号里的 x 原样保留
*/
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  describeHit, indexSchema, packageShape, packageShapes, parseConditions, peripheralVocabulary, profileOf,
  searchDevices, similarConditions,
} from "../src/lib/deviceSearch.js";
import { capabilityById, matchCapability } from "../src/lib/capabilities.js";

const index = JSON.parse(await readFile(new URL("../src/data/deviceIndex.json", import.meta.url), "utf8"));
const vocabulary = peripheralVocabulary(index);
const all = (options) => searchDevices(index, { pageSize: 1e6, ...options });
const parts = (options) => new Set(all(options).items.map((item) => item.device.part));
const cond = (text) => {
  const { parsed, unknown } = parseConditions(text, vocabulary);
  assert.deepEqual(unknown, [], `"${text}" 有认不出的词`);
  return parsed;
};
const device = (part) => {
  const found = index.devices.find((item) => item.part === part);
  assert.ok(found, `索引里没有 ${part}`);
  return found;
};
const capability = (id, part) => {
  const target = device(part);
  const hits = matchCapability(capabilityById(id), target.vendor, profileOf(index, target));
  return hits === null ? "unknown" : hits.length > 0 ? "yes" : "no";
};

/* ---------- 来源与版本 ---------- */

assert.equal(indexSchema(index).peripherals, true);
assert.ok(index.peripherals.version >= 2);
assert.ok(index.peripherals.generatedAt, "外设摘要要有精确的生成时间");
for (const source of index.sources) {
  assert.ok(source.tool && source.root && source.count > 0, `数据来源 ${source.vendor} 缺字段`);
}
assert.ok(Array.isArray(index.gaps), "缺失的数据源要显式记录（为空也要有这个字段）");

/* ---------- 型号搜索回归 ---------- */

const f407 = all({ text: "F407 LQFP100" });
assert.ok(f407.total > 0);
for (const item of f407.items) {
  assert.match(`${item.device.part} ${item.device.series}`, /F407/);
  assert.equal(item.device.package, "LQFP100");
}
assert.equal(all({ text: "MSPM0G3507" }).items.every((item) => item.device.vendor === "ti"), true, "TI 型号搜索照常");
assert.ok(all({ text: "MSPM0G3507" }).total >= 2, "同一型号的多种封装都要列出");

/* ---------- 叠加筛选 ---------- */

const stOnly = all({ conditions: cond("SDMMC"), filters: { vendor: "st" } });
assert.ok(stOnly.total > 0 && stOnly.items.every((item) => item.device.vendor === "st"));
const ranged = all({ conditions: cond("FDCAN"), filters: { pinMin: 64, pinMax: 100 } });
assert.ok(ranged.total > 0);
assert.ok(ranged.items.every((item) => item.device.pinCount >= 64 && item.device.pinCount <= 100));
const lqfp = all({ text: "H743", filters: { shape: "LQFP" } });
assert.ok(lqfp.items.length > 0 && lqfp.items.every((item) => packageShape(item.device) === "LQFP"));
assert.ok(!all({ text: "H743", filters: { shape: "LQFP" } }).items.some((item) => /BGA/.test(item.device.package)));
assert.equal(packageShape({ package: "LQFP-64(PM)" }), "LQFP", "TI 的封装名也能取出形态");
assert.ok(packageShapes(index).some((item) => item.shape === "LQFP" && item.count > 100));
/* 只有筛选、没有文本和条件也是一次有效搜索 */
assert.ok(all({ filters: { vendor: "ti", pinMax: 24 } }).total > 0);
/* 脚数未知的条目在设了范围时不算匹配 */
assert.ok(all({ filters: { vendor: "ti", pinMin: 1 } }).items.every((item) => item.device.pinCount > 0));

/* ---------- 实例数量展示 ---------- */

const two = searchDevices(index, { text: "STM32H743VITx", conditions: cond("SDMMC") });
assert.equal(describeHit(two.items[0].hits[0]), "SDMMC ×2：SDMMC1(14) SDMMC2(10)");

/* ---------- 内部功能：没有脚也能检索 ---------- */

const math = parts({ conditions: cond("CORDIC FMAC") });
assert.ok(math.has("STM32G474RETx") && math.has("STM32H563ZITx"));
assert.ok(!math.has("STM32F407VGTx"), "F4 没有 CORDIC/FMAC");
const cordicHit = searchDevices(index, { text: "STM32G474RETx", conditions: cond("CORDIC") }).items[0].hits[0];
assert.equal(cordicHit.instances[0].signals.length, 0, "CORDIC 没有外部引脚，信号数为 0");
assert.ok(parts({ conditions: cond("HASH") }).has("STM32H753ZITx"));
assert.ok(!parts({ conditions: cond("HASH") }).has("STM32H743ZITx"), "H743 没有 HASH，H753 才有");

/* ---------- USB 细分：四件事分开判断 ---------- */

/* HS 控制器 */
assert.equal(capability("usb-hs", "STM32H743ZITx"), "yes");
assert.equal(capability("usb-hs", "STM32G474RETx"), "no");
/* 片上 HS PHY：F723 有、F722 没痕迹（未知，不说没有）、U5A9 有、没有 HS 控制器的确定没有 */
assert.equal(capability("usb-hs-phy", "STM32F723ZETx"), "yes");
assert.equal(capability("usb-hs-phy", "STM32F722ZETx"), "unknown");
assert.equal(capability("usb-hs-phy", "STM32U5A9ZJTxQ"), "yes");
assert.equal(capability("usb-hs-phy", "STM32H743ZITx"), "unknown");
assert.equal(capability("usb-hs-phy", "STM32G474RETx"), "no");
/* 主机模式：OTG / DRD 可以；usb1 版本的 USB 仅设备；H5 的 usbfs 数据里看不出来 */
assert.equal(capability("usb-host", "STM32H743ZITx"), "yes");
assert.equal(capability("usb-host", "STM32G0B1RETx"), "yes");
assert.equal(capability("usb-host", "STM32G474RETx"), "no");
assert.equal(capability("usb-host", "STM32F103C8Tx"), "no");
assert.equal(capability("usb-host", "STM32H563ZITx"), "unknown");
/* OTG 与 DRD 不等价 */
assert.equal(capability("usb-otg", "STM32G0B1RETx"), "no");
/* DRD 的脚在库里没有实例前缀，也要归到 USB_DRD_FS 上 */
const drd = profileOf(index, device("STM32G0B1RETx")).find((item) => item.name === "USB_DRD_FS");
assert.deepEqual([...drd.signals].sort(), ["DM", "DP", "NOE"]);

/* ---------- 三态：数据未知单独成视图 ---------- */

const phy = searchDevices(index, { text: "STM32F72", conditions: cond("内置PHY") });
const phyUnknown = searchDevices(index, { text: "STM32F72", conditions: cond("内置PHY"), view: "unknown", pageSize: 1e6 });
assert.ok(phy.total > 0 && phy.items.every((item) => /^STM32F723/.test(item.device.part)), "只有 F723 有可核实的 PHY 痕迹");
assert.equal(phy.uncovered, phyUnknown.total);
assert.ok(phyUnknown.items.some((item) => /^STM32F722/.test(item.device.part)));
assert.ok(phyUnknown.items.every((item) => item.unknown.some((condition) => condition.value === "usb-hs-phy")));
/* 能判断的条件不满足时就是不满足，不进"未知" */
const noHs = searchDevices(index, { text: "STM32G474", conditions: cond("内置PHY"), view: "unknown" });
assert.equal(noHs.total, 0, "G474 没有 HS 控制器：确定没有，不是未知");

/* ---------- 名称 ---------- */

assert.equal(cond("Chrom-ART")[0].value, "dma2d", "Chrom-ART 是 DMA2D 的官方名称");
assert.equal(cond("NeoChrom")[0].value, "gpu2d");
assert.equal(cond("USB主机")[0].value, "usb-host");
const typo = similarConditions("SDMCC", vocabulary).map((item) => item.value);
assert.ok(typo.includes("SDMMC") || typo.includes("sdmmc"), "拼错的外设名要给候选");
assert.ok(similarConditions("FSCM", vocabulary).some((item) => /fsmc/i.test(item.value)));
assert.equal(similarConditions("完全不相干的词", vocabulary).length, 0, "离得太远不硬凑候选");
assert.equal(parseConditions("SDMCC", vocabulary).unknown[0], "SDMCC", "拼错的词不能被悄悄当成别的");

/* ---------- 选中流程 ---------- */
/* 结果条目原样交给 onPick → fetchRuntimeMcu，那边要 id / vendor / part / package */
const picked = searchDevices(index, { text: "STM32H743VITx" }).items[0].device;
for (const key of ["id", "vendor", "part", "package"]) assert.ok(picked[key], `结果条目缺 ${key}`);
assert.equal(picked.id, "st-stm32h743vitx-lqfp100", "id 规则必须与导入器一致");
assert.equal(picked.part, "STM32H743VITx", "保留 x 占位符，不补成具体订货型号");
assert.ok(!index.devices.some((item) => item.part === "STM32H743VIT6"), "索引里不应出现自行推断出的完整订货型号");

/* ---------- 旧索引兼容 ---------- */

const legacy = { generatedAt: index.generatedAt, sources: index.sources, devices: index.devices.map(({ pf, ...rest }) => rest) };
assert.deepEqual(indexSchema(legacy), { version: 1, peripherals: false, specifications: 0 });
const legacyVocabulary = peripheralVocabulary(legacy);
assert.equal(legacyVocabulary.types.size, 0);
assert.equal(searchDevices(legacy, { text: "F407 LQFP100" }).total, f407.total, "旧索引型号搜索结果不变");
const legacyFiltered = searchDevices(legacy, { conditions: cond("SDMMC") });
assert.equal(legacyFiltered.total, 0);
assert.equal(legacyFiltered.unrecorded, legacy.devices.length, "旧索引下外设条件全部是未收录，不是'没有'");

/* ---------- 空结果 ---------- */

const none = searchDevices(index, { text: "STM32F103C8", conditions: cond("SDMMC") });
assert.equal(none.total, 0);
assert.equal(none.unrecorded, 0);
assert.equal(none.uncovered, 0, "F103C8 没有 SDMMC 是确定的结论");

console.log(`search spec: ok（F407 LQFP100 ${f407.total} 项，CORDIC+FMAC ${math.size}，F72x 内置 PHY 确定 ${phy.total} / 未知 ${phyUnknown.total}）`);
