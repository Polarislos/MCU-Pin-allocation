/*
  扫描 src/data/mcus/ 生成 index.js（器件清单 + 懒加载入口）。

  为什么要生成而不是用 Vite 的 import.meta.glob 直接扫：tests/ 是拿 node 直接
  跑的，import.meta.glob 是 Vite 专属转换，plain node 里会直接报错。生成一份
  提交进仓库的 index.js，浏览器、Vite、node 三边看到的是同一份清单，
  而且 Vite 能静态分析出每颗片子的 import()，自动切成独立 chunk。

  用法：npm run mcu:index
  校验：npm run mcu:index -- --check   （只比对不写盘，CI / 测试用）

  加一颗片子的流程因此是：把数据文件丢进 src/data/mcus/，跑一次这个脚本。
  清单元数据全部取自数据文件自身，不需要再去别处登记一遍。
*/
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const MCU_DIR = fileURLToPath(new URL("../src/data/mcus/", import.meta.url));
const INDEX_FILE = path.join(MCU_DIR, "index.js");

/* 清单里放什么：够选择器显示和过滤即可。引脚表是懒加载的重头，绝不能进清单。 */
const MANIFEST_FIELDS = [
  "id", "partNumber", "vendor", "family", "core", "package", "packageSize",
  "pinCount", "uiProfile", "signalDialect", "analogConvention", "status",
];

async function loadDevice(file) {
  const url = pathToFileURL(path.join(MCU_DIR, file)).href;
  if (file.endsWith(".json")) return JSON.parse(await readFile(path.join(MCU_DIR, file), "utf8"));
  return (await import(url)).default;
}

function importExpression(file) {
  return file.endsWith(".json")
    ? `import("./${file}", { with: { type: "json" } })`
    : `import("./${file}")`;
}

export async function buildIndexSource() {
  const files = (await readdir(MCU_DIR))
    .filter((file) => file !== "index.js" && (file.endsWith(".json") || file.endsWith(".js")))
    .sort();

  const entries = [];
  for (const file of files) {
    const device = await loadDevice(file);
    const missing = ["id", "partNumber", "package", "pinCount"].filter((field) => !device?.[field]);
    if (missing.length) throw new Error(`${file} 缺少清单必需字段：${missing.join(", ")}`);
    if (entries.some((entry) => entry.device.id === device.id)) {
      throw new Error(`${file} 的 id「${device.id}」与另一份数据重复`);
    }
    entries.push({ file, device });
  }
  entries.sort((left, right) => left.device.id.localeCompare(right.device.id));

  const lines = entries.map(({ file, device }) => {
    const fields = MANIFEST_FIELDS
      .filter((field) => device[field] !== undefined)
      .map((field) => `    ${field}: ${JSON.stringify(device[field])},`);
    return [
      "  {",
      ...fields,
      `    file: ${JSON.stringify(file)},`,
      `    load: () => ${importExpression(file)}.then((module) => module.default),`,
      "  },",
    ].join("\n");
  });

  return [
    "/*",
    "  由 `npm run mcu:index` 从 src/data/mcus/ 生成，请勿手改。",
    "",
    "  清单只放选择器需要的元数据；引脚表通过 load() 按需加载，所以首屏包里",
    "  一颗器件的数据都没有。加片子的流程见 tools/build-mcu-index.mjs。",
    "*/",
    "export const MCU_MANIFEST = [",
    ...lines,
    "];",
    "",
  ].join("\n");
}

const source = await buildIndexSource();
if (process.argv.includes("--check")) {
  const current = await readFile(INDEX_FILE, "utf8").catch(() => "");
  if (current !== source) {
    console.error("src/data/mcus/index.js 与 src/data/mcus/ 的内容不一致，请运行 `npm run mcu:index`");
    process.exit(1);
  }
  console.log("MCU index up to date.");
} else {
  await writeFile(INDEX_FILE, source, "utf8");
  console.log(`Wrote ${path.relative(process.cwd(), INDEX_FILE)}`);
}
