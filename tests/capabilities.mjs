/*
  能力目录：映射必须来自真实数据，缺数据的能力必须标"未收录"。

  对照的事实（本机 CubeMX 库 + SysConfig 1.28）：
    STM32H743VITx  USB_OTG_FS + USB_OTG_HS、LTDC、JPEG、HRTIM、DFSDM，无 SAES/PKA
    STM32F103C8Tx  只有 FS 设备控制器 USB，不是 OTG
    STM32U535CBTx  同时有 ADF1 与 MDF1（CubeMX 把 ADF1 的 IP 名也记成 MDF）
    MSPM0G5187     TI 的 NPU；MSPM0G3507 的 CAN-FD 是 MCAN
    本机 CubeMX 库没有 STM32N6 → MIPI CSI-2 / ISP / H.264 / Neural-ART 在 ST 侧未收录
*/
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseConditions, peripheralVocabulary, profileOf, searchDevices } from "../src/lib/deviceSearch.js";
import {
  CAPABILITIES, CAPABILITY_CATEGORIES, capabilityById, capabilityCoverage, matchCapability,
} from "../src/lib/capabilities.js";
import { planRequests } from "../src/lib/feasibility.js";

const index = JSON.parse(await readFile(new URL("../src/data/deviceIndex.json", import.meta.url), "utf8"));
const vocabulary = peripheralVocabulary(index);
const device = (part, pkg) => {
  const found = index.devices.find((item) => item.part === part && (!pkg || item.package === pkg));
  assert.ok(found, `索引里没有 ${part}`);
  return found;
};
const has = (id, part, pkg) => {
  const target = device(part, pkg);
  const hits = matchCapability(capabilityById(id), target.vendor, profileOf(index, target));
  return hits === null ? "unrecorded" : hits.length > 0;
};

/* ---------- 清单完整 ---------- */

const REQUIRED = {
  memory: ["FMC", "FSMC", "SDMMC", "SDIO", "QUADSPI", "OCTOSPI", "HSPI", "XSPI"],
  graphics: ["LTDC", "DSI Host", "DMA2D", "GPU2D", "DCMI", "DCMIPP", "MIPI CSI-2", "ISP", "JPEG", "H.264 编码器", "PSSI"],
  comms: ["ETH", "CAN", "FDCAN", "USB FS", "USB HS", "USB OTG", "UCPD", "I2S", "SAI", "SPDIFRX", "DFSDM", "MDF", "ADF"],
  control: ["HRTIM", "OPAMP", "COMP", "DAC", "CORDIC", "FMAC"],
  security: ["AES / CRYP", "SAES", "HASH", "PKA", "RNG", "NPU / Neural-ART"],
};
for (const [category, labels] of Object.entries(REQUIRED)) {
  assert.ok(CAPABILITY_CATEGORIES.some((item) => item.id === category));
  for (const label of labels) {
    const found = CAPABILITIES.find((item) => item.label === label);
    assert.ok(found, `能力目录缺 ${label}`);
    assert.equal(found.category, category, `${label} 分类不对`);
  }
}

/* ---------- 映射名必须真实存在、且确有器件 ---------- */
/* 写错一个 IP 名，这项能力就会对整个厂商永远"没有"——比"未收录"更糟，因为它是假结论。 */
const vendorTypes = { st: new Set(), ti: new Set() };
const vendorInstances = { st: new Set(), ti: new Set() };
for (const item of index.devices) {
  for (const instance of profileOf(index, item) || []) {
    vendorTypes[item.vendor].add(instance.type);
    vendorInstances[item.vendor].add(instance.name);
  }
}
const coverage = capabilityCoverage(index, profileOf);
for (const capability of CAPABILITIES) {
  for (const vendor of ["st", "ti"]) {
    const mapping = capability[vendor];
    if (!mapping) {
      assert.equal(coverage.get(capability.id)[vendor].mapped, false);
      continue;
    }
    for (const type of mapping.types || []) {
      assert.ok(vendorTypes[vendor].has(type), `${capability.label} 的 ${vendor} 映射 ${type} 不在索引里`);
    }
    if (mapping.instances) {
      const pattern = new RegExp(`^(?:${mapping.instances})$`);
      assert.ok([...vendorInstances[vendor]].some((name) => pattern.test(name)), `${capability.label} 的实例模式匹配不到任何实例`);
    }
    assert.ok(coverage.get(capability.id)[vendor].devices > 0, `${capability.label} 映射了 ${vendor} 却没有任何器件`);
  }
}

/* 本机库没有数据的能力：不写映射，说明原因 */
for (const id of ["csi2", "isp", "h264", "npu"]) {
  assert.equal(capabilityById(id).st, undefined, `${id} 在 ST 侧没有可核实的 IP 名，不能映射`);
  assert.ok(capabilityById(id).note, `${id} 要写明为什么未收录`);
}
assert.ok(!index.devices.some((item) => /^STM32N6/.test(item.part)), "本机库若已有 N6，请补上 CSI-2/ISP/H.264/NPU 的 ST 映射");
assert.equal(capabilityById("isp").ti, undefined);
assert.equal(capabilityById("h264").ti, undefined);

/* ---------- 逐器件 ---------- */

assert.equal(has("usb-fs", "STM32H743VITx"), true);
assert.equal(has("usb-hs", "STM32H743VITx"), true);
assert.equal(has("usb-otg", "STM32H743VITx"), true);
assert.equal(has("usb-fs", "STM32F103C8Tx"), true);
assert.equal(has("usb-otg", "STM32F103C8Tx"), false, "F103 的 USB 是设备控制器，不是 OTG");
assert.equal(has("usb-hs", "STM32F103C8Tx"), false);
for (const id of ["ltdc", "jpeg", "hrtim", "dfsdm", "dma2d"]) assert.equal(has(id, "STM32H743VITx"), true, `H743 应有 ${id}`);
for (const id of ["saes", "pka", "gpu2d"]) assert.equal(has(id, "STM32H743VITx"), false, `H743 没有 ${id}`);

const u535 = profileOf(index, device("STM32U535CBTx"));
const adf = matchCapability(capabilityById("adf"), "st", u535).map((item) => item.name);
const mdf = matchCapability(capabilityById("mdf"), "st", u535).map((item) => item.name);
assert.ok(adf.length && adf.every((name) => /^ADF/.test(name)));
assert.ok(mdf.length && mdf.every((name) => /^MDF/.test(name)), "MDF 不能把 ADF 也算进去");

assert.equal(has("npu", "MSPM0G5187", "LQFP-64(PM)"), true);
assert.equal(has("npu", "MSPM0G3507", "LQFP-64(PM)"), false, "有映射的厂商，没有就是没有");
assert.equal(has("npu", "STM32H743VITx"), "unrecorded", "ST 侧 NPU 没映射，是未收录而不是没有");
assert.equal(has("fdcan", "MSPM0G3507", "LQFP-64(PM)"), true);
assert.equal(has("ltdc", "MSPM0G3507", "LQFP-64(PM)"), "unrecorded");

/* ---------- 搜索 ---------- */

const cond = (text) => {
  const { parsed, unknown } = parseConditions(text, vocabulary);
  assert.deepEqual(unknown, [], `"${text}" 有认不出的词`);
  return parsed;
};
assert.equal(cond("MIPI CSI-2".replace(" ", ""))[0].kind, "capability");
assert.equal(cond("Neural-ART")[0].value, "npu");
assert.equal(cond("H.264")[0].value, "h264");
assert.equal(cond("USBHS")[0].value, "usb-hs");
assert.equal(cond("USBHS×2")[0].min, 2);

const npu = searchDevices(index, { conditions: cond("Neural-ART"), pageSize: 1e6 });
assert.ok(npu.items.length > 0 && npu.items.every((item) => item.device.vendor === "ti"));
assert.equal(npu.uncovered, index.devices.filter((item) => item.vendor === "st").length, "全部 ST 器件计入未收录");

const h264 = searchDevices(index, { conditions: cond("H.264") });
assert.equal(h264.total, 0);
assert.equal(h264.uncovered, index.devices.filter((item) => item.pf != null).length, "两家都没映射：全部未收录，零条'不支持'");

/* 能判断的条件不满足时，就是不满足，不算未收录 */
const mixed = searchDevices(index, { text: "STM32F103C8", conditions: cond("LTDC Neural-ART") });
assert.equal(mixed.total, 0);
assert.equal(mixed.uncovered, 0, "F103 没有 LTDC，这已经是结论了");

const otg = searchDevices(index, { conditions: cond("USB OTG".replace(" ", "")), pageSize: 1e6 });
assert.ok(otg.items.some((item) => item.device.part === "STM32H743VITx"));
assert.ok(!otg.items.some((item) => item.device.part === "STM32F103C8Tx"));

/* 可行性：能力条件落到求解器类型上；未映射的列为未参与 */
const h743Profile = profileOf(index, device("STM32H743VITx"));
const plan = planRequests(cond("USBHS FDCAN×2 Neural-ART"), { vendor: "st", profile: h743Profile });
assert.deepEqual(plan.templates.map((item) => item.request.type), ["USB", "FDCAN", "FDCAN"]);
assert.equal(plan.unchecked.length, 1);
assert.match(plan.unchecked[0], /未收录/);

console.log(`capabilities: ok（${CAPABILITIES.length} 项，ST 映射 ${CAPABILITIES.filter((item) => item.st).length}，TI 映射 ${CAPABILITIES.filter((item) => item.ti).length}）`);
