/*
  扇出网络标签表格的填充测试。

  fixture 是嘉立创EDA 专业版真实导出的文件（STM32F103C8T6 LQFP48，U1），
  没有手改过一个字节——这个格式官方没有文档，只能拿实物当规格。
  下面对编码/分隔符/行尾的断言就是在钉死这份规格：EDA 换了写法，这里先红。
*/
import assert from "node:assert/strict";
import fs from "node:fs";
import { allocatePins } from "../src/lib/allocator.js";
import { decodeFanoutFile, encodeFanoutFile, fillFanout, parseFanout } from "../src/lib/fanout.js";
import { ensureMcuLoaded } from "../src/lib/mcuCatalog.js";

const raw = fs.readFileSync(new URL("./fixtures/fanout-stm32f103c8t6-lqfp48.csv", import.meta.url));
const mcu = await ensureMcuLoaded("st-stm32f103c8t6-lqfp48");

/* ---------- 文件格式本身 ---------- */
assert.equal(raw[0], 0xFF, "EDA 导出的是 UTF-16 LE，第一个字节应是 BOM 的 FF");
assert.equal(raw[1], 0xFE, "第二个字节应是 FE");

const text = decodeFanoutFile(raw);
const table = parseFanout(text);
assert.deepEqual(
  table.header,
  ["designator", "symbolId", "pinNumber", "pinRotation", "pinName", "netname", "wireOrBusLength", "noConnect"],
  "表头是这 8 列，且顺序固定——EDA 导入时按列名认，改了就报『格式异常』",
);
assert.equal(table.rows.length, 48, "48 脚 = 48 行数据");
assert.equal(table.eol, "\n", "行尾是 LF 不是 CRLF");
assert.ok(table.trailingNewline, "文件末尾有一个空行");
assert.ok(!text.includes(","), "它叫 .csv，但分隔符是制表符，整份文件里没有逗号");

/* 回写必须是字节级可逆的：没改过的表格 encode(serialize(parse(x))) === x。
   这一条不成立的话，"只改 netname 一列"就是空话。 */
const roundTrip = encodeFanoutFile(text.replace(/^﻿/, ""));
assert.deepEqual(Buffer.from(roundTrip), raw, "原样解析再编码应当和原文件逐字节相同");

/* ---------- 填表 ---------- */
const solution = allocatePins(
  mcu,
  [
    { id: "spi", type: "SPI", variant: "full4" },
    { id: "i2c", type: "I2C" },
  ],
  { maxSolutions: 1 },
).solutions[0];
const assigned = solution.groups.reduce((sum, group) => sum + group.assignments.length, 0);
assert.equal(assigned, 6, "SPI 4 线 + I2C 2 线 = 6 脚");

const filled = fillFanout(text, mcu, solution);
assert.equal(filled.designator, "U1");
assert.equal(filled.stats.signal, 6, "6 个信号脚被填上方案的网络名");
assert.equal(filled.stats.power, 9, "9 个电源脚按约定填 GND / +3V3");
assert.equal(filled.stats.signal + filled.stats.power + filled.stats.cleared, 48, "48 个脚都处理到了");
assert.equal(filled.warnings.length, 0, "这颗片子的电源脚都能认出来，不该有告警");

const after = parseFanout(filled.text);
const columns = {};
after.header.forEach((name, index) => { columns[name] = index; });
const byPin = new Map(after.rows.map((row) => [row[columns.pinNumber], row]));

/* 电源脚：按数据手册名判断，不按符号名——符号上写的是带序号的 VSS_1 / VDD_3。
   （脚 23/24/35/36/47/48 就是引脚核对最早报错的那 6 个。） */
for (const pin of ["8", "23", "35", "47"]) {
  assert.equal(byPin.get(pin)[columns.netname], "GND", `脚 ${pin} 是 VSS/VSSA，应接 GND`);
}
for (const pin of ["1", "9", "24", "36", "48"]) {
  assert.equal(byPin.get(pin)[columns.netname], "+3V3", `脚 ${pin} 是 VDD/VDDA/VBAT，应接 +3V3`);
}

/* 未分配的脚必须清空。EDA 导出的模板里 netname 预填的就是 pinName，
   原样导回去会凭空生出几十个叫 PB9、PC13-TAMPER-RTC 的网络，各带一根线。 */
const unassigned = after.rows.filter((row) => row[columns.netname] === "");
assert.equal(unassigned.length, 33, "48 - 6 信号 - 9 电源 = 33 个脚留空");
assert.equal(byPin.get("46")[columns.netname], "", "PB9 没被分配，网络名要清掉");
assert.equal(byPin.get("7")[columns.netname], "", "NRST 是 special，不猜网络名");

/* 信号脚填的必须和 netlabels JSON 是同一套名字（同源于 buildNetLabels）。
   两边分叉 = 同一根线在两个导出里叫不同名字。 */
const signalRows = after.rows.filter((row) => {
  const net = row[columns.netname];
  return net !== "" && net !== "GND" && net !== "+3V3";
});
assert.equal(signalRows.length, 6);
for (const row of signalRows) {
  assert.match(row[columns.netname], /^[A-Za-z0-9_]+$/, "网络名只能是合法标识符");
}

/* 除 netname 外一列都不许动 */
for (const [index, row] of after.rows.entries()) {
  const before = table.rows[index];
  for (const [name, column] of Object.entries(columns)) {
    if (name === "netname") continue;
    assert.equal(row[column], before[column], `第 ${index + 1} 行的 ${name} 列被改动了`);
  }
}

/* ---------- 拒绝不合规的输入 ---------- */
assert.throws(
  () => fillFanout("designator\tpinNumber\nU1\t1\n", mcu, solution),
  /表头缺少 netname/,
  "缺列要明确说缺哪列，并指路到 EDA 的导出功能",
);
/*
  选错器件是这里最危险的输入：另一颗芯片的脚号 1..N 照样落在方案的范围内，
  光看脚号发现不了，会安静地填出一整套张冠李戴的网络名。只有比名字能拦住。
*/
const wrongDevice = text.split("\n").map((line, index) => {
  if (index === 0 || line === "") return line;
  const cells = line.split("\t");
  cells[4] = `IO${cells[2]}`; // pinName 换成另一颗芯片的写法
  return cells.join("\t");
}).join("\n");
assert.throws(
  () => fillFanout(wrongDevice, mcu, solution),
  /不是同一颗片子/,
  "整片名字对不上时必须拒绝，不能按脚号硬填",
);

/* 反过来，零星几个写法不同要放行——库里这是常态——但要在 warnings 里说出来。 */
const oddNaming = text.split("\n").map((line, index) => {
  if (index !== 46) return line; // 第 46 行 = 脚 45
  const cells = line.split("\t");
  cells[4] = "IO_45";
  return cells.join("\t");
}).join("\n");
const tolerated = fillFanout(oddNaming, mcu, solution);
assert.ok(
  tolerated.warnings.some((line) => line.includes("IO_45")),
  "个别对不上的脚名要点名报出来，但不阻断",
);

/* 多 part 符号：一次只扇出一部分脚，能填，但要提醒还有别的 part。 */
const onePart = text.split("\n").filter((line, index) => index === 0 || index > 24 || line === "").join("\n");
assert.ok(
  fillFanout(onePart, mcu, solution).warnings.some((line) => line.includes("每个 part 都要各扇出")),
  "行数少于脚数时要提示可能是多 part 符号",
);

console.log("Verified fan-out net-label table: UTF-16LE/TSV round-trip, 6 signal + 9 power pins filled, wrong-device rejection.");
