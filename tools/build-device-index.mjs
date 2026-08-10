/*
  扫描本机的厂商器件库，生成"可选器件索引" src/data/deviceIndex.json。

  用法：npm run mcu:catalog

  ── 为什么要索引，而不是把器件数据全打包进来 ──────────────────────
  CubeMX 库里约 2300 个 STM32 型号，SysConfig 里约 475 个 TI 型号 ×
  1077 个 (型号,封装) 组合。单颗器件的引脚数据平均 60 KB，全打包约 200 MB——
  仓库和首屏都受不了。

  所以只索引**选择器需要的元数据**：型号、系列、封装、脚数、内核。3400 项约
  270 KB，gzip 后 ~50 KB。引脚数据在用户选中某颗时才现场转换（见
  tools/vite-mcu-server.mjs），转完缓存落盘，用过的器件就永久可用。

  ── 索引项不等于"已经能用" ────────────────────────────────────────
  索引是从厂商库的**文件名和元数据**推出来的，没有真正跑过转换。个别器件可能
  在转换时才暴露问题（封装形态判断不出来、信号命名对不上）。界面在加载失败时
  要如实报错，而不是假装这颗片子不存在。

  ── 脚数为什么能不打开文件就知道 ──────────────────────────────────
  两家的封装名里都编了脚数：STM32 的 Package 属性是 "LQFP100"，TI 的封装键是
  "LQFP-64(PM)"。所以 STM32 只需读每个 XML 的头几行（正则取属性，不做完整
  解析），TI 只需读 gpns.json 一个文件。全量扫描几秒就够。
*/
import { readdir, readFile, writeFile, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDb } from "./lib/stm32.mjs";
import { resolveDeviceData } from "./lib/ti.mjs";

const OUT_FILE = fileURLToPath(new URL("../src/data/deviceIndex.json", import.meta.url));

/* RefName 里的括号是短横分隔的**枚举**（库里存在 (G-E) 这种顺序颠倒的写法，
   按范围解释会漏掉一半）。末尾的 x 是温度/质量等级占位符。 */
function expandRefName(refName) {
  const expand = (prefix, rest) => {
    const open = rest.indexOf("(");
    if (open === -1) return [prefix + rest];
    const close = rest.indexOf(")", open);
    const head = prefix + rest.slice(0, open);
    return rest.slice(open + 1, close).split("-")
      .flatMap((option) => expand(head + option, rest.slice(close + 1)));
  };
  return expand("", refName);
}

/* 只读文件开头：<Mcu ...> 属性和 <Core>/<IONb> 都在前几行，没必要解析整份 XML。 */
async function readHead(file, bytes = 2048) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function scanStm32(db) {
  const dir = path.join(db, "mcu");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".xml"));
  const entries = [];
  for (const file of files) {
    const head = await readHead(path.join(dir, file));
    const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(head)?.[1] || "";
    const tag = (name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(head)?.[1] || "";
    const packageName = attr("Package");
    if (!packageName) continue;
    const pinCount = Number(/(\d+)/.exec(packageName)?.[1] || 0);
    const refName = file.replace(/\.xml$/, "");
    for (const part of expandRefName(refName)) {
      entries.push({
        vendor: "st",
        part,
        series: attr("Line") || attr("Family"),
        family: attr("Family"),
        package: packageName,
        pinCount,
        core: tag("Core").replace(/^Arm /, "ARM "),
      });
    }
  }
  return entries;
}

async function scanTi(deviceDataDir) {
  const gpns = JSON.parse(await readFile(path.join(deviceDataDir, "gpns.json"), "utf8"));
  const entries = [];
  for (const [part, info] of Object.entries(gpns)) {
    if (info.isPublic === false) continue;
    for (const [packageName, variants] of Object.entries(info.packages || {})) {
      const family = Object.values(variants)[0]?.legacyDevice;
      if (!family) continue;
      entries.push({
        vendor: "ti",
        part,
        /* TI 一个型号有多种封装，(型号,封装) 才唯一，所以封装要进 id */
        package: packageName,
        pinCount: Number(/-(\d+)\(/.exec(packageName)?.[1] || 0),
        series: family,
        family,
        core: "",
      });
    }
  }
  return entries;
}

/* 与两个导入器生成的 device.id 必须一致，否则选中之后对不上缓存。 */
function idOf(entry) {
  if (entry.vendor === "st") return `st-${entry.part.toLowerCase()}-${entry.package.toLowerCase()}`;
  const match = /^([A-Z]+)-(\d+)\(([^)]+)\)$/.exec(entry.package);
  const shape = (match?.[1] || entry.package).toLowerCase();
  const code = match?.[3] ? `-${match[3].toLowerCase()}` : "";
  return `ti-${entry.part.toLowerCase()}-${shape}${entry.pinCount}${code}`;
}

const sources = [];
let entries = [];

try {
  const db = await resolveDb();
  const found = await scanStm32(db);
  entries.push(...found);
  sources.push({ vendor: "st", root: db, count: found.length });
  console.log(`STM32   ${found.length} 个型号  ←  ${db}`);
} catch (error) {
  console.warn(`STM32   跳过：${error.message.split("\n")[0]}`);
}

try {
  const dir = await resolveDeviceData();
  const found = await scanTi(dir);
  entries.push(...found);
  sources.push({ vendor: "ti", root: dir, count: found.length });
  console.log(`TI      ${found.length} 个 (型号,封装) 组合  ←  ${dir}`);
} catch (error) {
  console.warn(`TI      跳过：${error.message.split("\n")[0]}`);
}

if (entries.length === 0) {
  console.error("两家的器件库都没找到，索引不会有任何内容。");
  process.exit(1);
}

/* 同一个 id 出现两次说明 id 规则撞了，选中后会取到错的那颗 */
const seen = new Set();
entries = entries.map((entry) => ({ id: idOf(entry), ...entry })).filter((entry) => {
  if (seen.has(entry.id)) return false;
  seen.add(entry.id);
  return true;
}).sort((left, right) => left.id.localeCompare(right.id));

const index = {
  generatedAt: new Date().toISOString().slice(0, 10),
  sources,
  devices: entries,
};

await writeFile(OUT_FILE, `${JSON.stringify(index)}\n`, "utf8");
const bytes = (await readFile(OUT_FILE)).length;
console.log(`\n已写入 ${path.relative(process.cwd(), OUT_FILE)}：${entries.length} 项，${(bytes / 1024).toFixed(0)} KB`);
console.log("引脚数据不在索引里——选中某颗时由本地服务器现场转换并缓存。");
