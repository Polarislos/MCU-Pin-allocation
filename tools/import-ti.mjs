/*
  CLI：从 TI SysConfig 器件库导出引脚数据。

  转换逻辑全在 tools/lib/ti.mjs——同一份代码也被 tools/vite-mcu-server.mjs 用来
  响应界面里的"按需加载器件"，所以这里只做参数解析、写盘和诊断输出。

    node tools/import-ti.mjs --part MSPM0G3519                       （列出封装）
    node tools/import-ti.mjs --part MSPM0G3519 --package "LQFP-64(PM)"
*/
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importTi, packagesOf, resolveDeviceData } from "./lib/ti.mjs";
import { reportSmokeSolve } from "./lib/smoke.mjs";
import { packageLayout } from "../src/lib/package.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--dry-run") args.dryRun = true;
    else if (item === "--part") args.part = argv[++index];
    else if (item === "--package") args.package = argv[++index];
    else if (item === "--sysconfig") args.sysconfig = argv[++index];
    else if (item === "--out") args.out = argv[++index];
    else if (item === "--core") args.core = argv[++index];
    else if (item === "--family") args.family = argv[++index];
    else if (item === "--ui-profile") args.uiProfile = argv[++index];
    else throw new Error(`不认识的参数：${item}`);
  }
  if (!args.part) throw new Error("必须给 --part，例如 --part MSPM0G3519");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const deviceDataDir = await resolveDeviceData(args.sysconfig);

if (!args.package) {
  const { partKey, packages } = await packagesOf(deviceDataDir, args.part);
  const names = Object.keys(packages);
  console.log(`${partKey} 有 ${names.length} 种封装，用 --package 指定其中一种：`);
  for (const name of names) console.log(`  --package "${name}"`);
  process.exit(0);
}

const outPath = args.out
  ? path.resolve(args.out)
  : path.join(PROJECT_ROOT, "src", "data", "mcus", `${args.part.toLowerCase()}.json`);
const previous = existsSync(outPath) ? JSON.parse(await readFile(outPath, "utf8")) : null;

const { device, stats, core, family } = await importTi({
  deviceDataDir,
  part: args.part,
  packageName: args.package,
  uiProfile: args.uiProfile,
  core: args.core,
  family: args.family,
  previous,
});

const gpioCount = device.pins.filter((pin) => pin.kind === "gpio").length;
console.log(`器件族     ${family}（SysConfig ${device.source.revision}）`);
console.log(`封装       ${device.package}  ${device.pinCount} 脚`);
console.log(`GPIO       ${gpioCount}`);
console.log(`复用功能   ${stats.functions} 条（mode ≥ 2）`);
console.log(`模拟/特殊  ${stats.analog} 条（mode 0）`);
if (previous?.electrical) console.log("沿用旧文件 electrical（5V 白名单）");
if (!core) console.warn(`⚠ 认不出 ${device.partNumber} 的内核，core 字段留空——用 --core 补上`);

/* 几何自检：某个脚落不进布局就意味着它在封装图上画不出来、也算不了方位。
   TSSOP-20 被当成四边封装时正是这样丢掉一半的脚，而且不报任何错。 */
const layout = packageLayout(device);
const placed = layout.kind === "grid"
  ? layout.rows.flatMap((row) => row.cells).filter(Boolean).length
  : Object.values(layout.sides).flat().length;
if (placed !== device.pins.length) {
  console.warn(`⚠ 布局只安置了 ${placed} / ${device.pins.length} 个脚——packageGeometry 判断有误`);
} else {
  console.log(`布局       ${layout.kind}，${placed} 个脚全部安置`);
}

if (args.dryRun) {
  console.log("\n--dry-run，未写盘。前 2 个 GPIO：");
  console.log(JSON.stringify(device.pins.filter((pin) => pin.kind === "gpio").slice(0, 2), null, 2));
} else {
  await writeFile(outPath, `${JSON.stringify(device, null, 2)}\n`, "utf8");
  console.log(`\n已写入 ${path.relative(PROJECT_ROOT, outPath)}`);
}

await reportSmokeSolve(device);
console.log("\n下一步：npm run mcu:index，并在 tests/fixtures/ 留下人工核对过的锚点。");
