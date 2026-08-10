/*
  从引脚算出"这根标签导线该画在哪"。

  ── 官方文档没说清的两件事 ──────────────────────────────────────────
  引脚有 x / y / rotation / pinLength 四个几何属性，但文档没说：

    ① (x, y) 是引脚的**连接点**（远离符号本体那一端），还是**根部**（贴着
       符号边框那一端）？两者相差一个 pinLength。
    ② rotation = 0 时引脚朝 +x 还是 -x？

  猜错的后果不是"画不出来"，而是**导线画在了离引脚一格远的地方**——看着像连上了，
  实际没有电气连接，或者更糟：连到了隔壁那个脚上。这正是"导进去了但错位一格"
  那类事故，画完板子才发现。

  ── 所以这里不猜，只留一个二选一 ────────────────────────────────────
  ② 根本不用猜：引脚一定是**朝符号外面**长的，所以方向取"从所有引脚的重心指向
  这个引脚"在引脚轴上的投影。这对任何形状的符号都成立，比解释 rotation 的语义
  可靠得多。

  剩下 ① 是一个布尔量。它由 applyPinPlan 的"先画一根让你看一眼"来定，答案存进
  sys_Storage，之后就不再问。一次校准，永久生效。
*/

export type PinOrigin = "tip" | "root";

export interface SymbolPin {
  designator: string;
  name: string;
  x: number;
  y: number;
  rotation: number;
  pinLength: number;
}

export interface Point {
  x: number;
  y: number;
}

/* 坐标是浮点数，直接 === 比不得。栅格最小也在 1 以上，取 0.01 足够宽松又不会
   把相邻栅格点混为一谈。 */
const EPSILON = 0.01;

export function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
}

export function readPin(pin: {
  getState_PinNumber: () => string;
  getState_PinName: () => string;
  getState_X: () => number;
  getState_Y: () => number;
  getState_Rotation: () => number;
  getState_PinLength: () => number;
}): SymbolPin {
  return {
    designator: String(pin.getState_PinNumber() ?? "").trim(),
    name: String(pin.getState_PinName() ?? ""),
    x: pin.getState_X(),
    y: pin.getState_Y(),
    rotation: pin.getState_Rotation(),
    pinLength: pin.getState_PinLength(),
  };
}

export function centroidOf(pins: SymbolPin[]): Point {
  if (pins.length === 0) return { x: 0, y: 0 };
  let sumX = 0;
  let sumY = 0;
  for (const pin of pins) {
    sumX += pin.x;
    sumY += pin.y;
  }
  return { x: sumX / pins.length, y: sumY / pins.length };
}

/*
  引脚朝外的单位方向。

  轴向（横还是竖）取自 rotation——这一半文档是可信的，0/180 是水平、90/270 是
  竖直，而且就算把两者搞反了，下面的重心判断也只会得到一个"沿错误轴"的方向，
  在试画那一步一眼就能看出来。

  正负号取自重心：引脚总是朝符号外面长的。落在重心同一坐标上（理论上不该发生，
  比如只有一个引脚的符号）时取正向兜底。
*/
export function outwardOf(pin: SymbolPin, centroid: Point): Point {
  const rotation = ((Math.round(pin.rotation) % 360) + 360) % 360;
  const horizontal = rotation === 0 || rotation === 180;
  if (horizontal) {
    return { x: pin.x >= centroid.x ? 1 : -1, y: 0 };
  }
  return { x: 0, y: pin.y >= centroid.y ? 1 : -1 };
}

/*
  引脚的连接点——导线必须**正好**落在这个点上才算连上。

  origin === "tip"   (x, y) 就是连接点
  origin === "root"  (x, y) 是根部，连接点在朝外 pinLength 处
*/
export function connectionPointOf(pin: SymbolPin, centroid: Point, origin: PinOrigin): Point {
  if (origin === "tip") return { x: pin.x, y: pin.y };
  const outward = outwardOf(pin, centroid);
  return {
    x: pin.x + outward.x * pin.pinLength,
    y: pin.y + outward.y * pin.pinLength,
  };
}

/*
  标签导线的两个端点：从连接点朝外拉一段。

  ── 段长为什么是 pinLength 的整数倍 ─────────────────────────────────
  导线端点没落在栅格上，连接就不成立。而当前图页的栅格设置是文档里没写清的
  另一件事（问不到），所以这里不去猜绝对尺寸，改用 pinLength 当步长——符号库
  里的引脚一律是照栅格画的，它的整数倍必然还在栅格上。

  倍数由用户定（菜单「设置标签长度」，存在 sys_Storage）：太短了网络名挤在
  符号边上看不清，太长了占版面。**必须是整数**，取 1.5 倍这种就会掉出栅格。
*/
export const DEFAULT_LENGTH_MULTIPLE = 3;

export function stubOf(
  pin: SymbolPin,
  centroid: Point,
  origin: PinOrigin,
  multiple: number = DEFAULT_LENGTH_MULTIPLE,
): number[] {
  const start = connectionPointOf(pin, centroid, origin);
  const outward = outwardOf(pin, centroid);
  const unit = pin.pinLength > 0 ? pin.pinLength : 10;
  const length = unit * normalizeLengthMultiple(multiple);
  return [start.x, start.y, start.x + outward.x * length, start.y + outward.y * length];
}

/*
  存进 sys_Storage 的值可能是任何东西（没写过、旧版本写的、用户手改过的配置，
  以及输入框回传的字符串）。取整并夹到 1..20：0 会画出零长度导线（create 直接
  失败），非整数会让端点掉出栅格——那是"画上了但没连上"，不报错、最难发现。

  "没设置过"必须单独判，不能交给 Number()：Number(null) 和 Number("") 都是 0，
  会被夹成 1 倍，于是默认值悄悄退回最短的那一档。
*/
export function normalizeLengthMultiple(multiple: unknown): number {
  if (multiple === null || multiple === undefined || multiple === "") {
    return DEFAULT_LENGTH_MULTIPLE;
  }
  const value = Math.round(Number(multiple));
  if (!Number.isFinite(value)) return DEFAULT_LENGTH_MULTIPLE;
  return Math.min(20, Math.max(1, value));
}

/* 导线的 line 可能是 number[] 也可能是 number[][]（多段线）。端点判断只关心
   所有折点，拍平成点列表即可。 */
export function pointsOfLine(line: Array<number> | Array<Array<number>>): Point[] {
  const flat: number[] = Array.isArray(line[0])
    ? (line as number[][]).flat()
    : (line as number[]);
  const points: Point[] = [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    points.push({ x: flat[index], y: flat[index + 1] });
  }
  return points;
}
