import { DEFINITIONS, isFiveVoltTolerant, usesRemapGroups } from "./allocator.js";

function variantLabel(group) {
  return DEFINITIONS[group.type]?.variants?.[group.variant]?.label || "";
}

function typeLabel(group) {
  return DEFINITIONS[group.type]?.label || group.type;
}

/* 模拟通道走的是 additionalFunctions，没有 AF 编号（af === null）。
   四种导出都得显式处理，否则会印出 "AFnull" 这种进了工程才会被发现的脏数据。 */
function isAnalog(item) {
  return item.af == null && !/^GPIO\d+$/.test(item.function || "");
}

/*
  `af` 字段在两类器件上语义不同（见 allocator.js 的 afGroupingOf）：逐脚选择的
  器件上它是 AF 编号，整组重映射的器件（STM32F1）上它是重映射组号。导出面向的是
  照着接线和写初始化代码的人，把 F1 的组号印成 "AF1" 会让人去找根本不存在的
  GPIO_AF1_xxx，所以这一层必须分开措辞。
*/
/*
  组 0 恒为复位默认接法，这一条对所有外设都成立，值得说人话。其余档次不做
  解释：同样是组 1，USART1 上是唯一的那档重映射，TIM2 上却是"部分重映射 1"
  （后面还有 2 和 3）。想当然地写成"部分重映射"对两档的外设就是错的，
  而准确的档位名已经由 remapMacros 里的 HAL 宏名带出去了。
*/
function remapText(group) {
  return group === 0 ? "无重映射" : `重映射组 ${group}`;
}

function afColumnLabel(mcu) {
  return usesRemapGroups(mcu) ? "重映射" : "AF";
}

function afText(mcu, item) {
  if (/^GPIO\d+$/.test(item.function || "")) return "普通 GPIO";
  if (isAnalog(item)) return "模拟";
  if (usesRemapGroups(mcu)) return remapText(item.af);
  return `AF${item.af}`;
}

const PIN_KIND_LABELS = Object.freeze({
  gpio: "GPIO",
  power: "电源",
  reset: "复位",
  special: "特殊",
  supply: "电源",
});

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function pinKindLabel(kind) {
  return PIN_KIND_LABELS[kind] || kind || "未知";
}

function fiveVoltLabel(mcu, pin) {
  if (pin.kind !== "gpio") return "不适用";
  const tolerant = isFiveVoltTolerant(mcu, pin);
  if (tolerant === null) return "未知";
  return tolerant ? "耐 5V" : "仅 3.3V";
}

/*
  完整引脚定义表。它不依赖方案，所以即使还没有点击“生成方案”，也可以把
  当前 MCU 的整份 pinout 交给原理图 / PCB / 固件整理流程。复用功能保留 AF
  编号，附加功能则单独列出，避免把 ADC/DAC 这类不在 functions 里的信息丢掉。
*/
export function toPinDefinitionsCsv(mcu) {
  const rows = [[
    "物理脚", "封装位置", "引脚名", "复位名称", "引脚类型", "I/O类型", "I/O结构",
    "电平耐受", "默认保护", "复用功能", "附加功能", "备注",
  ]];
  const pins = [...(mcu?.pins || [])].sort((left, right) => left.number - right.number);
  for (const pin of pins) {
    const functions = (pin.functions || [])
      .map((item) => `${item.name} (AF${item.af})`)
      .join(" | ");
    rows.push([
      pin.number,
      designatorOf(pin),
      pin.name,
      pin.resetName || "",
      pinKindLabel(pin.kind),
      pin.ioType || "",
      pin.ioStructure || "",
      fiveVoltLabel(mcu, pin),
      (pin.protection || []).join(" | "),
      functions,
      (pin.additionalFunctions || []).join(" | "),
      pin.notes || "",
    ]);
  }
  return `﻿${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

/* 展平成一行一个引脚，四种导出格式共用。按物理脚号排序——
   评审和对着板子核对时都是按脚号找。 */
function flatten(solution) {
  return solution.groups
    .flatMap((group) => group.assignments.map((item) => ({
      type: group.type,
      typeLabel: typeLabel(group),
      variantLabel: variantLabel(group),
      instance: group.instance,
      signal: item.signal,
      function: item.function,
      port: item.pin.name.slice(1, 2),
      bit: item.pin.name.slice(2),
      pin: item.pin,
      af: item.af,
    })))
    .sort((left, right) => left.pin.number - right.pin.number);
}

function header(mcu, title) {
  return [
    `${title}`,
    `器件: ${mcu.partNumber}  封装: ${mcu.package}`,
    `数据源: ${mcu.source.document} Rev ${mcu.source.revision}`,
    `生成时间: ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
  ];
}

export function toCsv(mcu, solution) {
  const rows = [["物理脚", "GPIO", "端口", "用途", "实例", "接线", "信号", "AF功能名", afColumnLabel(mcu)]];
  for (const row of flatten(solution)) {
    rows.push([
      row.pin.number, row.pin.name, `GPIO${row.port}`, row.typeLabel,
      row.instance, row.variantLabel, row.signal, row.function, afText(mcu, row),
    ]);
  }
  const body = rows
    .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
    .join("\r\n");
  return `﻿${body}`;
}

export function toMarkdown(mcu, solution) {
  const lines = header(mcu, `# ${mcu.partNumber} 引脚分配`).map((line, index) => (
    index === 0 ? line : `- ${line}`
  ));
  lines.push("", `| 脚 | GPIO | 用途 | 实例 | 信号 | ${afColumnLabel(mcu)} |`, "| --: | --- | --- | --- | --- | --- |");
  for (const row of flatten(solution)) {
    lines.push(`| ${row.pin.number} | ${row.pin.name} | ${row.typeLabel} | ${row.instance} | ${row.signal} | ${afText(mcu, row)} |`);
  }
  lines.push("", "## 按外设分组", "");
  for (const group of solution.groups) {
    lines.push(`### ${group.instance} — ${typeLabel(group)}${variantLabel(group) ? ` (${variantLabel(group)})` : ""}`);
    /* 重映射是按外设整体切换的，写在组标题下比每行重复一遍更贴近实际操作。 */
    if (usesRemapGroups(mcu) && group.remap != null) {
      const macro = remapMacroFor(mcu, group);
      lines.push(`- 重映射: ${remapText(group.remap)}${macro ? ` — \`${macro}\`` : ""}`);
    }
    for (const item of group.assignments) {
      lines.push(`- \`${item.signal}\` → **${item.pin.name}** (脚 ${item.pin.number}, ${afText(mcu, item)})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/* CubeMX .ioc 片段。这里只写引脚归属相关的键（Signal / GPIO_Label / Locked
   加 Mcu.PinN 索引），它们的语义稳定且能被 CubeMX 直接吃下。时钟树、外设参数、
   中断和 DMA 配置不在此列——所以是"片段"，要合并进已有 .ioc 而不是替代它。 */
export function toIoc(mcu, solution) {
  const rows = flatten(solution);
  const lines = [
    "#MicroXplorer Configuration settings - do not modify",
    ...header(mcu, "STM32 引脚规划器导出片段").map((line) => `# ${line}`),
    "#",
    "# 用法: 把下面的内容合并进已有的 .ioc（同名键覆盖），再用 CubeMX 打开",
    "#       继续配置时钟树 / DMA / NVIC。本片段不含这些配置。",
    "",
  ];
  rows.forEach((row, index) => {
    lines.push(`Mcu.Pin${index}=${row.pin.name}`);
  });
  lines.push(`Mcu.PinsNb=${rows.length}`, "");
  for (const row of rows) {
    lines.push(
      `${row.pin.name}.GPIOParameters=GPIO_Label`,
      `${row.pin.name}.GPIO_Label=${row.function}`,
      `${row.pin.name}.Locked=true`,
      `${row.pin.name}.Signal=${row.function}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function guard(name) {
  return `${name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_H`;
}

/*
  HAL 风格引脚头文件。两种器件写出来的东西不一样，因为 HAL 本身就不一样：

  - 逐脚选 AF 的器件（H7 等）：AF 宏按 GPIO_AF<n>_<外设> 拼，这是
    stm32h7xx_hal_gpio_ex.h 的通行命名。OTG 之类少数外设的宏名带实例序号
    (GPIO_AF10_OTG1_FS)，所以每行都附上原始 AF 编号作为核对依据。
  - 整组重映射的器件（STM32F1）：GPIO_InitTypeDef 上**没有** Alternate 成员，
    写 GPIO_AF<n>_<外设> 是编译不过的。要写的是 AFIO 的重映射宏，且重映射位
    在 AFIO 里，必须先开 AFIO 时钟——漏了这一句是 F1 上极常见的"代码看着对、
    信号却不出来"。宏名由器件数据的 remapMacros 提供（见下）。
*/
function remapMacroFor(mcu, group) {
  if (group.remap == null) return null;
  return mcu.remapMacros?.[group.instance]?.[group.remap] || null;
}

export function toHeader(mcu, solution) {
  const rows = flatten(solution);
  const remapStyle = usesRemapGroups(mcu);
  const ports = [...new Set(rows.map((row) => `GPIO${row.port}`))].sort();
  const guardName = guard(`${mcu.partNumber}_pin_plan`);
  const lines = [
    "/*",
    ...header(mcu, `${mcu.partNumber} 引脚分配`).map((line) => `  ${line}`),
    "",
    ...(remapStyle
      ? [
        "  本器件靠 AFIO 重映射换脚，没有逐脚的 AF 选择器：GPIO_InitTypeDef 上",
        "  没有 Alternate 成员，复用脚按 GPIO_MODE_AF_PP / GPIO_MODE_AF_OD 配置",
        "  （输入类信号如 USART_RX、TIM 输入捕获用 GPIO_MODE_INPUT）。",
        "  每组下面的重映射宏必须在 GPIO 初始化之前调用。",
      ]
      : [
        "  AF 宏名按 GPIO_AF<n>_<外设> 生成，与 stm32h7xx_hal_gpio_ex.h 一致；",
        "  OTG 等外设的实际宏名可能带实例序号，请以行尾注释里的 AF 编号为准。",
      ]),
    "*/",
    `#ifndef ${guardName}`,
    `#define ${guardName}`,
    "",
    `/* 需要使能的 GPIO 时钟: ${ports.join(", ")} */`,
    ...ports.map((port) => `/*   __HAL_RCC_${port}_CLK_ENABLE(); */`),
    /* 只要用了重映射就得开 AFIO 时钟；即使全都是"无重映射"组，AFIO 时钟对
       调试口重映射和 EXTI 配置仍是必须的，所以无条件提示。 */
    ...(remapStyle ? ["/*   __HAL_RCC_AFIO_CLK_ENABLE();   ← 重映射位在 AFIO 里，不能漏 */"] : []),
    "",
  ];

  const width = Math.max(...rows.map((row) => row.function.length)) + 12;
  for (const group of solution.groups) {
    lines.push(`/* ${group.instance} — ${typeLabel(group)}${variantLabel(group) ? ` (${variantLabel(group)})` : ""} */`);
    if (remapStyle && group.remap != null) {
      const macro = remapMacroFor(mcu, group);
      if (macro) lines.push(`/*   ${macro};  ${remapText(group.remap)} */`);
      /* 组 0 是复位默认接法，本来就没有要调用的宏——这不是"数据缺失"。 */
      else if (group.remap === 0) lines.push("/*   复位默认接法，无需调用重映射宏 */");
      else lines.push(`/*   ${remapText(group.remap)}：请查 stm32f1xx_hal_gpio_ex.h 的 __HAL_AFIO_REMAP_${group.instance}_* */`);
    }
    for (const item of group.assignments) {
      const base = item.function;
      const port = item.pin.name.slice(1, 2);
      const bit = item.pin.name.slice(2);
      lines.push(
        `#define ${`${base}_Pin`.padEnd(width)}GPIO_PIN_${bit}`,
        `#define ${`${base}_GPIO_Port`.padEnd(width)}GPIO${port}`,
      );
       /* 模拟脚不走复用功能，配成 GPIO_MODE_ANALOG 即可，没有 AF 宏可写。 */
       if (isAnalog(item)) lines.push(`/* ${base}: GPIO_MODE_ANALOG, 无复用功能 */`);
       else if (/^GPIO\d+$/.test(base)) lines.push(`/* ${base}: 普通 GPIO，请按实际方向配置 */`);
       else if (!remapStyle) lines.push(`#define ${`${base}_AF`.padEnd(width)}GPIO_AF${item.af}_${group.instance}  /* AF${item.af} */`);
    }
    lines.push("");
  }
  lines.push(`#endif /* ${guardName} */`, "");
  return lines.join("\n");
}

/*
  ── 网络标签清单（给 EDA 扩展吃的）────────────────────────────────────

  和另外四种导出不同，这个格式的读者是**程序**不是人：嘉立创EDA 之类的
  原理图工具靠它在 MCU 符号上批量放网络标签。人要看表格请用 CSV，那边的
  「AF功能名」列就是这里的 net。

  ── 为什么带上整份 pinout ────────────────────────────────────────────
  最危险的失败不是"导不进去"，是**导进去了但错位一格**——画完板子才发现。
  所以这里把全部引脚（不只是被分配的那些）连同脚号和名字一起交出去，让
  消费方在写入任何东西之前先拿它和符号核对：脚数对不对、第 23 脚是不是
  真的叫 PA5。核不上就该拒绝执行，而不是"尽力而为"地打一半标签。

  ── designator 而不是 number ─────────────────────────────────────────
  栅格封装（BGA/WLCSP）上，球的身份是 location（"E14"），pin.number 只是
  求解器内部用的连续序号（见 mcu.schema.json 对 number 的说明）。EDA 符号上
  的引脚编号写的是球号，所以对外必须交 location；四边封装没有 location，
  退回脚号。用错这个，BGA 上会整片错位。
*/
export function designatorOf(pin) {
  return String(pin.location || pin.number);
}

/* 网络名要能直接当标识符用。真实数据里确实有带 / 和 - 的功能名
   （JTMS-SWDIO、RTC_OUT/RTC_TAMP1/RTC_TS/WKUP4），不清理会生成非法网络名。
   斜杠分隔的是"同一个脚的多个别名"，取第一个即可。 */
function netNameOf(functionName) {
  return functionName.split("/")[0].replaceAll(/[^A-Za-z0-9_]/g, "_");
}

/*
  从方案算出"每个脚该打什么网络名"。抽成独立函数是因为有两个消费方——
  toNetLabels 的 JSON 和 fanout.js 的扇出表格。两边必须得到**同一套**名字：
  下面那段重名改名的逻辑要是各写一份，迟早分叉成"JSON 里叫 SPI1_SCK_PA5、
  表格里叫 SPI1_SCK"，而重名在原理图上就是静默短接。
*/
export function buildNetLabels(solution) {
  const warnings = [];
  const used = new Map();
  const labels = flatten(solution).map((row) => {
    const raw = row.function;
    let net = netNameOf(raw);
    if (net !== raw) warnings.push(`${row.pin.name}: 网络名由「${raw}」规整为「${net}」`);
    /* 同名网络在原理图上就是同一根线——两个脚重名等于被静默短接。
       宁可给个带后缀的丑名字，也不能让它悄悄发生。 */
    const seen = used.get(net);
    if (seen) {
      const unique = `${net}_${row.pin.name}`;
      warnings.push(`${row.pin.name}: 网络名「${net}」与 ${seen} 重复，改用「${unique}」`);
      net = unique;
    }
    used.set(net, row.pin.name);
    return {
      designator: designatorOf(row.pin),
      gpio: row.pin.name,
      net,
      peripheral: row.instance,
      signal: row.signal,
      type: row.type,
      af: row.af,
    };
  });
  return { labels, warnings };
}

export function toNetLabels(mcu, solution) {
  const { labels, warnings } = buildNetLabels(solution);

  return `${JSON.stringify({
    format: "pinplan-netlabels",
    version: 1,
    generatedAt: new Date().toISOString(),
    device: {
      partNumber: mcu.partNumber,
      package: mcu.package,
      packageSize: mcu.packageSize,
      pinCount: mcu.pinCount,
      source: `${mcu.source.document} Rev ${mcu.source.revision}`,
    },
    /* 核对用的完整引脚表，含电源和特殊脚——它们不打标签，但要参与脚位比对 */
    pinout: mcu.pins.map((pin) => ({
      designator: designatorOf(pin),
      name: pin.name,
      kind: pin.kind,
    })),
    labels,
    warnings,
  }, null, 2)}\n`;
}

/*
  needsTemplate 的那一项不是"渲染一个文件"，是"往用户给的文件里填一列"——
  它要先问 EDA 要一份扇出表格模板，所以没有 render，由 App 单独处理。
  放在同一个列表里是为了让它出现在同一个「导出」下拉里；下拉之外的地方
  拿 render 之前都得先判空。
*/
export const EXPORT_FORMATS = [
  { id: "csv", label: "CSV", extension: "csv", mime: "text/csv;charset=utf-8", render: toCsv },
  { id: "netlabels", label: "EDA 网络标签 (JSON)", extension: "netlabels.json", mime: "application/json;charset=utf-8", render: toNetLabels },
  { id: "fanout", label: "嘉立创 扇出网络标签 (CSV)", extension: "csv", mime: "text/csv", needsTemplate: true },
  { id: "ioc", label: "CubeMX .ioc 片段", extension: "ioc", mime: "text/plain;charset=utf-8", render: toIoc },
  { id: "header", label: "HAL 引脚头文件", extension: "h", mime: "text/plain;charset=utf-8", render: toHeader },
  { id: "markdown", label: "Markdown 评审表", extension: "md", mime: "text/markdown;charset=utf-8", render: toMarkdown },
];

export function downloadSolution(mcu, solution, formatId) {
  const format = EXPORT_FORMATS.find((item) => item.id === formatId);
  if (!format?.render) return;
  const blob = new Blob([format.render(mcu, solution)], { type: format.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${mcu.partNumber}-pin-plan.${format.extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadPinDefinitions(mcu) {
  const blob = new Blob([toPinDefinitionsCsv(mcu)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${mcu.partNumber}-pin-definitions.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
