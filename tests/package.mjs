/*
  封装几何。

  这一层是求解器打分和界面画图**共用**的换算，错了不会报错，只会让"靠右"
  这条偏好在图上和分数里指向不同的边。目录里眼下只有四边封装，所以两边封装
  和 BGA 用合成器件测——真接一颗 TSSOP 或 BGA 进来时，这些路径不该是第一次运行。
*/
import assert from "node:assert/strict";
import { availableSides, layoutKindOf, packageLayout, pinPosition, sideOfPin } from "../src/lib/package.js";
import { ensureMcuLoaded } from "../src/lib/mcuCatalog.js";

function syntheticPins(count, options = {}) {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    name: `P${index + 1}`,
    kind: "gpio",
    functions: [],
    additionalFunctions: [],
    protection: [],
    ...(options.location ? { location: options.location(index) } : {}),
  }));
}

/* ---------- 四边封装：与真实器件对齐 ---------- */

const h743 = await ensureMcuLoaded("st-stm32h743vit6-lqfp100");
const quad = packageLayout(h743);
assert.equal(layoutKindOf(h743), "quad");
assert.equal(quad.kind, "perimeter");
assert.equal(quad.pinsPerSide, 25);

/* 脚 1 在左上角，逆时针：1-25 左、26-50 底、51-75 右、76-100 顶 */
for (const [side, [from, to]] of Object.entries({ left: [1, 25], bottom: [26, 50], right: [51, 75], top: [76, 100] })) {
  for (let number = from; number <= to; number += 1) {
    assert.equal(sideOfPin(number, h743), side, `脚 ${number} 应在${side}`);
  }
}

/* 四个角的归一化坐标。y=0 是顶边——这个约定一旦反过来，
   "靠上"和"靠下"就会整体互换，而求解仍然给得出方案。 */
assert.deepEqual(pinPosition(1, h743), { x: 0, y: 0 }, "脚 1 = 左上角");
assert.deepEqual(pinPosition(25, h743), { x: 0, y: 1 }, "脚 25 = 左下角");
assert.deepEqual(pinPosition(50, h743), { x: 1, y: 1 }, "脚 50 = 右下角");
assert.deepEqual(pinPosition(75, h743), { x: 1, y: 0 }, "脚 75 = 右上角");

/* 渲染顺序：每条边都按"从左到右 / 从上到下"给出，直接喂给 flex 布局 */
assert.deepEqual(quad.sides.left.map((pin) => pin.number).slice(0, 3), [1, 2, 3]);
assert.deepEqual(quad.sides.bottom.map((pin) => pin.number).slice(0, 3), [26, 27, 28]);
assert.deepEqual(quad.sides.right.map((pin) => pin.number).slice(0, 3), [75, 74, 73]);
assert.deepEqual(quad.sides.top.map((pin) => pin.number).slice(0, 3), [100, 99, 98]);

/* 每个脚恰好被安置一次，一个都不能漏——漏掉的脚在封装图上根本画不出来 */
const placed = Object.values(quad.sides).flat().map((pin) => pin.number);
assert.equal(new Set(placed).size, 100);
assert.deepEqual([...placed].sort((left, right) => left - right), Array.from({ length: 100 }, (_, i) => i + 1));

/* ---------- 两边封装（TSSOP / SOIC）---------- */

const tssop = {
  partNumber: "SYN-TSSOP20",
  package: "TSSOP20",
  packageGeometry: { shape: "TSSOP", pinsPerSide: 10 },
  pinCount: 20,
  pins: syntheticPins(20),
};
assert.equal(layoutKindOf(tssop), "dual");
const dual = packageLayout(tssop);

/* 顶边和底边根本不存在，界面据此不给这两个选项——
   而不是给一个永远满足不了的偏好。 */
assert.deepEqual(availableSides(tssop), ["left", "right"]);
assert.deepEqual(dual.sides.top, []);
assert.deepEqual(dual.sides.bottom, []);

/* 脚 1 左上，沿左边向下到 10，再从右下角 11 向上回到右上角 20 */
assert.equal(sideOfPin(1, tssop), "left");
assert.equal(sideOfPin(10, tssop), "left");
assert.equal(sideOfPin(11, tssop), "right");
assert.equal(sideOfPin(20, tssop), "right");
assert.deepEqual(pinPosition(1, tssop), { x: 0, y: 0 });
assert.deepEqual(pinPosition(10, tssop), { x: 0, y: 1 });
assert.deepEqual(pinPosition(11, tssop), { x: 1, y: 1 }, "脚 11 = 右下角");
assert.deepEqual(pinPosition(20, tssop), { x: 1, y: 0 }, "脚 20 = 右上角");
/* 右边自下而上编号，渲染要自上而下 */
assert.deepEqual(dual.sides.right.map((pin) => pin.number).slice(0, 3), [20, 19, 18]);
assert.equal(Object.values(dual.sides).flat().length, 20, "两边封装也要安置全部引脚");

/* ---------- 栅格封装（BGA）---------- */

/* 4x4 球阵，行标 A-D。JEDEC 跳过 I/O/Q/S/X/Z，所以第 8 行是 H、第 9 行是 J。 */
const bga = {
  partNumber: "SYN-TFBGA16",
  package: "TFBGA16",
  packageGeometry: { shape: "TFBGA", rows: 4, columns: 4 },
  pinCount: 16,
  pins: syntheticPins(16, {
    location: (index) => `${"ABCD"[Math.floor(index / 4)]}${(index % 4) + 1}`,
  }),
};
assert.equal(layoutKindOf(bga), "grid");
const grid = packageLayout(bga);
assert.equal(grid.kind, "grid");
assert.deepEqual(grid.grid, { rows: 4, columns: 4 });

/* 球的身份是 location（"C2"），脚号仍是全局唯一整数——求解器里所有
   Set<number> 的逻辑因此不用改。 */
assert.equal(grid.locationOf(1), "A1");
assert.equal(grid.locationOf(6), "B2");
assert.equal(grid.locationOf(16), "D4");
assert.deepEqual(pinPosition(1, bga), { x: 0, y: 0 }, "A1 = 左上角");
assert.deepEqual(pinPosition(4, bga), { x: 1, y: 0 }, "A4 = 右上角");
assert.deepEqual(pinPosition(13, bga), { x: 0, y: 1 }, "D1 = 左下角");
assert.deepEqual(pinPosition(16, bga), { x: 1, y: 1 }, "D4 = 右下角");

/* 栅格没有"边"，取离哪条边最近。角上的球两条边等距，按 SIDE_ORDER 定序
   取一条即可——方位偏好本来就是软约束，要的是结果稳定、方向大致对。 */
assert.ok(["top", "left"].includes(sideOfPin(1, bga)), "A1 贴着顶边和左边");
assert.ok(["top", "right"].includes(sideOfPin(4, bga)), "A4 贴着顶边和右边");
assert.ok(["bottom", "left"].includes(sideOfPin(13, bga)), "D1 贴着底边和左边");
/* 非角上的球方向必须唯一 */
const wide = packageLayout({ package: "BGA", packageGeometry: { shape: "BGA", rows: 3, columns: 9 }, pinCount: 27, pins: syntheticPins(27) });
assert.equal(wide.sideOf(10), "left", "第二行第一列离左边最近");
assert.equal(wide.sideOf(18), "right", "第二行末列离右边最近");
assert.equal(wide.sideOf(5), "top", "第一行中间离顶边最近");
assert.equal(wide.sideOf(23), "bottom", "末行中间离底边最近");
for (const pin of bga.pins) {
  assert.ok(availableSides(bga).includes(sideOfPin(pin.number, bga)));
}
const balls = grid.rows.flatMap((row) => row.cells).filter(Boolean);
assert.equal(balls.length, 16, "每个球都要落进格子");

/* 没写 location 的数据按脚号行优先铺开，坐标仍然自洽——
   不能因为缺一个可选字段就算出 NaN。 */
const bareGrid = packageLayout({ package: "BGA9", packageGeometry: { shape: "BGA", rows: 3, columns: 3 }, pinCount: 9, pins: syntheticPins(9) });
assert.equal(bareGrid.locationOf(5), "B2");
assert.ok(bareGrid.rows.flatMap((row) => row.cells).filter(Boolean).length === 9);

/* ---------- shape 缺省时从 package 字符串推断 ---------- */

assert.equal(layoutKindOf({ package: "LQFP100" }), "quad");
assert.equal(layoutKindOf({ package: "UFQFPN48" }), "quad");
assert.equal(layoutKindOf({ package: "SOIC8" }), "dual");
assert.equal(layoutKindOf({ package: "TFBGA240" }), "grid");
assert.equal(layoutKindOf({ package: "WLCSP81" }), "grid");
assert.equal(layoutKindOf({}), "quad", "什么都没有时退回最常见的四边封装");

console.log("Verified package geometry: quad (100 pins), dual (20 pins), grid (16 balls), and shape inference.");
