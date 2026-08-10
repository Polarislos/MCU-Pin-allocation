/*
  嘉立创EDA 专业版「扇出网络标签/非连接标识」的表格填充。

  ── 为什么是"填表"而不是"造表" ──────────────────────────────────────
  EDA 的流程是：选中器件 → 右键 → 扇出网络标签 → 在表格里改 → 导出/导入。
  导出的模板里 pinName 是**符号自己的**写法（VSS_1、PC13-TAMPER-RTC），
  和数据手册名对不上；我们从零造一份就得赌它认哪种写法。在它导出的模板上
  只改 netname 一列，引脚由 EDA 自己认，我们不参与匹配，也就不会错。

  而且模板里有 pinNumber，所以对应关系是按**脚号**建立的，不比名字——
  比名字的那套（扩展里的 nameMatches）在这里根本用不上。

  ── 文件格式（官方没公开，从实际导出的文件反推）────────────────────
  文件名叫 .csv，但它不是逗号分隔：

    编码    UTF-16 LE，带 BOM（fffe）
    分隔符  制表符 \t
    行尾    LF
    表头    designator symbolId pinNumber pinRotation pinName netname
            wireOrBusLength noConnect
    末尾    有一个空行

  这就是社区里"用 WPS 另存成 csv 就报『导入CSV文件格式异常』"的原因——
  存成逗号分隔的 ANSI/UTF-8 就不认了。所以写回去必须原样照抄这套约定，
  除了 netname 一列，其余字节尽量不动。
*/

import { buildNetLabels, designatorOf } from "./export.js";

/* 少一列都不行：designator 用来认是哪个器件，pinNumber 用来对脚，
   netname 是我们唯一要写的。其余列（symbolId / pinRotation / pinName /
   wireOrBusLength / noConnect）原样带回去，不读也不改。 */
const REQUIRED_COLUMNS = ["designator", "pinNumber", "netname"];

export const DEFAULT_POWER_NETS = { ground: "GND", supply: "+3V3" };

/*
  EDA 导出的是 UTF-16 LE。但用户很可能拿 Excel/WPS 打开过再存一遍，
  那就变成 UTF-8 或带 BOM 的 UTF-8 了——能读就读，别让人卡在编码上。
  回写一律用 UTF-16 LE（见 encodeFanoutFile），跟 EDA 自己导出的一致。
*/
export function decodeFanoutFile(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return new TextDecoder().decode(bytes.subarray(3));
  return new TextDecoder().decode(bytes);
}

/* 逐个 UTF-16 码元写小端。用 TextEncoder 不行——它只出 UTF-8。 */
export function encodeFanoutFile(text) {
  const withBom = `\uFEFF${text}`;
  const bytes = new Uint8Array(withBom.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < withBom.length; index += 1) {
    view.setUint16(index * 2, withBom.charCodeAt(index), true);
  }
  return bytes;
}

export function parseFanout(text) {
  const body = text.replace(/^\uFEFF/, "");
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  /* EDA 导出的文件末尾有个空行。记下来，回写时原样补上。 */
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();
  const header = (lines.shift() ?? "").split("\t").map((name) => name.trim());
  return { header, rows: lines.map((line) => line.split("\t")), eol, trailingNewline };
}

function serializeFanout({ header, rows, eol, trailingNewline }) {
  const width = header.length;
  const lines = [header.join("\t")];
  for (const row of rows) {
    /* 补齐到表头宽度：EDA 对列数敏感，少一列就是"格式异常"。 */
    const padded = row.length >= width ? row.slice(0, width) : [...row, ...Array(width - row.length).fill("")];
    lines.push(padded.join("\t"));
  }
  return lines.join(eol) + (trailingNewline ? eol : "");
}

/*
  引脚名比对。和扩展里的 nameMatches 是同一套规则（tools/lceda-extension
  src/index.ts），那边比对的是符号引脚，这边比对的是扇出表格里的 pinName，
  来源其实是同一个符号。两处实现要一起改。

  归一化把分隔符压成 "/" 而不是删掉：删掉就丢了词的边界，VSS_1 会变成 VSS1，
  和 PA15 这种"编号是名字自身一部分"的写法再也分不开。
*/
function normalizePinName(name) {
  return String(name || "").toUpperCase().replace(/[^A-Z0-9]+/g, "/").replace(/^\/+|\/+$/g, "");
}

/* full 是不是 base 加了后缀？只认两种：从分隔符开始的（PA5 → PA5/SPI1_SCK、
   VSS → VSS_1），和紧跟在字母后的纯数字（VDD → VDD2）。后者要求 base 以字母
   结尾，这样 PA1 不会匹配上 PA15。 */
function extendsPinName(full, base) {
  if (!full.startsWith(base)) return false;
  const rest = full.slice(base.length);
  if (rest.startsWith("/")) return true;
  return /[A-Z]$/.test(base) && /^\d+$/.test(rest);
}

export function pinNameMatches(symbolPinName, planPinName) {
  const symbol = normalizePinName(symbolPinName);
  const plan = normalizePinName(planPinName);
  if (!plan || symbol === plan) return true;
  return extendsPinName(symbol, plan) || extendsPinName(plan, symbol);
}

/*
  确认这张表和方案说的是同一颗片子。

  光看脚号是不够的：扇出表格是用户选中某个器件导出的，选错了（比如选到一颗
  20 脚的芯片）脚号 1..20 照样落在 48 脚方案的范围里，于是我们会给它填一整套
  张冠李戴的网络名，而且看不出来——这就是"导进去了但错位"的那类事故。
  只有比名字才认得出来。

  不按"一个都不能错"来卡：库里零星几个脚写法不同是常态（这也是引脚核对那边
  让人工确认后忽略的情形）。整片对不上才是选错了器件。
*/
const IDENTITY_MISMATCH_LIMIT = 0.2;

function assertSameDevice(rows, columns, pinByDesignator, target) {
  const checked = [];
  for (const row of rows) {
    if ((row[columns.designator] || "").trim() !== target) continue;
    const pin = pinByDesignator.get((row[columns.pinNumber] || "").trim());
    if (!pin || columns.pinName === undefined) continue;
    checked.push([row[columns.pinName], pin.name]);
  }
  const mismatched = checked.filter(([symbolName, planName]) => !pinNameMatches(symbolName, planName));
  if (checked.length === 0 || mismatched.length <= checked.length * IDENTITY_MISMATCH_LIMIT) {
    return mismatched.map(([symbolName, planName]) => `${symbolName}≠${planName}`);
  }
  throw new Error(`表格里的 ${target} 和方案不是同一颗片子：`
    + `核对的 ${checked.length} 个脚里有 ${mismatched.length} 个名字对不上`
    + `（例如 ${mismatched.slice(0, 3).map(([a, b]) => `脚名「${a}」应为「${b}」`).join("、")}）。`
    + `请确认扇出表格导出时选中的是这颗 MCU。`);
}

/*
  电源脚不在求解结果里（它们不参与分配），但扇出的时候一样要打标签，
  否则整片电源引脚都是空的，还得在 EDA 的表格里手填九次。

  按数据手册的引脚名判断，不按符号名——符号名可能是 VSS_1、VSS_3 这种
  带序号的写法。VREF+/VCAP 这类没有通用叫法的不猜，留空并在 warnings 里点名。
*/
function powerNetOf(pin, nets) {
  const name = String(pin.name || "").toUpperCase();
  if (name.startsWith("VSS") || name === "GND") return nets.ground;
  if (name.startsWith("VDD") || name === "VBAT") return nets.supply;
  return null;
}

/*
  挑出表格里要填的那个器件。

  用户可能一次选中好几个器件再扇出，表里就会有多个位号。这时只动脚数和方案
  对得上的那一个，其余器件的行**一个字都不改**——它们不是这份方案的一部分，
  清空它们的 netname 会把用户已有的连接抹掉。
*/
function resolveTarget(rows, columns, mcu) {
  const counts = new Map();
  for (const row of rows) {
    const key = (row[columns.designator] || "").trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const designators = [...counts.keys()];
  if (designators.length === 1) return designators[0];
  const matching = designators.filter((key) => counts.get(key) === mcu.pinCount);
  if (matching.length === 1) return matching[0];
  throw new Error(matching.length === 0
    ? `表格里有 ${designators.length} 个器件（${designators.join("、")}），没有一个的脚数是 ${mcu.pinCount}。`
      + `请只选中目标 MCU 再导出一次扇出表格。`
    : `表格里有多个器件的脚数都是 ${mcu.pinCount}（${matching.join("、")}），分不出该填哪个。`
      + `请只选中目标 MCU 再导出一次扇出表格。`);
}

/*
  把方案填进模板，返回新文件内容和一份"填了什么"的统计。

  没有分配到功能的脚会被**清空** netname。这一步不能省：EDA 导出的模板里
  netname 预填的就是 pinName，原样导回去会凭空生出 48 个叫 PB9、VSS_3 的
  网络，每个还带一根导线。
*/
export function fillFanout(templateText, mcu, solution, options = {}) {
  const powerNets = { ...DEFAULT_POWER_NETS, ...options.powerNets };
  const fillPower = options.fillPower !== false;

  const table = parseFanout(templateText);
  const columns = {};
  table.header.forEach((name, index) => { columns[name] = index; });
  const missing = REQUIRED_COLUMNS.filter((name) => columns[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`这不像是扇出网络标签导出的文件：表头缺少 ${missing.join("、")} 列。`
      + `请在 EDA 里选中 MCU → 右键 → 扇出网络标签/非连接标识 → 导出，用它导出的那份。`);
  }

  const target = resolveTarget(table.rows, columns, mcu);
  const { labels, warnings } = buildNetLabels(solution);
  const netByDesignator = new Map(labels.map((label) => [label.designator, label.net]));
  const pinByDesignator = new Map(mcu.pins.map((pin) => [designatorOf(pin), pin]));

  const oddNames = assertSameDevice(table.rows, columns, pinByDesignator, target);
  if (oddNames.length > 0) {
    warnings.push(`这些脚在符号上的名字和数据手册不一样，已按脚号填（一般只是库里写法不同）：${oddNames.join("、")}`);
  }

  /* 多 part 符号（电源一个 part、GPIO 另一个）扇出时一次只出一个 part 的脚。
     这不是错，但得说出来，否则用户以为一次就填全了。 */
  const targetRows = table.rows.filter((row) => (row[columns.designator] || "").trim() === target).length;
  if (targetRows !== mcu.pinCount) {
    warnings.push(`表格里 ${target} 只有 ${targetRows} 行，方案是 ${mcu.pinCount} 脚。`
      + `如果这颗符号被拆成了多个 part，每个 part 都要各扇出、各填一次。`);
  }

  const stats = { signal: 0, power: 0, cleared: 0, untouched: 0 };
  const unknownPins = [];
  const unnamedPower = [];

  for (const row of table.rows) {
    if ((row[columns.designator] || "").trim() !== target) { stats.untouched += 1; continue; }
    const designator = (row[columns.pinNumber] || "").trim();
    const net = netByDesignator.get(designator);
    if (net) {
      row[columns.netname] = net;
      stats.signal += 1;
      continue;
    }
    const pin = pinByDesignator.get(designator);
    if (!pin) {
      /* 脚号在方案里根本不存在——多半选错了器件，或者符号的编号规则和
         数据手册不同。清空是错的（可能抹掉用户已有的网络），留着并报出来。 */
      unknownPins.push(designator);
      stats.untouched += 1;
      continue;
    }
    if (fillPower && pin.kind === "supply") {
      const powerNet = powerNetOf(pin, powerNets);
      if (powerNet) {
        row[columns.netname] = powerNet;
        stats.power += 1;
        continue;
      }
      unnamedPower.push(`${designator} ${pin.name}`);
    }
    row[columns.netname] = "";
    stats.cleared += 1;
  }

  if (unknownPins.length > 0) {
    warnings.push(`表格里有 ${unknownPins.length} 个脚号不在方案里（${unknownPins.slice(0, 8).join("、")}`
      + `${unknownPins.length > 8 ? " …" : ""}），这些行没动。多半是选错了器件。`);
  }
  if (unnamedPower.length > 0) {
    warnings.push(`这些电源脚没有通用的网络名，留空了，请在 EDA 的表格里手填：${unnamedPower.join("、")}`);
  }

  return { text: serializeFanout(table), designator: target, stats, warnings };
}

export function fanoutFileName(mcu) {
  return `${mcu.partNumber}-fanout-netlabel.csv`;
}
