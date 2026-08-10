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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CACHE_DIR = path.join(PROJECT_ROOT, ".cache", "mcus");

/* 厂商库的定位和转换器都比较重（要读几百 KB 的 XML/JSON 并 import 求解器），
   而多数会话根本不会用到，所以推迟到第一次请求时再加载。 */
let stm32Lib = null;
let tiLib = null;
let smokeLib = null;
const roots = new Map();

async function loadStm32() {
  if (!stm32Lib) stm32Lib = await import("./lib/stm32.mjs");
  if (!roots.has("st")) roots.set("st", await stm32Lib.resolveDb());
  return { lib: stm32Lib, root: roots.get("st") };
}

async function loadTi() {
  if (!tiLib) tiLib = await import("./lib/ti.mjs");
  if (!roots.has("ti")) roots.set("ti", await tiLib.resolveDeviceData());
  return { lib: tiLib, root: roots.get("ti") };
}

async function convert(query) {
  const { vendor, part, package: packageName } = query;
  if (vendor === "st") {
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

async function handle(request, response, next) {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname !== "/api/mcu") return next();

  const query = Object.fromEntries(url.searchParams);
  const { id, vendor, part } = query;
  if (!id || !vendor || !part) {
    return sendJson(response, 400, { error: "缺少 id / vendor / part" });
  }

  const cacheFile = path.join(CACHE_DIR, `${id}.json`);
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
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile, `${JSON.stringify(device, null, 2)}\n`, "utf8");
    const warnings = await warningsFor(device);
    console.log(`[mcu] ${id} 转换完成 ${Date.now() - started}ms${warnings.length ? ` （${warnings.length} 条提示）` : ""}`);
    return sendJson(response, 200, { device, warnings, cached: false });
  } catch (error) {
    console.warn(`[mcu] ${id} 转换失败：${error.message}`);
    return sendJson(response, 500, { error: error.message });
  }
}

export function mcuOnDemand() {
  const middleware = (request, response, next) => {
    handle(request, response, next).catch((error) => sendJson(response, 500, { error: String(error) }));
  };
  return {
    name: "mcu-on-demand",
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
