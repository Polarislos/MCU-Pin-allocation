/*
  导出格式测试。这三种输出会被直接贴进 CubeMX 工程和 C 代码里，
  格式错了要到编译或烧板阶段才发现，所以逐项校验语法骨架。
*/
import assert from "node:assert/strict";
import { allocatePins } from "../src/lib/allocator.js";
import { EXPORT_FORMATS, toCsv, toHeader, toIoc, toMarkdown, toNetLabels, toPinDefinitionsCsv } from "../src/lib/export.js";
import { ensureMcuLoaded } from "../src/lib/mcuCatalog.js";

const mcu = await ensureMcuLoaded("st-stm32h743vit6-lqfp100");

const solution = allocatePins(
  mcu,
  [
    { id: "spi", type: "SPI", variant: "full4" },
    { id: "i2c", type: "I2C" },
    { id: "eth", type: "ETH", variant: "rmii" },
  ],
  { maxSolutions: 1 },
).solutions[0];

const expectedPins = solution.groups.reduce((sum, group) => sum + group.assignments.length, 0);
assert.equal(expectedPins, 15, "SPI 4 线 + I2C 2 线 + RMII 9 线 = 15 脚");

/* ---------- CSV ---------- */
const csv = toCsv(mcu, solution);
assert.ok(csv.startsWith("﻿"), "CSV 需要 BOM，否则 Excel 打开中文会乱码");
const csvLines = csv.split("\r\n");
assert.equal(csvLines.length, expectedPins + 1, "CSV 行数 = 表头 + 每脚一行");
assert.ok(csvLines.every((line) => (line.match(/"/g) || []).length === 18), "CSV 每行 9 个带引号字段");

/* ---------- 完整引脚定义 CSV ---------- */
const pinDefinitionsCsv = toPinDefinitionsCsv(mcu);
assert.ok(pinDefinitionsCsv.startsWith("﻿"), "完整引脚 CSV 需要 BOM，否则 Excel 打开中文会乱码");
const pinDefinitionLines = pinDefinitionsCsv.split("\r\n");
assert.equal(pinDefinitionLines.length, mcu.pins.length + 1, "完整引脚 CSV 应包含表头和每颗引脚一行");
assert.ok(pinDefinitionLines.every((line) => (line.match(/"/g) || []).length === 24), "完整引脚 CSV 每行应有 12 个字段");
assert.ok(pinDefinitionsCsv.includes('"PE2"'), "完整引脚 CSV 缺少引脚名");
assert.ok(pinDefinitionsCsv.includes("TRACECLK (AF0)"), "完整引脚 CSV 缺少 AF 复用定义");

/* ---------- CubeMX .ioc ---------- */
const ioc = toIoc(mcu, solution);
assert.ok(ioc.startsWith("#MicroXplorer"), ".ioc 必须以 MicroXplorer 标识开头");
assert.match(ioc, new RegExp(`^Mcu\\.PinsNb=${expectedPins}$`, "m"));
for (let index = 0; index < expectedPins; index += 1) {
  assert.match(ioc, new RegExp(`^Mcu\\.Pin${index}=P[A-K]\\d+$`, "m"), `缺少 Mcu.Pin${index}`);
}
for (const group of solution.groups) {
  for (const item of group.assignments) {
    assert.match(ioc, new RegExp(`^${item.pin.name}\\.Signal=${item.function}$`, "m"),
      `${item.pin.name} 缺少 Signal=${item.function}`);
    assert.match(ioc, new RegExp(`^${item.pin.name}\\.Locked=true$`, "m"));
  }
}
/* 非注释行必须都是 key=value，CubeMX 解析不了别的 */
for (const line of ioc.split("\n")) {
  if (!line || line.startsWith("#")) continue;
  assert.match(line, /^[\w.]+=.+$/, `.ioc 出现非法行: ${line}`);
}

/* ---------- HAL 头文件 ---------- */
const headerText = toHeader(mcu, solution);
assert.match(headerText, /^#ifndef STM32H743VIT6_PIN_PLAN_H$/m);
assert.match(headerText, /^#define STM32H743VIT6_PIN_PLAN_H$/m);
assert.match(headerText, /^#endif \/\* STM32H743VIT6_PIN_PLAN_H \*\/$/m);
assert.equal(
  (headerText.match(/^#define \w+_Pin\s+GPIO_PIN_\d+$/gm) || []).length,
  expectedPins,
  "每个脚要有一条 _Pin 宏",
);
assert.equal(
  (headerText.match(/^#define \w+_GPIO_Port\s+GPIO[A-K]$/gm) || []).length,
  expectedPins,
  "每个脚要有一条 _GPIO_Port 宏",
);
assert.match(headerText, /^#define ETH_RMII_REF_CLK_AF\s+GPIO_AF11_ETH\s+\/\* AF11 \*\/$/m);
// 括号配平：注释块没闭合会让整个头文件失效
assert.equal((headerText.match(/\/\*/g) || []).length, (headerText.match(/\*\//g) || []).length, "注释未配平");

/* ---------- Markdown ---------- */
const markdown = toMarkdown(mcu, solution);
assert.match(markdown, /^# STM32H743VIT6 引脚分配$/m);
assert.equal(
  (markdown.match(/^\| \d+ \| P[A-K]\d+ \|/gm) || []).length,
  expectedPins,
  "Markdown 表格行数应等于脚数",
);
for (const group of solution.groups) {
  assert.ok(markdown.includes(`### ${group.instance} —`), `缺少 ${group.instance} 分组小节`);
}

/* ---------- EDA 网络标签 JSON ----------
   这份是给 EDA 扩展读的，错了会在原理图上静默错位——比其他格式更该逐项拦。 */
const netLabels = JSON.parse(toNetLabels(mcu, solution));
assert.equal(netLabels.format, "pinplan-netlabels");
assert.equal(netLabels.version, 1);
assert.equal(netLabels.device.pinCount, mcu.pinCount);
assert.equal(netLabels.labels.length, expectedPins, "每个被分配的脚一条标签");
/* 核对表必须是**整份** pinout，不只是被分配的那些——消费方要靠它验证符号 */
assert.equal(netLabels.pinout.length, mcu.pins.length, "pinout 应含全部引脚");
assert.ok(netLabels.pinout.some((pin) => pin.kind === "supply"), "pinout 应含电源脚");

const netNames = netLabels.labels.map((label) => label.net);
assert.equal(new Set(netNames).size, netNames.length, "网络名重复会在原理图上把两个脚短接");
for (const label of netLabels.labels) {
  assert.match(label.net, /^[A-Za-z0-9_]+$/, `网络名 ${label.net} 含非法字符`);
  assert.match(label.gpio, /^P[A-K]\d+$/, `gpio 字段应是 GPIO 名，实际 ${label.gpio}`);
  /* designator 要能在 pinout 里找到，否则扩展按它找引脚会落空 */
  assert.ok(
    netLabels.pinout.some((pin) => pin.designator === label.designator && pin.name === label.gpio),
    `标签 ${label.net} 的 designator ${label.designator} 在 pinout 里对不上 ${label.gpio}`,
  );
}

/* 栅格封装上球号才是 EDA 符号里的引脚编号，脚号只是内部序号。
   拿 number 当 designator 会让整片 BGA 错位，所以单独造一颗验。 */
const bga = {
  ...mcu,
  partNumber: "SYN-BGA4",
  package: "TFBGA4",
  pinCount: 4,
  pins: mcu.pins.slice(0, 4).map((pin, index) => ({
    ...pin,
    location: `${"AB"[Math.floor(index / 2)]}${(index % 2) + 1}`,
  })),
};
const bgaLabels = JSON.parse(toNetLabels(bga, solution));
assert.deepEqual(
  bgaLabels.pinout.map((pin) => pin.designator),
  ["A1", "A2", "B1", "B2"],
  "栅格封装的 designator 必须取 location（球号），不是内部脚号",
);

/* ---------- 格式清单 ---------- */
assert.equal(EXPORT_FORMATS.length, 6);
/* fanout 不在这里渲染：它不是"生成一个文件"，而是往用户提供的 EDA 扇出表格里
   填一列，没有 render。见 tests/fanout.mjs。 */
assert.deepEqual(
  EXPORT_FORMATS.filter((format) => !format.render).map((format) => format.id),
  ["fanout"],
  "只有 fanout 允许没有 render，其余格式少了 render 会在导出时静默什么都不做",
);
for (const format of EXPORT_FORMATS.filter((item) => item.render)) {
  const output = format.render(mcu, solution);
  assert.ok(typeof output === "string" && output.length > 0, `${format.id} 输出为空`);
}

/* ---------- 模拟通道：af 是 null，四种格式都不能印出 "AFnull" ----------
   这类脏数据只有在贴进 CubeMX 或编译工程时才会被发现，所以逐项拦住。 */
const analogSolution = allocatePins(
  mcu,
  [
    { id: "adc", type: "ADC", variant: "ch4", instance: "ADC1" },
    { id: "dac", type: "DAC", variant: "out1" },
    { id: "spi", type: "SPI", variant: "full3" },
  ],
  { maxSolutions: 1 },
).solutions[0];
assert.ok(analogSolution, "模拟 + 数字混合应有解");

for (const format of EXPORT_FORMATS.filter((item) => item.render)) {
  const output = format.render(mcu, analogSolution);
  assert.ok(!output.includes("AFnull"), `${format.id} 印出了 AFnull`);
  assert.ok(!output.includes("undefined"), `${format.id} 印出了 undefined`);
}

const analogRows = analogSolution.groups
  .filter((group) => group.type === "ADC" || group.type === "DAC")
  .flatMap((group) => group.assignments);
assert.ok(analogRows.length >= 5);
assert.ok(analogRows.every((item) => item.af === null));

/* CSV / Markdown 的 AF 列写"模拟" */
const analogCsv = toCsv(mcu, analogSolution);
assert.ok(analogCsv.includes('"模拟"'), "CSV 的 AF 列应写「模拟」");
assert.match(toMarkdown(mcu, analogSolution), /\| 模拟 \|/);

/* HAL 头文件：模拟脚只出 _Pin / _GPIO_Port，不出 _AF 宏 */
const analogHeader = toHeader(mcu, analogSolution);
for (const item of analogRows) {
  assert.match(analogHeader, new RegExp(`^#define ${item.function}_Pin\\s+GPIO_PIN_\\d+$`, "m"));
  assert.match(analogHeader, new RegExp(`^#define ${item.function}_GPIO_Port\\s+GPIO[A-K]$`, "m"));
  assert.ok(!new RegExp(`^#define ${item.function}_AF\\b`, "m").test(analogHeader),
    `${item.function} 是模拟脚，不该有 _AF 宏`);
  assert.ok(analogHeader.includes(`/* ${item.function}: GPIO_MODE_ANALOG`),
    `${item.function} 缺少 GPIO_MODE_ANALOG 说明`);
}
assert.equal((analogHeader.match(/\/\*/g) || []).length, (analogHeader.match(/\*\//g) || []).length, "注释未配平");

/* .ioc 仍然全是 key=value，模拟脚照写 Signal（CubeMX 对模拟脚正是这么记的） */
const analogIoc = toIoc(mcu, analogSolution);
for (const line of analogIoc.split("\n")) {
  if (!line || line.startsWith("#")) continue;
  assert.match(line, /^[\w.]+=.+$/, `.ioc 出现非法行: ${line}`);
}
for (const item of analogRows) {
  assert.match(analogIoc, new RegExp(`^${item.pin.name}\\.Signal=${item.function}$`, "m"));
}

console.log(`Verified CSV / .ioc / HAL header / Markdown exports for ${expectedPins} pins.`);
console.log(`Verified EDA net-label JSON: ${netLabels.labels.length} labels, ${netLabels.pinout.length}-pin checklist, BGA ball designators.`);
console.log(`Verified analog (af=null) handling across all four formats for ${analogRows.length} channel pins.`);
