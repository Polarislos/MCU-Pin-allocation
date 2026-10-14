/*
  按需器件转换：本地服务器上的 /api/mcu 接口。

  选择器里能选的器件有 3300 多个（见 tools/build-device-index.mjs），引脚数据
  不可能全打包进来。所以索引里只有元数据，用户选中某颗时由这个接口现场把厂商
  库转成 src/data/mcu.schema.json 的格式返回。

  ── 这是本地工具，不是公网服务 ──────────────────────────────────────
  接口只在本机的开发/预览服务器上存在（127.0.0.1:4173），它读的是本机装的
  CubeMX / SysConfig 器件库。把 dist/ 静态部署到别的机器时这个接口不存在，
  界面会退化成只能用已固化进 src/data/mcus/ 的那几颗——这一点要在界面上讲清楚，
  而不是让人对着一个永远转圈的下拉框猜。

  ── 缓存 ────────────────────────────────────────────────────────────
  转换结果落到 .cache/mcus/<id>.json（不进版本库）。同一颗片子第二次选中直接
  读缓存，省掉几百毫秒。要把某颗**固化**进目录（让静态构建也带上、并纳入
  npm test 的不变量检查），走 CLI：npm run mcu:import -- --part <型号>。
*/
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
/* 桌面版装在 Program Files 下，工程目录没有写权限，缓存改落到用户数据目录，
   由 electron/main.mjs 通过 createMcuMiddleware({ cacheDir }) 传进来。 */
const DEFAULT_CACHE_DIR = path.join(PROJECT_ROOT, ".cache", "mcus");
const DEFAULT_SETTINGS_FILE = path.join(PROJECT_ROOT, ".cache", "libraries.json");

/* 不依赖本机厂商库、随仓库提交的按需器件（tools/data/cubemx2）。界面据此判断
   没装 CubeMX 时哪些型号仍然可用，所以和 convert() 里的分支共用一份。 */
const BUNDLED_PREFIXES = ["STM32C5"];
const isBundled = (part) => BUNDLED_PREFIXES.some((prefix) => part?.toUpperCase().startsWith(prefix));

/* 厂商库的定位和转换器都比较重（要读几百 KB 的 XML/JSON 并 import 求解器），
   而多数会话根本不会用到，所以推迟到第一次请求时再加载。 */
let stm32Lib = null;
let tiLib = null;
let smokeLib = null;
const roots = new Map();

/*
  用户在界面里指定的库路径（null = 自动检测）。存到 settingsFile，下次启动还在。

  ── 为什么不用环境变量 ─────────────────────────────────────────────
  CUBEMX_DB / SYSCONFIG_HOME 照样认（自动检测的一部分），但从 Releases 装桌面版的
  人不会去设环境变量。库装在非默认位置时，唯一现实的入口是界面里的一个路径框。
*/
const libraryPaths = { st: null, ti: null };

/* 用户选的目录常常比库目录高一两层：选了 STM32CubeMX 安装目录而不是其下的 db，
   选了 C:/ti 而不是 sysconfig_1.x。在这里往下找一层，免得白白报"找不到"。 */
async function normalizeLibraryPath(vendor, input) {
  const base = path.resolve(input.trim());
  if (vendor === "st") {
    for (const candidate of [base, path.join(base, "db")]) {
      if (existsSync(path.join(candidate, "mcu"))) return candidate;
    }
    return base;
  }
  if (existsSync(path.join(base, "gpns.json")) || existsSync(path.join(base, "dist", "deviceData"))) return base;
  const versions = existsSync(base)
    ? (await readdir(base)).filter((name) => name.startsWith("sysconfig_"))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    : [];
  return versions.length ? path.join(base, versions[0]) : base;
}

async function resolveRoot(vendor) {
  if (vendor === "st") {
    if (!stm32Lib) stm32Lib = await import("./lib/stm32.mjs");
    return stm32Lib.resolveDb(libraryPaths.st || undefined);
  }
  if (!tiLib) tiLib = await import("./lib/ti.mjs");
  return tiLib.resolveDeviceData(libraryPaths.ti || undefined);
}

async function loadStm32() {
  if (!roots.has("st")) roots.set("st", await resolveRoot("st"));
  return { lib: stm32Lib, root: roots.get("st") };
}

async function loadTi() {
  if (!roots.has("ti")) roots.set("ti", await resolveRoot("ti"));
  return { lib: tiLib, root: roots.get("ti") };
}

async function libraryStatus() {
  const status = { bundledPrefixes: BUNDLED_PREFIXES };
  for (const vendor of ["st", "ti"]) {
    try {
      status[vendor] = { ok: true, path: await resolveRoot(vendor), configured: libraryPaths[vendor] };
    } catch (error) {
      status[vendor] = { ok: false, path: null, configured: libraryPaths[vendor], error: error.message };
    }
  }
  return status;
}

function loadLibrarySettings(settingsFile) {
  try {
    const stored = JSON.parse(readFileSync(settingsFile, "utf8"));
    for (const vendor of ["st", "ti"]) libraryPaths[vendor] = typeof stored[vendor] === "string" ? stored[vendor] : null;
  } catch {
    /* 没有设置文件就是全部自动检测 */
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/* POST { st?: string|null, ti?: string|null }。字符串 = 指定路径，null = 改回自动检测。
   指定的路径找不到库就拒绝保存，不留一个注定失败的设置。 */
async function updateLibraries(request, response, settingsFile) {
  /* 只收 application/json：跨站页面发不出这种请求而不先过预检，
     而这个服务不回 CORS 头，预检必败——挡掉别的网页偷偷改本机设置。 */
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    return sendJson(response, 415, { error: "需要 application/json" });
  }
  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return sendJson(response, 400, { error: "请求体不是合法 JSON" });
  }
  const next = { ...libraryPaths };
  for (const vendor of ["st", "ti"]) {
    if (!(vendor in body)) continue;
    const value = body[vendor];
    if (value !== null && (typeof value !== "string" || !value.trim())) {
      return sendJson(response, 400, { error: "路径必须是非空字符串或 null" });
    }
    next[vendor] = value === null ? null : await normalizeLibraryPath(vendor, value);
  }
  const previous = { ...libraryPaths };
  Object.assign(libraryPaths, next);
  roots.clear();
  for (const vendor of ["st", "ti"]) {
    if (!(vendor in body) || next[vendor] === null) continue;
    try {
      await resolveRoot(vendor);
    } catch (error) {
      Object.assign(libraryPaths, previous);
      /* 只取第一行"找不到…试过：…"，后面那句"用 --db 指定"是给命令行看的 */
      return sendJson(response, 400, { error: error.message.split("\n")[0], vendor });
    }
  }
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, `${JSON.stringify(libraryPaths, null, 2)}\n`, "utf8");
  return sendJson(response, 200, await libraryStatus());
}

async function convert(query) {
  const { vendor, part, package: packageName } = query;
  if (vendor === "st") {
    if (isBundled(part)) {
      const { loadCubeMx2 } = await import("./lib/cubemx2.mjs");
      return loadCubeMx2(query.id);
    }
    const { lib, root } = await loadStm32();
    const { device } = await lib.importStm32({ db: root, part });
    return device;
  }
  if (vendor === "ti") {
    const { lib, root } = await loadTi();
    if (!packageName) throw new Error("TI 器件必须指定封装");
    const { device } = await lib.importTi({ deviceDataDir: root, part, packageName });
    return device;
  }
  throw new Error(`不支持的厂商：${vendor}`);
}

/*
  转换成功不等于这颗片子在工具里可用——厂商的信号命名与变体表对不上时，
  引脚都在、界面打得开，但每一路需求都无解。把冒烟结果一起返回，界面据此提示，
  而不是让人自己去发现"这颗片子怎么什么都排不出来"。
*/
async function warningsFor(device) {
  if (!smokeLib) smokeLib = await import("./lib/smoke.mjs");
  const { naming, protectionOnly } = smokeLib.smokeSolve(device);
  const warnings = [];
  if (naming.length > 0) {
    warnings.push(`${naming.map((item) => item.type).join(" / ")} 解析出了实例却排不出一路，信号命名可能没对上`);
  }
  if (protectionOnly.length > 0) {
    warnings.push(`${protectionOnly.map((item) => item.type).join(" / ")} 需要关掉调试口/晶振保护才排得出来`);
  }
  return warnings;
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(text);
}

async function handle(request, response, next, { cacheDir, mode, settingsFile }) {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/api/planner-instance") {
    return sendJson(response, 200, { app: "MCU-Planner", root: PROJECT_ROOT, mode });
  }
  if (url.pathname === "/api/libraries") {
    if (request.method === "POST") return updateLibraries(request, response, settingsFile);
    return sendJson(response, 200, await libraryStatus());
  }
  if (url.pathname !== "/api/mcu") return next();

  const query = Object.fromEntries(url.searchParams);
  const { id, vendor, part } = query;
  if (!id || !vendor || !part) {
    return sendJson(response, 400, { error: "缺少 id / vendor / part" });
  }

  const cacheFile = path.join(cacheDir, `${id}.json`);
  if (existsSync(cacheFile)) {
    const device = JSON.parse(await readFile(cacheFile, "utf8"));
    return sendJson(response, 200, { device, warnings: await warningsFor(device), cached: true });
  }

  try {
    const started = Date.now();
    const device = await convert(query);
    if (device.id !== id) {
      /* id 由索引和导入器各算一次，对不上说明两边的规则漂了——不能让界面
         拿着一个 id 存进工程文件、下次却按同一个 id 取到别的片子。 */
      return sendJson(response, 500, {
        error: `索引里的 id「${id}」与转换结果「${device.id}」不一致，请重新生成索引（npm run mcu:catalog）`,
      });
    }
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, `${JSON.stringify(device, null, 2)}\n`, "utf8");
    const warnings = await warningsFor(device);
    console.log(`[mcu] ${id} 转换完成 ${Date.now() - started}ms${warnings.length ? ` （${warnings.length} 条提示）` : ""}`);
    return sendJson(response, 200, { device, warnings, cached: false });
  } catch (error) {
    console.warn(`[mcu] ${id} 转换失败：${error.message}`);
    return sendJson(response, 500, { error: error.message });
  }
}

/* connect 风格的 (req, res, next)，Vite 和桌面版的内置 http 服务共用这一份。 */
export function createMcuMiddleware({ cacheDir = DEFAULT_CACHE_DIR, mode = "source", settingsFile = DEFAULT_SETTINGS_FILE } = {}) {
  loadLibrarySettings(settingsFile);
  return (request, response, next) => {
    handle(request, response, next, { cacheDir, mode, settingsFile }).catch((error) => sendJson(response, 500, { error: String(error) }));
  };
}

export function mcuOnDemand() {
  const middleware = createMcuMiddleware();
  return {
    name: "mcu-on-demand",
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
