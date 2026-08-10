/*
  嘉立创EDA 扩展里那两块纯逻辑的测试：引脚名比对（match.ts）和标签导线的几何
  （geometry.ts）。

  ── 为什么这两块值得单独测 ──────────────────────────────────────────
  扩展的其余部分全是 API 调用和对话框，测不了也不该测。但这两块不一样：

    · 引脚名比对**在两个地方各写了一份**（这里的 match.ts，和 src/lib/fanout.js
      的 pinNameMatches）。两份分叉的后果是同一份方案走扩展和走扇出表格得到
      不同结果，而且没有任何东西会报错。README 里写着"两处要一起改"——这个
      测试就是让那句话有牙齿。

    · 几何算错不会报错，只会把导线画到离引脚一格远的地方，看着像连上了实际
      没连；或者两个脚的标签落在同一个点上，在原理图里就是静默短接。

  ── 直接 import .ts ─────────────────────────────────────────────────
  Node 23+ 默认剥离类型，扩展那两个文件只用了 interface / type（可擦除语法），
  所以不必先构建。用的是源码而不是打包产物——测的就是要改的那份。
*/
import assert from "node:assert/strict";
import {
  DEFAULT_LENGTH_MULTIPLE, centroidOf, connectionPointOf, normalizeLengthMultiple,
  outwardOf, pointsOfLine, samePoint, stubOf,
} from "../tools/lceda-extension/src/geometry.ts";
import { checkAgainstSymbol, nameMatches } from "../tools/lceda-extension/src/match.ts";
import { pinNameMatches } from "../src/lib/fanout.js";

/* ---------- 一：引脚名比对，两份实现必须给出同一个答案 ---------- */

/*
  每一行都是真实会遇到的写法。前四类是"库里加了后缀"，中间两类是"方案那边加了
  后缀"，最后几类是必须判否的——尤其 PA1 vs PA15/PA10：只用 startsWith 就会把
  它们判成匹配，那正是"整体错位一格"能蒙混过关的口子。
*/
const NAME_CASES = [
  ["PA5", "PA5", true],
  ["PA5/SPI1_SCK", "PA5", true],
  ["PC14-OSC32_IN", "PC14", true],
  ["PA13/JTMS-SWDIO", "PA13", true],
  ["PC13-TAMPER-RTC", "PC13", true],
  ["VSS_1", "VSS", true],
  ["VDD2", "VDD", true],
  ["VSS", "VSS_1", true],          // 后缀在方案那边
  ["PB9", "PB9/I2C1_SDA", true],
  ["pa5", "PA5", true],            // 大小写不敏感
  ["PA5", "", true],               // 方案没给名字就不校验
  ["PA15", "PA1", false],          // ← 只用 startsWith 会漏掉的那一类
  ["PA10", "PA1", false],
  ["PA1", "PA15", false],
  ["VSSA", "VSS", false],          // 续字母是另一个脚，不是后缀
  ["VDD", "VSS", false],
  ["PB9", "PA9", false],
];

for (const [symbolName, planName, expected] of NAME_CASES) {
  assert.equal(
    nameMatches(symbolName, planName), expected,
    `match.ts: nameMatches("${symbolName}", "${planName}") 应为 ${expected}`,
  );
  assert.equal(
    pinNameMatches(symbolName, planName), expected,
    `fanout.js: pinNameMatches("${symbolName}", "${planName}") 应为 ${expected}`,
  );
}

/* 上面是逐条钉死期望值，这里再交叉跑一遍所有组合——两份实现只要在任何一对
   输入上分叉就会被抓住，包括我没想到去写成用例的那些组合。 */
const ALL_NAMES = [...new Set(NAME_CASES.flatMap(([a, b]) => [a, b]))];
for (const left of ALL_NAMES) {
  for (const right of ALL_NAMES) {
    assert.equal(
      nameMatches(left, right), pinNameMatches(left, right),
      `两份实现分叉了："${left}" vs "${right}"——match.ts 和 fanout.js 必须一起改`,
    );
  }
}

/* ---------- 二：checkAgainstSymbol 的三档判定 ---------- */

function fakePin(pinNumber, pinName) {
  return { getState_PinNumber: () => pinNumber, getState_PinName: () => pinName };
}

const PLAN = {
  device: { partNumber: "FAKE", pinCount: 4 },
  pinout: [
    { designator: "1", name: "VDD", kind: "supply" },
    { designator: "2", name: "PA0", kind: "io" },
    { designator: "3", name: "PA1", kind: "io" },
    { designator: "4", name: "VSS", kind: "supply" },
  ],
};

{
  const clean = checkAgainstSymbol(
    [fakePin("1", "VDD_1"), fakePin("2", "PA0/ADC1_IN0"), fakePin("3", "PA1"), fakePin("4", "VSS")],
    PLAN,
  );
  assert.equal(clean.fatal, false);
  assert.deepEqual(clean.mismatched, [], "库里常见的后缀写法不该算作对不上");
}

{
  /* 脚数一样但整体错位一格——这是最危险的一类，必须被名字比对抓住 */
  const shifted = checkAgainstSymbol(
    [fakePin("1", "PA0"), fakePin("2", "PA1"), fakePin("3", "VSS"), fakePin("4", "PB0")],
    PLAN,
  );
  assert.equal(shifted.fatal, false, "脚号齐全，结构上没问题");
  assert.equal(shifted.mismatched.length, 4, "四个脚全部错位，必须全部报出来");
}

{
  const short = checkAgainstSymbol([fakePin("1", "VDD"), fakePin("2", "PA0")], PLAN);
  assert.equal(short.fatal, true, "脚数不足（多 part 符号只选中一个）必须是 fatal");
  assert.equal(short.missing.length, 2);
}

{
  const dup = checkAgainstSymbol(
    [fakePin("1", "VDD"), fakePin("1", "VDD"), fakePin("2", "PA0"), fakePin("3", "PA1")],
    PLAN,
  );
  assert.deepEqual(dup.duplicates, ["1"], "重复脚号要报出来");
  assert.equal(dup.fatal, true, "去重后只剩 3 个编号，对不上方案的 4 个");
}

/* ---------- 三：标签导线的几何 ---------- */

/*
  拿一颗四边出脚的方形符号当被试品：每边 3 个脚，引脚长 10，本体 40×40。
  左右为水平脚（rotation 0/180），上下为竖直脚（rotation 90/270）。

  坐标按 "(x, y) 就是连接点" 造，也就是 origin === "tip" 那一支；root 那一支
  由下面的对称性断言覆盖。
*/
const BODY = 20;
const PIN_LENGTH = 10;
const OFFSETS = [-10, 0, 10];
const SQUARE = [
  ...OFFSETS.map((offset, index) => ({
    designator: `L${index}`, name: `L${index}`, x: -BODY - PIN_LENGTH, y: offset, rotation: 0, pinLength: PIN_LENGTH,
  })),
  ...OFFSETS.map((offset, index) => ({
    designator: `R${index}`, name: `R${index}`, x: BODY + PIN_LENGTH, y: offset, rotation: 180, pinLength: PIN_LENGTH,
  })),
  ...OFFSETS.map((offset, index) => ({
    designator: `T${index}`, name: `T${index}`, x: offset, y: BODY + PIN_LENGTH, rotation: 90, pinLength: PIN_LENGTH,
  })),
  ...OFFSETS.map((offset, index) => ({
    designator: `B${index}`, name: `B${index}`, x: offset, y: -BODY - PIN_LENGTH, rotation: 270, pinLength: PIN_LENGTH,
  })),
];

const centroid = centroidOf(SQUARE);
assert.ok(samePoint(centroid, { x: 0, y: 0 }), "四边对称的符号，引脚重心应在原点");

/* 朝外方向：不解释 rotation 的正负语义，只要求"背离重心"。这正是代码里
   放弃解释 rotation 符号、改用重心的理由。 */
for (const pin of SQUARE) {
  const outward = outwardOf(pin, centroid);
  assert.equal(
    Math.abs(outward.x) + Math.abs(outward.y), 1,
    `${pin.designator}: 朝外方向必须是四个轴向单位向量之一`,
  );
  const projection = outward.x * (pin.x - centroid.x) + outward.y * (pin.y - centroid.y);
  assert.ok(projection > 0, `${pin.designator}: 朝外方向必须背离重心，实际投影 ${projection}`);
}

/* tip 与 root 两种解释相差正好一个 pinLength，且差值方向就是朝外方向。
   这是校准之所以只需要一个布尔量的全部依据。 */
for (const pin of SQUARE) {
  const tip = connectionPointOf(pin, centroid, "tip");
  const root = connectionPointOf(pin, centroid, "root");
  const outward = outwardOf(pin, centroid);
  assert.ok(samePoint(tip, { x: pin.x, y: pin.y }), `${pin.designator}: tip 就是 (x, y) 本身`);
  assert.ok(
    samePoint(root, { x: tip.x + outward.x * PIN_LENGTH, y: tip.y + outward.y * PIN_LENGTH }),
    `${pin.designator}: root 应比 tip 朝外一个 pinLength`,
  );
}

/* 长度倍数由用户设定，所以每种倍数都得满足同一批不变量——尤其"端点仍在栅格上"
   和"起点仍然正好落在连接点上"。倍数只该影响远端那一头。 */
for (const origin of ["tip", "root"]) {
  for (const multiple of [1, DEFAULT_LENGTH_MULTIPLE, 7, 20]) {
    const stubs = SQUARE.map((pin) => ({ pin, line: stubOf(pin, centroid, origin, multiple) }));

    for (const { pin, line } of stubs) {
      const point = connectionPointOf(pin, centroid, origin);
      assert.equal(line.length, 4, `${pin.designator}: 标签导线是一根两点线段`);
      assert.ok(
        samePoint({ x: line[0], y: line[1] }, point),
        `${pin.designator}(${origin}×${multiple}): 导线起点必须**正好**落在连接点上，`
        + `否则电气上没连上——加长只能往外长，不能把起点挪走`,
      );
      const dx = line[2] - line[0];
      const dy = line[3] - line[1];
      assert.ok(dx === 0 || dy === 0, `${pin.designator}: 标签导线必须是横平竖直的`);
      assert.equal(
        Math.hypot(dx, dy), PIN_LENGTH * multiple,
        `${pin.designator}(×${multiple}): 段长应为 pinLength 的整数倍，端点才落在栅格上`,
      );
      const outward = outwardOf(pin, centroid);
      assert.ok(dx * outward.x + dy * outward.y > 0, `${pin.designator}: 导线必须朝符号外面拉`);
    }

    /* 两个脚的标签落在同一个点上，在原理图里就是静默短接——比画错位置更难发现，
       因为图看起来完全正常。加长会把端点推得更远，仍然不能撞上。 */
    const endpoints = stubs.flatMap(({ line }) => [
      `${line[0]},${line[1]}`, `${line[2]},${line[3]}`,
    ]);
    assert.equal(
      new Set(endpoints).size, endpoints.length,
      `${origin}×${multiple}: 有两根标签导线的端点重合了，那在原理图上就是静默短接`,
    );
  }
}

/* 默认值不该退回"贴着符号"那种长度——那正是用起来嫌短的原因。 */
assert.ok(DEFAULT_LENGTH_MULTIPLE >= 2, "默认标签长度至少是引脚长度的 2 倍");

/*
  存进 sys_Storage 的值可能是任何东西：旧版本没写过（undefined）、用户手改过配置、
  输入框传回字符串。非整数最危险——它不会报错，只会让导线端点掉出栅格，于是"画上了
  但没连上"，正是这个扩展最想避免的那类失败。
*/
assert.equal(normalizeLengthMultiple(undefined), DEFAULT_LENGTH_MULTIPLE);
assert.equal(normalizeLengthMultiple(null), DEFAULT_LENGTH_MULTIPLE);
assert.equal(normalizeLengthMultiple("abc"), DEFAULT_LENGTH_MULTIPLE);
assert.equal(normalizeLengthMultiple("5"), 5, "输入框回传的永远是字符串");
assert.equal(normalizeLengthMultiple(2.5), 3, "非整数取整，否则端点掉出栅格");
assert.equal(normalizeLengthMultiple(0), 1, "0 会画出零长度导线，create 直接失败");
assert.equal(normalizeLengthMultiple(-4), 1);
assert.equal(normalizeLengthMultiple(999), 20);
for (const multiple of [undefined, null, "abc", "5", 2.5, 0, -4, 999, Number.NaN]) {
  assert.ok(
    Number.isInteger(normalizeLengthMultiple(multiple)),
    `normalizeLengthMultiple(${String(multiple)}) 必须回一个整数`,
  );
}

/* ---------- 四：已有导线的端点扫描 ---------- */

/* line 可能是 number[]，也可能是 number[][]（多段线）。这个扫描是"这个脚上
   已经有线了 → 跳过，不要覆盖用户手画的连接"的唯一依据，拍平错了就会去覆盖。 */
assert.deepEqual(
  pointsOfLine([0, 1, 2, 3]),
  [{ x: 0, y: 1 }, { x: 2, y: 3 }],
);
assert.deepEqual(
  pointsOfLine([[0, 0, 0, 10], [0, 10, 20, 10]]),
  [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 10 }, { x: 20, y: 10 }],
);
assert.deepEqual(pointsOfLine([]), []);

/* 坐标是浮点数，容差要能吸收计算误差，但不能宽到把相邻栅格点混为一谈 */
assert.ok(samePoint({ x: 1, y: 1 }, { x: 1.0001, y: 0.9999 }));
assert.ok(!samePoint({ x: 1, y: 1 }, { x: 1.5, y: 1 }));

console.log(
  `Verified net-label matching (${NAME_CASES.length} cases + ${ALL_NAMES.length ** 2} cross-checks `
  + `against fanout.js) and stub geometry on a ${SQUARE.length}-pin symbol.`,
);
