/*
  封装几何。唯一的"脚号 → 落在哪条边 / 归一化坐标 / 渲染时排第几个"换算入口。

  以前 allocator.js（打分用）和 App.jsx（画图用）各写了一份，两边都写死
  "四条边、每边 pinCount/4 个脚、脚 1 在左上、逆时针"。加一颗 TSSOP 或 BGA
  就必然有一处先改、另一处忘改——而这两处一旦不一致，求解器算出的"靠右"
  和图上画出来的"右边"就不是同一条边，方位偏好会变成谎话。

  布局按 packageGeometry.shape（缺省时退回 package 字符串）分派：

  - quad  LQFP / QFP / QFN / CSP…  四边周边式，脚 1 左上，逆时针
  - dual  SOIC / TSSOP / SSOP / DIP  两边周边式，左边自上而下、右边自下而上
  - grid  BGA / WLCSP…              栅格式，行取字母、列取数字

  归一化坐标统一到单位正方形，y=0 是顶边、y=1 是底边。求解器只用
  positionOf / sideOf，界面只用 sides（周边式）或 rows（栅格式），
  两者共用同一份换算。

  availableSides 是这颗封装**真正存在**的边。两边封装上没有"顶边"可言，
  界面据此不给出这个选项——而不是给一个永远满足不了的偏好。
*/

export const SIDES = {
  top: { label: "顶边", distance: (position) => position.y },
  right: { label: "右边", distance: (position) => 1 - position.x },
  bottom: { label: "底边", distance: (position) => 1 - position.y },
  left: { label: "左边", distance: (position) => position.x },
};

export const SIDE_ORDER = ["top", "right", "bottom", "left"];

/* JEDEC 的 BGA 行标跳过 I / O / Q / S / X / Z（易与数字或彼此混淆）。 */
const ROW_LETTERS = "ABCDEFGHJKLMNPRTUVWY";

const DUAL_SHAPE = /^(soic|so|sop|tsop|tssop|ssop|msop|dip|pdip|sip)/;
const GRID_SHAPE = /^(bga|.*bga|wlcsp|csp|lga|land)/;

function shapeOf(mcu) {
  return String(mcu?.packageGeometry?.shape || mcu?.package || "lqfp").trim().toLowerCase();
}

export function layoutKindOf(mcu) {
  const shape = shapeOf(mcu);
  if (GRID_SHAPE.test(shape)) return "grid";
  if (DUAL_SHAPE.test(shape)) return "dual";
  return "quad";
}

/* 脚号区间 → 引脚对象，按渲染顺序。缺号（数据里没有这一脚）直接跳过，
   而不是塞 undefined 进去让渲染层去 crash。 */
function pinRange(byNumber, from, to) {
  const step = from <= to ? 1 : -1;
  const list = [];
  for (let number = from; step > 0 ? number <= to : number >= to; number += step) {
    const pin = byNumber.get(number);
    if (pin) list.push(pin);
  }
  return list;
}

/* 四边周边式：脚 1 在左上角，沿左边向下 → 底边向右 → 右边向上 → 顶边向左。 */
function quadLayout(mcu, byNumber) {
  const pinCount = mcu.pinCount || mcu.pins?.length || 4;
  const perSide = Math.max(1, mcu.packageGeometry?.pinsPerSide || Math.round(pinCount / 4));
  const span = Math.max(1, perSide - 1);

  return {
    kind: "perimeter",
    shape: shapeOf(mcu),
    pinsPerSide: perSide,
    availableSides: SIDE_ORDER,
    sides: {
      top: pinRange(byNumber, perSide * 4, perSide * 3 + 1),
      right: pinRange(byNumber, perSide * 3, perSide * 2 + 1),
      bottom: pinRange(byNumber, perSide + 1, perSide * 2),
      left: pinRange(byNumber, 1, perSide),
    },
    sideOf(number) {
      if (number <= perSide) return "left";
      if (number <= perSide * 2) return "bottom";
      if (number <= perSide * 3) return "right";
      return "top";
    },
    positionOf(number) {
      if (number <= perSide) return { x: 0, y: (number - 1) / span };
      if (number <= perSide * 2) return { x: (number - perSide - 1) / span, y: 1 };
      if (number <= perSide * 3) return { x: 1, y: 1 - (number - perSide * 2 - 1) / span };
      return { x: 1 - (number - perSide * 3 - 1) / span, y: 0 };
    },
  };
}

/* 两边周边式：脚 1 在左上角，沿左边向下到底，再从右下角向上回到右上角。 */
function dualLayout(mcu, byNumber) {
  const pinCount = mcu.pinCount || mcu.pins?.length || 2;
  const perSide = Math.max(1, mcu.packageGeometry?.pinsPerSide || Math.ceil(pinCount / 2));
  const span = Math.max(1, perSide - 1);

  return {
    kind: "perimeter",
    shape: shapeOf(mcu),
    pinsPerSide: perSide,
    availableSides: ["left", "right"],
    sides: {
      top: [],
      /* 右边自下而上编号，渲染要自上而下，所以倒着取 */
      right: pinRange(byNumber, perSide * 2, perSide + 1),
      bottom: [],
      left: pinRange(byNumber, 1, perSide),
    },
    sideOf(number) {
      return number <= perSide ? "left" : "right";
    },
    positionOf(number) {
      if (number <= perSide) return { x: 0, y: (number - 1) / span };
      return { x: 1, y: 1 - (number - perSide - 1) / span };
    },
  };
}

/* "E14" / "AB3" → { row, column }，都是 1 基。行标越界（数据里写了 I、O 这种
   JEDEC 不用的字母）就回落到按脚号顺序推算，而不是算出 NaN 坐标。 */
function parseLocation(location, columns) {
  const match = String(location || "").match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;
  const letters = match[1].toUpperCase();
  let row = 0;
  for (const letter of letters) {
    const index = ROW_LETTERS.indexOf(letter);
    if (index < 0) return null;
    row = row * ROW_LETTERS.length + index + 1;
  }
  const column = Number(match[2]);
  if (!Number.isInteger(column) || column < 1 || column > columns) return null;
  return { row, column };
}

function rowLabel(row) {
  const index = row - 1;
  if (index < ROW_LETTERS.length) return ROW_LETTERS[index];
  const high = Math.floor(index / ROW_LETTERS.length) - 1;
  return `${ROW_LETTERS[high]}${ROW_LETTERS[index % ROW_LETTERS.length]}`;
}

/*
  栅格式（BGA / WLCSP）。

  球的身份是 `pin.location`（"E14"）而不是脚号——但脚号仍然是全局唯一的整数
  序号，求解器里所有 Set<number> 的逻辑因此不用改。没有 location 的数据按
  脚号行优先铺开，至少坐标是自洽的。
*/
function gridLayout(mcu, byNumber) {
  const pins = mcu.pins || [];
  const pinCount = mcu.pinCount || pins.length || 1;
  const columns = Math.max(1, mcu.packageGeometry?.columns || Math.ceil(Math.sqrt(pinCount)));
  const rowCount = Math.max(1, mcu.packageGeometry?.rows || Math.ceil(pinCount / columns));
  const spanX = Math.max(1, columns - 1);
  const spanY = Math.max(1, rowCount - 1);

  const cellOf = new Map();
  for (const pin of pins) {
    const parsed = parseLocation(pin.location, columns)
      || { row: Math.floor((pin.number - 1) / columns) + 1, column: ((pin.number - 1) % columns) + 1 };
    cellOf.set(pin.number, parsed);
  }

  const rows = Array.from({ length: rowCount }, (_, index) => ({
    label: rowLabel(index + 1),
    cells: Array.from({ length: columns }, () => null),
  }));
  for (const pin of pins) {
    const cell = cellOf.get(pin.number);
    const row = rows[cell.row - 1];
    if (row) row.cells[cell.column - 1] = pin;
  }

  function positionOf(number) {
    const cell = cellOf.get(number);
    if (!cell) return { x: 0.5, y: 0.5 };
    return { x: (cell.column - 1) / spanX, y: (cell.row - 1) / spanY };
  }

  return {
    kind: "grid",
    shape: shapeOf(mcu),
    grid: { rows: rowCount, columns },
    rows,
    availableSides: SIDE_ORDER,
    /* 栅格没有"边"，取离哪条边最近——中心区的球哪条边都算不上贴边，
       方位偏好在 BGA 上本来就只是"往这个方向靠"，这与它作为软约束的定位一致。 */
    sideOf(number) {
      const { x, y } = positionOf(number);
      const distances = { left: x, right: 1 - x, top: y, bottom: 1 - y };
      return SIDE_ORDER.reduce((best, side) => (distances[side] < distances[best] ? side : best), "top");
    },
    positionOf,
    locationOf(number) {
      const cell = cellOf.get(number);
      return cell ? `${rowLabel(cell.row)}${cell.column}` : String(number);
    },
  };
}

/* 布局只依赖器件数据，算一次缓存住——求解器每评一个候选组就要问几十次坐标。 */
const LAYOUT_CACHE = new WeakMap();

export function packageLayout(mcu) {
  if (!mcu || typeof mcu !== "object") return quadLayout({ pinCount: 4 }, new Map());
  const cached = LAYOUT_CACHE.get(mcu);
  if (cached) return cached;

  const byNumber = new Map((mcu.pins || []).map((pin) => [pin.number, pin]));
  const kind = layoutKindOf(mcu);
  const layout = kind === "grid" ? gridLayout(mcu, byNumber)
    : kind === "dual" ? dualLayout(mcu, byNumber)
      : quadLayout(mcu, byNumber);
  LAYOUT_CACHE.set(mcu, layout);
  return layout;
}

export function sideOfPin(number, mcu) {
  return packageLayout(mcu).sideOf(number);
}

export function pinPosition(number, mcu) {
  return packageLayout(mcu).positionOf(number);
}

/* 这颗封装上能提供的方位选项。界面用它过滤下拉，求解器用它判断
   一个方位偏好是否根本无从满足。 */
export function availableSides(mcu) {
  return packageLayout(mcu).availableSides;
}
