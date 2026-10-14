/*
  MCU 目录边界。

  清单（src/data/mcus/index.js）由 `npm run mcu:index` 从 src/data/mcus/ 扫描
  生成，元数据取自数据文件自身——加一颗片子只要把数据文件丢进那个目录再跑一次
  脚本，这里不用改。

  引脚表**懒加载**：H743 一颗就 5000 多行，静态 import 意味着首屏要下载目录里
  所有片子的全部引脚表。所以清单里只有选择器用得上的元数据，`data` 要等
  ensureMcuLoaded() 之后才有值。

  同步取值（`record.data`、`getMcuById(id).data`）仍然可用，但只对**已加载**的
  片子有效，未加载时返回 null 而不是抛错——调用方该做的是先 await
  ensureMcuLoaded()，而不是让页面白屏。
*/
import { MCU_MANIFEST } from "../data/mcus/index.js";

const loaded = new Map();
const inflight = new Map();

export { MCU_MANIFEST };

export const MCU_CATALOG = MCU_MANIFEST.map((entry) => ({
  ...entry,
  get data() {
    return loaded.get(entry.id) || null;
  },
}));

/*
  首屏默认器件。写死 id 而不是取 MCU_CATALOG[0]：清单是按 id 字母序生成的，
  取第一个意味着**每加一颗字母序更靠前的片子，应用的默认器件就会悄悄改变**
  （加 F103 时就把默认从 H743 顶掉过一次）。默认器件该是一个有意的选择。
  这颗片子从目录里删掉时会退回第一个，不至于开不了页面。
*/
const PREFERRED_DEFAULT_MCU_ID = "st-stm32h743vit6-lqfp100";

export const DEFAULT_MCU_ID = MCU_CATALOG.some((item) => item.id === PREFERRED_DEFAULT_MCU_ID)
  ? PREFERRED_DEFAULT_MCU_ID
  : MCU_CATALOG[0].id;

/*
  按需器件。

  MCU_CATALOG 是**固化进仓库**的那几颗（src/data/mcus/），首屏就能用、离线可用、
  被 npm test 的不变量覆盖。除此之外，选择器还能从 src/data/deviceIndex.json 里
  挑另外三千多颗——那些的引脚数据不在包里，选中时由本地服务器的 /api/mcu 现场
  从 CubeMX / SysConfig 库转换（见 tools/vite-mcu-server.mjs）。

  转换回来的器件登记在这里，此后与固化器件走同一条路径：getMcuById、
  ensureMcuLoaded、工程文件的 mcuId 都不用区分二者。
*/
const runtime = new Map();

export function registerMcu(record, data) {
  /* 固化目录项通过 getter 暴露 data；按需器件也必须保持同一形状。
     否则切换到运行时 MCU 后 App 会拿到 undefined.pins，React 整页卸载，
     用户看到的就是“加载很久后白屏”。 */
  const runtimeRecord = {
    ...record,
    get data() {
      return loaded.get(record.id) || null;
    },
  };
  runtime.set(record.id, runtimeRecord);
  if (data) loaded.set(record.id, data);
  return runtimeRecord;
}

export function isRuntimeMcu(id) {
  return runtime.has(id);
}

/* 固化的 + 本次会话按需取回的。选择器列固化那批，其余走搜索。 */
export function knownMcus() {
  return [...MCU_CATALOG, ...runtime.values()];
}

export function getMcuById(id) {
  return MCU_CATALOG.find((item) => item.id === id)
    || runtime.get(id)
    || MCU_CATALOG[0];
}

export function isMcuLoaded(id) {
  return loaded.has(id);
}

/*
  本机厂商库的检测结果（见 tools/vite-mcu-server.mjs 的 /api/libraries）。

  从 Releases 装桌面版的人多半没装 CubeMX / SysConfig，选择器里三千多颗绝大部分
  转换不出来。与其让人点进详情、按下"用于引脚规划"才看到报错，不如在列表里
  就标出来，并指到设置入口。

  返回 { server: false } = 没有本地服务（静态部署），按需器件全部不可用。
*/
export async function fetchLibraryStatus() {
  try {
    const response = await fetch("/api/libraries");
    if (!response.ok) return { server: false };
    return { server: true, ...(await response.json()) };
  } catch {
    return { server: false };
  }
}

/* patch: { st?: string|null, ti?: string|null }。失败时抛出服务端给的原因。 */
export async function saveLibraryPaths(patch) {
  const response = await fetch("/api/libraries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `保存失败（HTTP ${response.status}）`);
  return { server: true, ...payload };
}

export const LIBRARY_NAMES = { st: "STM32CubeMX", ti: "TI SysConfig" };

/* 这颗片子在本机能不能取到引脚数据。status 还没取回来时一律当作可用——
   宁可点了再报错，也不要在检测完成前把整页都标成灰色。 */
export function deviceAvailability(device, status) {
  if (loaded.has(device.id) || MCU_CATALOG.some((item) => item.id === device.id)) return { ok: true };
  if (!status) return { ok: true };
  if (!status.server) return { ok: false, reason: "当前部署没有本地服务，只能使用内置型号" };
  if (status.bundledPrefixes?.some((prefix) => device.part?.toUpperCase().startsWith(prefix))) return { ok: true };
  if (status[device.vendor]?.ok) return { ok: true };
  return { ok: false, reason: `本机未找到 ${LIBRARY_NAMES[device.vendor] || device.vendor} 器件库`, vendor: device.vendor };
}

/*
  从本地服务器取一颗按需器件。

  失败原因必须原样透出：本机没装 CubeMX、这颗片子的封装形态转换不出来、
  或者根本是静态部署（接口不存在）——三种情况的处理方式完全不同，糊成
  "加载失败"会让人无从下手。
*/
export async function fetchRuntimeMcu(entry) {
  const query = new URLSearchParams({
    id: entry.id, vendor: entry.vendor, part: entry.part, package: entry.package || "",
  });
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    response = await fetch(`/api/mcu?${query}`, { signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("器件转换超过 60 秒，可能是 CubeMX / SysConfig 库未响应");
    }
    throw new Error("连不上本地服务器的器件转换接口——按需加载只在本机运行时可用");
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 404) {
    throw new Error("当前部署没有器件转换接口（/api/mcu），只能使用已固化进目录的器件");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `器件转换失败（HTTP ${response.status}）`);

  /* 型号以索引里的写法为准：旧版转换器会把占位符 x 大写成 X（STM32F407VGTX），
     .cache 里存着的那些不会自己变回来。同一型号只是大小写不同时用 entry.part。 */
  if (entry.part && payload.device.partNumber?.toUpperCase() === entry.part.toUpperCase()) {
    payload.device.partNumber = entry.part;
  }
  const record = {
    id: payload.device.id,
    partNumber: payload.device.partNumber,
    vendor: payload.device.vendor,
    family: payload.device.family,
    core: payload.device.core,
    package: payload.device.package,
    pinCount: payload.device.pinCount,
    uiProfile: payload.device.uiProfile,
    signalDialect: payload.device.signalDialect,
    analogConvention: payload.device.analogConvention,
    status: payload.device.status,
    runtime: true,
  };
  const runtimeRecord = registerMcu(record, payload.device);
  return { record: runtimeRecord, data: payload.device, warnings: payload.warnings || [], cached: payload.cached };
}

/* Vite 开发服务器会把 .json?import 转成 JavaScript 模块，
   但清单里的 Node 兼容写法带有 JSON import attributes，浏览器会因此
   按 JSON MIME 解析这份 JS 响应并报动态导入失败。开发模式直接取原始
   JSON；生产构建仍使用 entry.load() 生成的独立 chunk。 */
function loadEntry(entry) {
  if (typeof window !== "undefined" && import.meta.env?.DEV && entry.file?.endsWith(".json")) {
    return fetch(`/src/data/mcus/${entry.file}`).then((response) => {
      if (!response.ok) throw new Error(`MCU 数据加载失败：${response.status}`);
      return response.json();
    });
  }
  return entry.load();
}

/* 并发调用同一个 id 只发一次请求——切片子时按键连点不该触发多次下载。 */
export async function ensureMcuLoaded(id) {
  /* 按需器件的数据在 fetchRuntimeMcu() 里就已经登记好了，没有 load() 可走 */
  if (loaded.has(id)) return loaded.get(id);
  if (runtime.has(id)) throw new Error(`${id} 的引脚数据还没取回来`);
  const entry = MCU_MANIFEST.find((item) => item.id === id) || MCU_MANIFEST[0];
  if (loaded.has(entry.id)) return loaded.get(entry.id);
  if (!inflight.has(entry.id)) {
    inflight.set(entry.id, loadEntry(entry).then((data) => {
      loaded.set(entry.id, data);
      inflight.delete(entry.id);
      return data;
    }, (error) => {
      inflight.delete(entry.id);
      throw error;
    }));
  }
  return inflight.get(entry.id);
}

export function catalogLabel(item) {
  return `${item.partNumber} · ${item.package}`;
}
