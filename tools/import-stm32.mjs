/*
  CLI：从 STM32CubeMX 器件库导出引脚数据。

  转换逻辑全在 tools/lib/stm32.mjs——同一份代码也被 tools/vite-mcu-server.mjs
  用来响应界面里的"按需加载器件"，所以这里只做参数解析、写盘和诊断输出。

    node tools/import-stm32.mjs --part STM32F103C8T6 --db D:/CubeMX/db
    node tools/import-stm32.mjs --part STM32H743VIT6 --dry-run
*/
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importStm32, resolveDb } from "./lib/stm32.mjs";
import { reportSmokeSolve } from "./lib/smoke.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--dry-run") args.dryRun = true;
    else if (item === "--part") args.part = argv[++index];
    else if (item === "--db") args.db = argv[++index];
    else if (item === "--out") args.out = argv[++index];
    else if (item === "--ui-profile") args.uiProfile = argv[++index];
    else throw new Error(`不认识的参数：${item}`);
  }
  if (!args.part) throw new Error("必须给 --part，例如 --part STM32F103C8T6");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const db = await resolveDb(args.db);

const outPath = args.out
  ? path.resolve(args.out)
  : path.join(PROJECT_ROOT, "src", "data", "mcus", `${args.part.toLowerCase()}.json`);

/* 已有产物里的 ioStructure / electrical 要沿用，不能被重新导入冲掉 */
const previous = existsSync(outPath) ? JSON.parse(await readFile(outPath, "utf8")) : null;

const { device, stats, remapPlan, ioCount, deviceFile, gpioFile, carried } = await importStm32({
  db, part: args.part, uiProfile: args.uiProfile, previous,
});

const gpioCount = device.pins.filter((pin) => pin.kind === "gpio").length;
const functionCount = device.pins.reduce((sum, pin) => sum + pin.functions.length, 0);

console.log(`器件文件   ${path.relative(db, deviceFile)}`);
console.log(`AF 文件    ${path.relative(db, gpioFile)}`);
console.log(`封装       ${device.package}  ${device.pinCount} 脚`);
console.log(`GPIO       ${gpioCount}${ioCount ? `（库声明 ${ioCount}）` : ""}`);
console.log(`复用功能   ${functionCount} 条`);
console.log(`afGrouping ${device.afGrouping || "pin"}`);
if (device.afGrouping === "instance") {
  console.log(`重映射     ${remapPlan.size} 个外设，丢弃 ${stats.droppedRemapGroups} 档（本封装无可用脚）`);
  for (const [instance, plan] of [...remapPlan].sort()) {
    console.log(`             ${instance}: 库 [${plan.order.join(",")}] → 组 [${plan.order.map((_, i) => i).join(",")}]`);
  }
  console.log(`固定脚外设 ${stats.fixedPinFunctions} 条功能（GPIO IP 未列出，归入组 0）`);
  console.log(`推断补全   ${stats.inferredFunctions} 条（库里没登记、但该档下没挪窝的信号）`);
}
if (carried) console.log(`沿用旧文件 ${carried} 个 ioStructure${device.electrical ? " + electrical" : ""}`);
if (ioCount && gpioCount !== ioCount) {
  console.warn(`⚠ GPIO 数与库声明的 IONb 不一致（${gpioCount} vs ${ioCount}），请核对`);
}

if (args.dryRun) {
  console.log("\n--dry-run，未写盘。前 3 个 GPIO：");
  console.log(JSON.stringify(device.pins.filter((pin) => pin.kind === "gpio").slice(0, 3), null, 2));
} else {
  await writeFile(outPath, `${JSON.stringify(device, null, 2)}\n`, "utf8");
  console.log(`\n已写入 ${path.relative(PROJECT_ROOT, outPath)}`);
}

await reportSmokeSolve(device);

if (device.electrical) {
  console.log("\n下一步：npm run mcu:index，并确认 tests/fixtures/ 里的锚点仍然成立。");
} else {
  console.log(
    "\n⚠ 还差 5V 耐压白名单：CubeMX 库里没有 FT / TTa / TC 信息，需要查 datasheet 的\n"
    + "  引脚定义表，手工补 electrical.fiveVoltTolerantIoStructures 和每个脚的\n"
    + "  ioStructure。补之前界面会隐藏 5V 开关（安全降级，不会误判成不耐压）。\n"
    + "  补好之后再次运行本脚本会自动沿用，不会被覆盖。\n"
    + "  之后跑 npm run mcu:index，并在 tests/fixtures/ 留下人工核对过的锚点。",
  );
}
