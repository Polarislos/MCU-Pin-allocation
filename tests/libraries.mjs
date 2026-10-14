/*
  器件库设置：/api/libraries 与选择器的可用性判断。

  用临时目录伪造 CubeMX（含 mcu/ 的 db 目录）和 SysConfig（含 gpns.json 的
  deviceData）的目录形状，不依赖本机装了什么——CI 上两样都没有。
*/
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMcuMiddleware } from "../tools/vite-mcu-server.mjs";
import { deviceAvailability } from "../src/lib/mcuCatalog.js";

const root = mkdtempSync(path.join(tmpdir(), "mcu-libraries-"));
const cubeMxInstall = path.join(root, "STM32CubeMX");
mkdirSync(path.join(cubeMxInstall, "db", "mcu"), { recursive: true });
const tiBase = path.join(root, "ti");
for (const version of ["sysconfig_1.9.0", "sysconfig_1.28.0"]) {
  mkdirSync(path.join(tiBase, version, "dist", "deviceData"), { recursive: true });
  writeFileSync(path.join(tiBase, version, "dist", "deviceData", "gpns.json"), "{}");
}
const settingsFile = path.join(root, "settings", "libraries.json");

const middleware = createMcuMiddleware({ cacheDir: path.join(root, "cache"), settingsFile });
const server = createServer((request, response) => middleware(request, response, () => {
  response.statusCode = 404;
  response.end();
}));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/api/libraries`;
const post = (body, headers = { "Content-Type": "application/json" }) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

try {
  const initial = await (await fetch(url)).json();
  assert.deepEqual(initial.bundledPrefixes, ["STM32C5"]);
  assert.ok("ok" in initial.st && "ok" in initial.ti, "两家厂商都要有检测结果");

  /* 非 JSON 请求一律拒绝：跨站页面能发 text/plain 而不触发预检 */
  assert.equal((await post({ st: cubeMxInstall }, { "Content-Type": "text/plain" })).status, 415);

  /* 找不到库的路径不保存 */
  const bad = await post({ st: path.join(root, "nope") });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /找不到 CubeMX 器件库/);
  assert.ok(!existsSync(settingsFile), "失败的设置不能写盘");

  /* 选了上一层目录也认：安装目录 → db，C:/ti → 版本号最大的 sysconfig_* */
  const saved = await post({ st: cubeMxInstall, ti: tiBase });
  assert.equal(saved.status, 200);
  const status = await saved.json();
  assert.equal(status.st.ok, true);
  assert.equal(status.st.configured, path.join(cubeMxInstall, "db"));
  assert.equal(status.ti.ok, true);
  assert.equal(status.ti.configured, path.join(tiBase, "sysconfig_1.28.0"), "按数字比较版本号，1.28 > 1.9");
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), {
    st: path.join(cubeMxInstall, "db"),
    ti: path.join(tiBase, "sysconfig_1.28.0"),
  });

  /* 一项失败时整次不生效，另一项也不能被半途改掉 */
  assert.equal((await post({ st: null, ti: path.join(root, "nope") })).status, 400);
  const unchanged = await (await fetch(url)).json();
  assert.equal(unchanged.st.configured, path.join(cubeMxInstall, "db"));

  /* 新实例从设置文件读回 */
  createMcuMiddleware({ cacheDir: path.join(root, "cache"), settingsFile });
  assert.equal((await (await fetch(url)).json()).ti.configured, path.join(tiBase, "sysconfig_1.28.0"));

  /* null = 改回自动检测 */
  const reset = await (await post({ st: null, ti: null })).json();
  assert.equal(reset.st.configured, null);
  assert.equal(reset.ti.configured, null);
} finally {
  server.close();
}

/* ---------- 选择器的可用性 ---------- */

const f407 = { id: "st-stm32f407vgtx-lqfp100", vendor: "st", part: "STM32F407VGTx" };
const c5 = { id: "st-stm32c562vet6-lqfp100", vendor: "st", part: "STM32C562VET6" };
const mspm0 = { id: "ti-mspm0g3507-lqfp64", vendor: "ti", part: "MSPM0G3507" };
const noSt = { server: true, bundledPrefixes: ["STM32C5"], st: { ok: false }, ti: { ok: true } };

assert.equal(deviceAvailability(f407, null).ok, true, "还没检测完时不标灰");
assert.equal(deviceAvailability(f407, noSt).ok, false);
assert.match(deviceAvailability(f407, noSt).reason, /STM32CubeMX/);
assert.equal(deviceAvailability(c5, noSt).ok, true, "随仓库提交的 C5 不依赖 CubeMX");
assert.equal(deviceAvailability(mspm0, noSt).ok, true);
assert.equal(deviceAvailability(c5, { server: false }).ok, false, "静态部署连 C5 也取不到");
assert.equal(deviceAvailability({ id: "st-stm32h743vit6-lqfp100", vendor: "st", part: "STM32H743VIT6" }, { server: false }).ok, true,
  "固化进目录的器件任何时候都可用");

console.log("libraries: status endpoint, path normalization, settings persistence, availability ok");
