/*
  器件专属抽检。

  通用不变量（invariants.mjs）能保证数据自洽，但保证不了数据**是对的**——
  一份把所有 AF 编号统一加一的表同样自洽。抽检就是对着 datasheet 人工核对过的
  那几十条锚点，专治导入脚本悄悄跑偏。

  每颗片子一份 tests/fixtures/<catalog id>.json，字段全部可选：只写你真的
  核对过的部分，没核对过的宁可不写，也不要写个猜的数字进来当"通过"。
*/
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DEFINITIONS, isFiveVoltTolerant, supportsFiveVolt } from "../../src/lib/allocator.js";
import { signalGrammar } from "../../src/lib/dialect.js";
import { analogInputs } from "../../src/lib/analog.js";
import { packageLayout } from "../../src/lib/package.js";

const FIXTURE_DIR = new URL("../fixtures/", import.meta.url);

export async function loadFixtures() {
  const files = (await readdir(FIXTURE_DIR)).filter((file) => file.endsWith(".json"));
  const fixtures = new Map();
  for (const file of files) {
    const fixture = JSON.parse(await readFile(new URL(file, FIXTURE_DIR), "utf8"));
    assert.equal(`${fixture.id}.json`, file, `抽检文件名应与 id 一致：${file}`);
    fixtures.set(fixture.id, fixture);
  }
  return fixtures;
}

export function checkFixture(fixture, mcu) {
  const where = fixture.partNumber || fixture.id;
  const byName = new Map(mcu.pins.map((pin) => [pin.name, pin]));
  const byNumber = new Map(mcu.pins.map((pin) => [pin.number, pin]));

  for (const field of ["partNumber", "package", "pinCount"]) {
    if (fixture[field] !== undefined) assert.equal(mcu[field], fixture[field], `${where}: ${field} 与抽检不符`);
  }
  if (fixture.gpioCount !== undefined) {
    assert.equal(
      mcu.pins.filter((pin) => pin.kind === "gpio").length, fixture.gpioCount,
      `${where}: GPIO 数量与抽检不符`,
    );
  }
  if (fixture.minFunctionCount !== undefined) {
    const total = mcu.pins.reduce((sum, pin) => sum + pin.functions.length, 0);
    assert.ok(
      total >= fixture.minFunctionCount,
      `${where}: 复用功能只有 ${total} 条，少于抽检下限 ${fixture.minFunctionCount}——AF 表可能导入残缺`,
    );
  }

  for (const [number, name] of Object.entries(fixture.pinNames || {})) {
    assert.equal(byNumber.get(Number(number))?.name, name, `${where}: 脚 ${number} 应是 ${name}`);
  }

  /* 引脚 → 功能 → AF 编号。整表偏移一位这种事只有靠锚点才抓得住。 */
  for (const item of fixture.functions || []) {
    const pin = byName.get(item.pin);
    assert.ok(pin, `${where}: 抽检引用的引脚 ${item.pin} 不存在`);
    const found = pin.functions.find((entry) => entry.name === item.function);
    assert.ok(found, `${where}: ${item.pin} 上没有 ${item.function}`);
    if (item.af !== undefined) {
      assert.equal(found.af, item.af, `${where}: ${item.pin} 的 ${item.function} 应是 AF${item.af}`);
    }
  }

  /* 厂商写法 → 规范信号名。这是方言表的直接回归：MSPM0 的 SPI0_PICO 必须
     解析成 MOSI，译反了求解照样成功、但导出的接线表会把两根线标错。 */
  for (const item of fixture.canonicalSignals || []) {
    const grammar = signalGrammar(mcu, item.type, DEFINITIONS[item.type]);
    const match = item.function.match(grammar.pattern);
    assert.ok(match, `${where}: ${item.function} 没能被 ${item.type} 的语法匹配上`);
    assert.equal(match[1], item.instance, `${where}: ${item.function} 的实例应是 ${item.instance}`);
    assert.equal(
      grammar.normalize(match[2]), item.signal,
      `${where}: ${item.function} 应规范化成 ${item.signal}`,
    );
  }

  for (const [name, kind] of Object.entries(fixture.protection || {})) {
    assert.ok(byName.get(name)?.protection.includes(kind), `${where}: ${name} 应带 ${kind} 保护标记`);
  }

  if (fixture.layout) {
    const layout = packageLayout(mcu);
    assert.equal(layout.kind, fixture.layout.kind, `${where}: 布局类型与抽检不符`);
    if (fixture.layout.pinsPerSide !== undefined) {
      assert.equal(layout.pinsPerSide, fixture.layout.pinsPerSide, `${where}: 每边脚数与抽检不符`);
    }
    for (const [side, [from, to]] of Object.entries(fixture.layout.sideRanges || {})) {
      for (let number = from; number <= to; number += 1) {
        assert.equal(layout.sideOf(number), side, `${where}: 脚 ${number} 应落在${side}`);
      }
    }
  }

  for (const [family, instances] of Object.entries(fixture.analog || {})) {
    const inputs = analogInputs(mcu, family);
    assert.deepEqual(
      [...inputs.keys()].sort(), Object.keys(instances).sort(),
      `${where}: ${family} 的实例集合与抽检不符`,
    );
    for (const [instance, count] of Object.entries(instances)) {
      assert.equal(inputs.get(instance).length, count, `${where}: ${instance} 应有 ${count} 条可分配通道`);
    }
  }
  if (fixture.dacPins) {
    assert.deepEqual(
      analogInputs(mcu, "DAC").get(Object.keys(fixture.analog.DAC)[0]).map((item) => `${item.pin.name}:${item.channel}`),
      fixture.dacPins,
      `${where}: DAC 输出脚与抽检不符`,
    );
  }

  if (fixture.fiveVolt) {
    assert.equal(supportsFiveVolt(mcu), fixture.fiveVolt.supported, `${where}: 耐压约束可用性与抽检不符`);
    if (fixture.fiveVolt.intolerant) {
      const intolerant = mcu.pins
        .filter((pin) => pin.kind === "gpio" && isFiveVoltTolerant(mcu, pin) === false)
        .map((pin) => pin.name)
        .sort();
      assert.deepEqual(intolerant, [...fixture.fiveVolt.intolerant].sort(), `${where}: 不耐 5V 的 GPIO 清单与抽检不符`);
    }
  }
}
