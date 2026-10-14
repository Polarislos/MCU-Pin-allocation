import assert from "node:assert/strict";
import { CAPABILITIES } from "../src/lib/capabilities.js";
import { PERIPHERAL_GUIDES, guideForPeripheral } from "../src/data/peripheralGuides/index.js";
import { GUIDE_COMPARISONS, GUIDE_USE_CASES } from "../src/data/peripheralGuides/phase2.js";
import { checkGuideUsage } from "../src/lib/guideUsageCheck.js";
import { usageById } from "../src/lib/peripheralUsage.js";
import h743 from "../src/data/mcus/stm32h743vit6.json" with { type: "json" };
assert.equal(PERIPHERAL_GUIDES.length, CAPABILITIES.length);
for (const guide of PERIPHERAL_GUIDES) {
  for (const key of ["summary", "uses", "signals", "caution", "source"]) assert.ok(guide[key], `${guide.id}: ${key}`);
  assert.equal(new URL(guide.source).hostname.endsWith("st.com"), true);
}
for (const [instance, expected] of [["SDMMC1", "sdmmc"], ["FMC", "fmc"], ["HRTIM1", "hrtim"], ["CORDIC", "cordic"], ["CRYP", "aes"], ["USB_OTG_HS", "usb-hs"]]) assert.equal(guideForPeripheral({ instance })?.id, expected);
assert.equal(guideForPeripheral({ instance: "ADF1", type: "MDF" }).id, "adf");
assert.equal(guideForPeripheral({ instance: "NOT_REAL" }), null);
assert.equal(guideForPeripheral(null), null);
for (const id of ["dma2d", "gpu2d", "cordic", "fmac", "aes", "saes", "hash", "pka", "rng", "npu"]) assert.match(PERIPHERAL_GUIDES.find(g=>g.id===id).signals, /无专属外部引脚/);
for (const [id, examples] of Object.entries(GUIDE_USE_CASES)) {
  assert.ok(PERIPHERAL_GUIDES.some((guide) => guide.id === id));
  for (const example of examples) assert.ok(usageById(example.usage), `${id}: missing usage ${example.usage}`);
}
for (const comparisons of Object.values(GUIDE_COMPARISONS)) for (const comparison of comparisons) assert.ok(comparison.left && comparison.right && comparison.title);
const sdram = checkGuideUsage(h743, usageById("fmc-sdram"));
assert.ok(sdram.partial.some(({ entry, result }) => entry.instance === "FMC" && result.missing.includes("SDCLK")), "H743 LQFP100 SDRAM should report missing external-memory signals");
assert.equal(sdram.matches.length, 0, "H743 LQFP100 must not be presented as SDRAM-ready");
const sd = checkGuideUsage(h743, usageById("sd"));
assert.ok(sd.matches.some(({ entry }) => entry.instance.startsWith("SDMMC")), "H743 LQFP100 exposes a four-bit SDMMC signal set");
console.log(`peripheral guides: ${PERIPHERAL_GUIDES.length} complete entries; instance aliases and internal resources verified`);
