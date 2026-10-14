/*
  器件索引搜索：型号/系列/封装关键词 + 外设条件。

  索引由 tools/build-device-index.mjs 生成。外设摘要在 index.peripherals 里：
    profiles[i]   "SDMMC1:356 SDMMC2:74 TIM1:383 ..."（实例[=类型]:信号集下标）
    signalSets[j] "CK CMD D0 D1 D2 D3"（本封装引得出的信号，去掉实例前缀）
  条目的 pf 指向 profiles。没有 pf 的条目（目前是全部 TI）是**外设数据未收录**，
  不能当作"不支持"：有外设条件时它们不进结果，但要单独计数告诉用户。

  ── 三个判断层次 ──────────────────────────────────────────────────
  type / instance / group 条件只回答"厂商数据库里有这个外设"。搜到 FMC 不等于
  这个封装能接 SDRAM（H743 的 LQFP100 就没引出 SDCLK 和 A0–A15）。
  usage 条件（SD 4 位、FMC SDRAM…，定义在 peripheralUsage.js）再检查"所需信号
  在这个封装里都有候选脚"。两个用途的脚能否同时分配成功，仍要交给求解器。

  ── 名称 ──────────────────────────────────────────────────────────
  严格条件按厂商名称匹配：FMC 只匹配 FMC，不匹配 FSMC。想跨名称找同一类
  用途时用"用途"条件（SD 卡接口 = SDMMC 或 SDIO），结果里仍显示各自的名称。
*/

import {
  USAGES, checkUsage, compactSignals, defaultParams, normalizeParams, parseUsage, usageById, usageCovers,
} from "./peripheralUsage.js";
import { CAPABILITIES, capabilityById, matchCapability } from "./capabilities.js";

/* 外设分组：跨厂商命名的同类外设，只判断存在。keywords 用于中文/口语提示。
   SDRAM、NAND、RMII 这类具体用途的词归 peripheralUsage.js，不放在这里——
   否则"SDRAM"会被解析成"有 FMC 或 FSMC"，而 FSMC 根本不支持 SDRAM。 */
/* 分组里同时列 ST 和 TI 的类型名：TI 的 CAN FD 叫 MCAN、SPI 在 TM4C/CC26 上叫
   SSI、串口在 C2000 上叫 SCI。严格搜 FDCAN 只出 ST，按"CAN 总线"分组两家都出。 */
export const PERIPHERAL_GROUPS = [
  { id: "sd-card", label: "SD 卡接口", types: ["SDMMC", "SDIO", "MMC", "MMCSD", "SD"], keywords: ["SD", "SD卡", "TF", "TF卡", "存储卡"] },
  { id: "ext-memory", label: "外部存储器接口", types: ["FMC", "FSMC", "EMIF", "GPMC", "EPI", "XINTF"], keywords: ["外部存储", "外部总线"] },
  { id: "spi-flash", label: "四线/八线 Flash 接口", types: ["QUADSPI", "OCTOSPI", "XSPI", "HSPI", "QSPI", "OSPI", "HYPERBUS"], keywords: ["外部FLASH", "八线"] },
  { id: "camera", label: "摄像头接口", types: ["DCMI", "DCMIPP", "PSSI", "CSI", "VPFE", "CAM"], keywords: ["摄像头", "相机", "CAMERA"] },
  { id: "display", label: "显示接口", types: ["LTDC", "DSIHOST", "LCD", "LCDC", "DSS", "DSI", "HDMI", "OLDI", "DP"], keywords: ["显示", "屏幕", "MIPI"] },
  { id: "ethernet", label: "以太网", types: ["ETH", "CPSW", "EMAC", "RMII", "MII", "RGMII", "ETHERNET"], keywords: ["以太网", "网口", "ETHERNET"] },
  { id: "usb", label: "USB", types: ["USB", "USB_OTG_FS", "USB_OTG_HS", "USB_DRD_FS", "USBH_HS", "UCPD"], keywords: ["USB", "OTG"] },
  { id: "can", label: "CAN 总线", types: ["CAN", "FDCAN", "MCAN", "DCAN", "ECAN", "CANFD"], keywords: ["CAN总线", "CANFD"] },
  { id: "serial", label: "串口", types: ["USART", "UART", "LPUART", "SCI", "SERIAL"], keywords: ["串口", "SERIAL"] },
  { id: "spi-bus", label: "SPI 总线", types: ["SPI", "SSI", "MCSPI", "MIBSPI"], keywords: ["SPI总线"] },
  { id: "watchdog", label: "看门狗", types: ["IWDG", "WWDG"], keywords: ["看门狗", "超时复位"] },
  { id: "timer", label: "定时器", types: ["TIM", "LPTIM", "HRTIM", "GPTIMER", "GPTM", "TIMER", "WTIMER", "DMTIMER", "GPT", "BTIMER", "LGPT"], keywords: ["定时器"] },
  { id: "pwm", label: "PWM 发生器", types: ["TIM", "HRTIM", "EPWM", "EHRPWM", "PWM", "MCPWM"], keywords: ["电机PWM", "PWM输出"] },
  { id: "audio", label: "音频接口", types: ["SAI", "I2S", "SPDIFRX", "MCASP", "MCBSP", "PDM"], keywords: ["音频", "AUDIO"] },
];

/* 常见外设的中文提示，只用于候选列表的说明文字和中文检索。 */
const TYPE_HINTS = {
  ADC: "模数转换", DAC: "数模转换", COMP: "比较器", OPAMP: "运放", TIM: "定时器", LPTIM: "低功耗定时器",
  HRTIM: "高分辨率定时器", SPI: "SPI", I2C: "I2C", I3C: "I3C", I2S: "I2S 音频", SAI: "音频接口", USART: "串口",
  UART: "串口", LPUART: "低功耗串口", CAN: "CAN", FDCAN: "CAN FD", SDMMC: "SD/SDIO/MMC 卡接口",
  SDIO: "SD/SDIO 卡接口", FMC: "外部存储器控制器", FSMC: "外部静态存储器控制器", QUADSPI: "四线 SPI Flash",
  OCTOSPI: "八线 SPI Flash", XSPI: "扩展 SPI Flash", HSPI: "十六线 SPI Flash", DCMI: "摄像头接口",
  DCMIPP: "摄像头接口（带流水线）", PSSI: "并行同步从接口", LTDC: "RGB 屏控制器", DSIHOST: "MIPI DSI 屏",
  LCD: "段码屏驱动", DMA2D: "图形加速", JPEG: "JPEG 编解码", ETH: "以太网 MAC", USB: "USB 全速",
  USB_OTG_FS: "USB OTG 全速", USB_OTG_HS: "USB OTG 高速", USB_DRD_FS: "USB 双角色全速", UCPD: "USB PD",
  RNG: "随机数", AES: "AES 加密", HASH: "哈希", CRYP: "加密", PKA: "公钥加速", CRC: "CRC 校验",
  RTC: "实时时钟", IWDG: "独立看门狗", WWDG: "窗口看门狗", DFSDM: "Σ-Δ 滤波器", MDF: "数字滤波器",
  SDADC: "Σ-Δ ADC", TSC: "触摸感应", SPDIFRX: "S/PDIF 接收", HDMI_CEC: "HDMI CEC", SWPMI: "单线协议",
  MDIOS: "MDIO 从机", GPU2D: "2D GPU", SUBGHZ: "Sub-GHz 射频", RF: "射频",
  /* TI */
  MCAN: "CAN FD（TI）", DCAN: "CAN（TI）", ECAN: "增强 CAN（C2000）", SSI: "SPI（TI SSI）", SCI: "串口（C2000 SCI）",
  MCSPI: "多通道 SPI", GPTIMER: "通用定时器（MSPM0）", GPTM: "通用定时器", WTIMER: "宽定时器", EPWM: "增强 PWM",
  EHRPWM: "高分辨率 PWM", ECAP: "增强捕获", EQEP: "正交编码器", QEI: "正交编码器", OA: "运放", GPAMP: "通用运放",
  CMPSS: "比较器子系统", MMC: "SD/MMC 卡接口", MMCSD: "SD/MMC 卡接口", EMIF: "外部存储器接口", GPMC: "通用存储器控制器",
  MCASP: "多通道音频串口", MCBSP: "多通道缓冲串口", CPSW: "以太网交换", LCDC: "LCD 控制器", SDFM: "Σ-Δ 滤波器",
  MATHACL: "数学加速器", TRNG: "随机数", SD: "SD 卡接口（TI CC3500）", SDFM: "Σ-Δ 滤波（C2000）",
};

export const PAGE_SIZE = 50;

/* ── 索引解码 ───────────────────────────────────────────────────── */

const decoded = new WeakMap();

/* 解出一份档案：[{ name, type, signals: [...] }]。按需解，结果缓存在 index 上。 */
export function profileOf(index, device) {
  if (device?.pf == null || !index?.peripherals) return null;
  let cache = decoded.get(index);
  if (!cache) {
    cache = new Map();
    decoded.set(index, cache);
  }
  if (!cache.has(device.pf)) {
    const { profiles, signalSets } = index.peripherals;
    const instances = profiles[device.pf].split(" ").filter(Boolean).map((token) => {
      const colon = token.lastIndexOf(":");
      const label = token.slice(0, colon);
      const [name, explicitType] = label.split("=");
      /* "83+HSPHY"：信号集下标后面跟实例级能力标记（见 build-device-index.mjs） */
      const [setIndex, ...features] = token.slice(colon + 1).split("+");
      const set = signalSets[Number(setIndex)] || "";
      return {
        name,
        type: explicitType || name.replace(/\d+$/, ""),
        signals: set ? set.split(" ") : [],
        features,
      };
    });
    cache.set(device.pf, instances);
  }
  return cache.get(device.pf);
}

/*
  索引的结构版本。第一版只有型号元数据（没有 peripherals 字段）；本仓库提交过的就是
  这种。旧索引照样能按型号搜，但外设条件全部落到"未收录"——界面据此提示重新生成。
*/
export function indexSchema(index) {
  if (!index?.peripherals) return { version: 1, peripherals: false, specifications: 0 };
  return {
    version: index.peripherals.version || 2,
    peripherals: true,
    specifications: index.specifications?.version || 0,
  };
}

/*
  认不出的词给候选："SDMCC" → SDMMC，"FSCM" → FSMC。按编辑距离挑，距离不超过
  词长的三分之一（至少 1），避免"ADC" 被建议成 "AES" 这种毫不相干的东西。
*/
/* 带相邻换位的编辑距离（OSA）：FSCM → FSMC 算 1 步，打字最常见的错就是换位 */
function editDistance(left, right) {
  const rows = Array.from({ length: left.length + 1 }, (_, i) => Array.from({ length: right.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[left.length][right.length];
}

export function similarConditions(word, vocabulary, limit = 3) {
  const query = normalize(word).replace(/(?:>=|≥|\*|×)\d*$/, "");
  if (!query) return [];
  const budget = Math.max(1, Math.floor(query.length / 3));
  const candidates = [
    ...CAPABILITIES.map((item) => ({ condition: { kind: "capability", value: item.id, min: 1 }, names: [item.label, ...(item.keywords || [])] })),
    ...PERIPHERAL_GROUPS.map((item) => ({ condition: { kind: "group", value: item.id, min: 1 }, names: [item.label, ...item.keywords] })),
    ...[...(vocabulary?.types || [])].map((type) => ({ condition: { kind: "type", value: type, min: 1 }, names: [type] })),
  ];
  return candidates
    .map((item) => ({ ...item, distance: Math.min(...item.names.map((name) => editDistance(query, normalize(name)))) }))
    .filter((item) => item.distance <= budget)
    .sort((left, right) => left.distance - right.distance)
    .map((item) => item.condition)
    /* 能力 SDMMC 和类型 SDMMC 显示出来一模一样，只留排在前面的能力条目 */
    .filter((condition, position, list) => list.findIndex((other) => normalize(conditionLabel(other)) === normalize(conditionLabel(condition))) === position)
    .slice(0, limit);
}

export function hasPeripheralData(device) {
  return device?.pf != null;
}

/* 所有出现过的外设类型和实例名，用于候选和解析。 */
export function peripheralVocabulary(index) {
  const types = new Set(index?.peripherals?.types || []);
  const instances = new Set();
  for (const profile of index?.peripherals?.profiles || []) {
    for (const token of profile.split(" ")) {
      if (token) instances.add(token.slice(0, token.lastIndexOf(":")).split("=")[0]);
    }
  }
  return { types, instances };
}

/* ── 条件 ───────────────────────────────────────────────────────── */

/*
  条件四种：
    { kind: "type", value: "SDMMC", min: 1 }       至少 min 个该类型实例
    { kind: "instance", value: "SDMMC1" }          包含指定实例
    { kind: "group", value: "sd-card", min: 1 }    分组里任意类型，实例数合计 ≥ min
    { kind: "usage", value: "sd", params: { bits: 4 }, min: 1 }
                                                   至少 min 个实例的封装信号满足该用途
  同一用途只保留一个条件（key 不含参数），改位宽是替换而不是叠加。
*/
export function conditionKey(condition) {
  return `${condition.kind}:${condition.value}`;
}

const countSuffix = (condition) => (condition.min > 1 ? ` ≥ ${condition.min}` : "");

export function conditionLabel(condition) {
  if (condition.kind === "group") {
    const group = PERIPHERAL_GROUPS.find((item) => item.id === condition.value);
    return `${group?.label || condition.value}${countSuffix(condition)}`;
  }
  if (condition.kind === "usage") {
    const usage = usageById(condition.value);
    if (!usage) return condition.value;
    return `${usage.short(normalizeParams(usage, condition.params))}${countSuffix(condition)}`;
  }
  if (condition.kind === "capability") {
    return `${capabilityById(condition.value)?.label || condition.value}${countSuffix(condition)}`;
  }
  if (condition.kind === "type") return `${condition.value}${countSuffix(condition)}`;
  return condition.value;
}

function normalize(text) {
  return String(text || "").trim().toUpperCase().replace(/\s+/g, "");
}

/*
  把一个输入词解析成条件。认得：
    SDMMC            类型
    SDMMC1           实例
    SDMMC>=2 / SDMMC≥2 / SDMMC*2 / SDMMCx2   类型 + 数量
    SD卡 / 外部存储   分组
    SD4位 / SDRAM / NAND / RMII / RGB565 …   用途（见 peripheralUsage.js）
  认不出返回 null，让界面提示"没有这个外设"而不是悄悄忽略。
*/
function findCapability(word) {
  return CAPABILITIES.find((item) => normalize(item.label) === word
    || item.keywords?.some((keyword) => normalize(keyword) === word));
}

export function parseCondition(text, vocabulary) {
  const raw = normalize(text);
  if (!raw) return null;
  const findGroup = (word) => PERIPHERAL_GROUPS.find((item) => normalize(item.label) === word
    || item.id.toUpperCase() === word
    || item.keywords.some((keyword) => normalize(keyword) === word));

  /* 用途写法最先认：RMII、MII、QSPI 同时也是 TI 的接口类型名，但敲 RMII 的人要的
     是"以太网 RMII 能接成"，不是"有一个叫 RMII 的外设"。严格的类型条件仍可从
     候选列表里点选。 */
  /* 但实例名优先于一切：SDMMC1 是实例，不是"SD 1 位"；SPDIFRX1 也不是 "SPDIFR × 1" */
  /* FMC、ETH 这种类型名与实例名相同的，按类型认（可以再加数量） */
  if (vocabulary.instances.has(raw) && !vocabulary.types.has(raw)) return { kind: "instance", value: raw };
  const exactUsage = parseUsage(raw);
  if (exactUsage) return exactUsage;
  if (vocabulary.types.has(raw)) return { kind: "type", value: raw, min: 1 };
  const exactGroup = findGroup(raw);
  if (exactGroup) return { kind: "group", value: exactGroup.id, min: 1 };
  const exactCapability = findCapability(raw);
  if (exactCapability) return { kind: "capability", value: exactCapability.id, min: 1 };

  const counted = /^(.+?)(?:>=|≥|\*|×|X)(\d+)$/.exec(raw);
  if (!counted) return null;
  const [, base, count] = counted;
  const min = Math.max(1, Number(count));
  if (vocabulary.types.has(base)) return { kind: "type", value: base, min };
  const group = findGroup(base);
  if (group) return { kind: "group", value: group.id, min };
  const capability = findCapability(base);
  if (capability) return { kind: "capability", value: capability.id, min };
  const usage = parseUsage(base);
  if (usage) return { ...usage, min };
  return null;
}

/* 一段输入可能是几个条件："SDMMC FMC" → 两个；"SDMMC 数量 ≥ 2" → 一个。 */
export function parseConditions(text, vocabulary) {
  const parsed = [];
  const unknown = [];
  const joined = String(text || "")
    .replace(/\s*(?:数量|个数)\s*/g, "")
    .replace(/\s*(>=|≥|\*|×)\s*/g, "$1")
    /* "SD 4 位"、"SDRAM 32位" 这类用途写法把数字和单位粘回前一个词 */
    .replace(/\s+(\d+)\s*(位|bit|线)/gi, "$1$2");
  for (const word of joined.trim().split(/[\s,，、]+/).filter(Boolean)) {
    const condition = parseCondition(word, vocabulary);
    if (condition) parsed.push(condition);
    else unknown.push(word);
  }
  return { parsed, unknown };
}

const KIND_ORDER = { usage: 0, capability: 1, group: 2, type: 3, instance: 4 };

/* 候选：用途、分组、类型、实例，按前缀优先、再按包含，忽略大小写，支持中文提示。 */
export function suggestConditions(text, vocabulary, limit = 10) {
  const query = normalize(text).replace(/(?:>=|≥|\*|×)\d*$/, "");
  if (!query) return [];
  const scored = [];
  /* names 是名字和关键词；descriptions 是中文说明，只在名字都不中时才算，
     排在后面——否则"SD"会先列出说明里带 SD 的 MMC、SDFM，把 SDMMC 挤出列表。 */
  const rankOf = (haystacks) => {
    const words = haystacks.map(normalize).filter(Boolean);
    return words.some((word) => word === query) ? 0
      : words.some((word) => word.startsWith(query)) ? 1
        : words.some((word) => word.includes(query)) ? 2 : -1;
  };
  const push = (condition, names, hint, descriptions = []) => {
    let rank = rankOf(names);
    if (rank < 0) {
      const described = rankOf(descriptions);
      rank = described < 0 ? -1 : described + 3;
    }
    if (rank >= 0) scored.push({ condition, hint, rank });
  };
  for (const usage of USAGES) {
    push({ kind: "usage", value: usage.id, params: defaultParams(usage), min: 1 },
      [...usage.keywords, ...usage.types], `用途：检查 ${usage.types.join(" / ")} 引出信号`, [usage.label]);
  }
  for (const capability of CAPABILITIES) {
    const vendors = ["st", "ti"].filter((vendor) => capability[vendor]).map((vendor) => vendor.toUpperCase());
    push({ kind: "capability", value: capability.id, min: 1 }, [capability.label, ...(capability.keywords || [])],
      `能力：${capability.hint}（${vendors.length ? `已映射 ${vendors.join(" / ")}` : "两家均未收录"}）`, [capability.hint]);
  }
  for (const group of PERIPHERAL_GROUPS) {
    push({ kind: "group", value: group.id, min: 1 }, [group.label, ...group.keywords],
      `分组：${group.types.join(" / ")}`);
  }
  /* 能力目录里同名的（SDMMC、LTDC…）只列能力：两条长得一样的候选只会让人困惑，
     而能力条件对未映射的厂商会如实报"未收录"。手敲完整类型名仍解析成严格类型。 */
  const capabilityNames = new Set(CAPABILITIES.map((item) => normalize(item.label)));
  for (const type of vocabulary.types) {
    if (capabilityNames.has(type)) continue;
    push({ kind: "type", value: type, min: 1 }, [type], TYPE_HINTS[type] || "外设类型", [TYPE_HINTS[type] || ""]);
  }
  /* 实例只在输入里带数字时提示，不然 "S" 会冒出几十个 SPIx/SAIx */
  if (/\d/.test(query)) {
    for (const instance of vocabulary.instances) push({ kind: "instance", value: instance }, [instance], "指定实例");
  }
  return scored
    .sort((left, right) => left.rank - right.rank
      || KIND_ORDER[left.condition.kind] - KIND_ORDER[right.condition.kind]
      || left.condition.value.length - right.condition.value.length
      || left.condition.value.localeCompare(right.condition.value))
    .slice(0, limit);
}

function groupTypes(condition) {
  return new Set(PERIPHERAL_GROUPS.find((item) => item.id === condition.value)?.types || []);
}

/*
  返回 { hits, partial }：
    hits     满足条件的实例（不足 min 个时为 null）
    partial  仅用途条件有：外设存在、但本封装缺信号的实例，带 missing
  用途命中的实例带 check（选中的方案、信号数）。
*/
export function evaluateCondition(instances, condition, vendor = null) {
  /* uncovered：这家厂商对该条件没有核实过的数据，结论是"未收录"而不是"不满足" */
  if (condition.kind === "capability") {
    const hits = matchCapability(capabilityById(condition.value), vendor, instances);
    if (hits === null) return { hits: null, partial: [], uncovered: true };
    return { hits: hits.length >= (condition.min || 1) ? hits : null, partial: [] };
  }
  if (condition.kind === "usage") {
    if (vendor && !usageCovers(vendor)) return { hits: null, partial: [], uncovered: true };
    const usage = usageById(condition.value);
    if (!usage) return { hits: null, partial: [] };
    const types = new Set(usage.types);
    const ok = [];
    const partial = [];
    for (const instance of instances) {
      if (!types.has(instance.type)) continue;
      const check = checkUsage(usage, condition.params, instance);
      if (check.ok) ok.push({ ...instance, check });
      else partial.push({ ...instance, check });
    }
    return { hits: ok.length >= (condition.min || 1) ? ok : null, partial };
  }
  let hits;
  if (condition.kind === "instance") hits = instances.filter((item) => item.name === condition.value);
  else if (condition.kind === "type") hits = instances.filter((item) => item.type === condition.value);
  else {
    const types = groupTypes(condition);
    hits = instances.filter((item) => types.has(item.type));
  }
  const min = condition.kind === "instance" ? 1 : condition.min || 1;
  return { hits: hits.length >= min ? hits : null, partial: [] };
}

/* ── 搜索 ───────────────────────────────────────────────────────── */

function textMatcher(text) {
  const words = String(text || "").trim().toUpperCase().split(/\s+/).filter(Boolean);
  return (device) => {
    if (words.length === 0) return true;
    const vendor = device.vendor === "st" ? "ST STM32" : device.vendor === "ti" ? "TI" : device.vendor;
    const haystack = `${device.part} ${device.series} ${device.family} ${device.package} ${device.pinCount} ${vendor}`.toUpperCase();
    return words.every((word) => haystack.includes(word));
  };
}

/* 封装形态：封装名开头的字母（LQFP100 → LQFP，UFBGA176+25 → UFBGA，TI 的 LQFP-64(PM) → LQFP） */
export function packageShape(device) {
  return /^[A-Z]+/.exec(String(device?.package || "").toUpperCase())?.[0] || "";
}

function filterMinimum(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

const SPECIFICATION_FILTERS = [
  ["flashMinKB", "flashKB"],
  ["ramMinKB", "ramKB"],
  ["frequencyMinMHz", "frequencyMHz"],
];

function hasSpecificationFilters(filters = {}) {
  return SPECIFICATION_FILTERS.some(([key]) => filterMinimum(filters[key]) > 0);
}

function hasFilters(filters) {
  return Boolean(filters?.vendor || filters?.family || filters?.shape || filters?.pinMin || filters?.pinMax
    || hasSpecificationFilters(filters));
}

function familyOf(device) {
  return device.family || device.series || "其他系列";
}

function familyKey(vendor, family) {
  return JSON.stringify([vendor, family]);
}

/* 索引里的厂商家族字段：STM32 的 F1/F4/H7 等；TI 按其产品系列分组。 */
export function deviceFamilies(index, vendor = "") {
  const counts = new Map();
  for (const device of index?.devices || []) {
    if (vendor && device.vendor !== vendor) continue;
    const family = familyOf(device);
    const key = familyKey(device.vendor, family);
    const current = counts.get(key) || { key, vendor: device.vendor, family, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()].sort((left, right) => (
    left.vendor.localeCompare(right.vendor) || left.family.localeCompare(right.family, undefined, { numeric: true })
  ));
}

/* 脚数未知（0）的条目在设了范围时不算匹配——说不清它在不在范围里 */
function filterMatcher(filters = {}) {
  const min = filterMinimum(filters.pinMin);
  const max = filterMinimum(filters.pinMax);
  return (device) => {
    if (filters.vendor && device.vendor !== filters.vendor) return false;
    if (filters.family && familyKey(device.vendor, familyOf(device)) !== filters.family) return false;
    if (filters.shape && packageShape(device) !== filters.shape) return false;
    if ((min || max) && !device.pinCount) return false;
    if (min && device.pinCount < min) return false;
    if (max && device.pinCount > max) return false;
    return true;
  };
}

/* 缺少任一需要的规格时返回 unknown；已知字段不满足门槛则优先判为不匹配。 */
function specificationMatcher(device, filters = {}) {
  let unknown = false;
  for (const [filterKey, specKey] of SPECIFICATION_FILTERS) {
    const minimum = filterMinimum(filters[filterKey]);
    if (!minimum) continue;
    const raw = device?.specs?.[specKey];
    const value = Number(raw);
    if (raw == null || raw === "" || !Number.isFinite(value)) unknown = true;
    else if (value < minimum) return { matches: false, unknown: false };
  }
  return unknown ? { matches: false, unknown: true } : { matches: true, unknown: false };
}

/* 叠加筛选下拉的选项：本索引里实际出现的封装形态，按出现次数排 */
export function packageShapes(index) {
  const counts = new Map();
  for (const device of index?.devices || []) {
    const shape = packageShape(device);
    if (shape) counts.set(shape, (counts.get(shape) || 0) + 1);
  }
  return [...counts].sort((left, right) => right[1] - left[1]).map(([shape, count]) => ({ shape, count }));
}

/* 把用途条件放宽成"对应外设存在"，用来判断一颗片子是不是"有外设但信号不全"。 */
function relaxed(result) {
  if (result.condition.kind !== "usage") return Boolean(result.hits);
  return Boolean(result.hits) || result.partial.length > 0;
}

/*
  searchDevices(index, { text, filters, conditions, mode, page, view })
    filters: { vendor: "st" | "ti" | "", shape: "LQFP"…, pinMin, pinMax,
               flashMinKB, ramMinKB, frequencyMinMHz }
    mode:    "all" 全部满足（默认）| "any" 满足任意一个
    view:    "match"      满足条件的型号（默认）
             "incomplete" 外设在、但封装信号不全的（只对用途条件有意义），hits 里带 partial
             "unknown"    有条件"数据未知"、其余条件都满足的，hits 里带 unknown 的条件
    （旧参数 incomplete: true 等同 view: "incomplete"）
  返回 { items, total, page, pageCount, unrecorded, uncovered, incompleteCount, specUnknownCount }
    unrecorded：文本条件匹配、但这颗片子没有外设档案（旧索引或厂商数据缺失）的条目数
    uncovered：其余条件满足、但有条件对它"数据未知"的条目数（= view "unknown" 的总数）
    incompleteCount：有用途条件时，外设都在但信号不全而落选的条目数
    specUnknownCount：满足其他已判断条件、但缺规格值而无法判断数值门槛的条目数
*/
export function searchDevices(index, {
  text = "", filters = {}, conditions = [], mode = "all", page = 0, pageSize = PAGE_SIZE,
  incomplete = false, view = incomplete ? "incomplete" : "match",
} = {}) {
  const devices = index?.devices || [];
  const matchesText = textMatcher(text);
  const matchesFilters = filterMatcher(filters);
  const passing = [];
  const failing = [];
  const unknown = [];
  let unrecorded = 0;
  let specUnknownCount = 0;
  const matchesSpecs = (device) => {
    const result = specificationMatcher(device, filters);
    if (result.unknown) specUnknownCount += 1;
    return result.matches;
  };
  if (!String(text).trim() && conditions.length === 0 && !hasFilters(filters)) {
    return { items: [], total: 0, page: 0, pageCount: 0, unrecorded: 0, uncovered: 0, incompleteCount: 0, specUnknownCount: 0 };
  }
  const hasUsage = conditions.some((condition) => condition.kind === "usage");
  for (const device of devices) {
    if (!matchesText(device) || !matchesFilters(device)) continue;
    if (conditions.length === 0) {
      if (matchesSpecs(device)) passing.push({ device, hits: [] });
      continue;
    }
    const instances = profileOf(index, device);
    if (!instances) {
      unrecorded += 1;
      continue;
    }
    const combine = mode === "any" ? "some" : "every";
    const toHit = (result) => ({ condition: result.condition, instances: result.hits || [], partial: result.partial });
    const results = conditions.map((condition) => ({ condition, ...evaluateCondition(instances, condition, device.vendor) }));
    /* 有条件对这颗片子"数据未知"（用途检查没覆盖、能力没映射或记录不足以下结论）：
       能判断的条件都过（任意模式下能判断的都不过）时归入 unknown，而不是让它们
       无声地落选。 */
    if (results.some((result) => result.uncovered)) {
      const judged = results.filter((result) => !result.uncovered);
      if (mode === "any" && judged.some((result) => result.hits)) {
        if (matchesSpecs(device)) passing.push({ device, hits: judged.filter((result) => result.hits).map(toHit) });
      } else if (judged.every((result) => result.hits)) {
        if (matchesSpecs(device)) {
          unknown.push({
            device,
            hits: judged.filter((result) => result.hits).map(toHit),
            unknown: results.filter((result) => result.uncovered).map((result) => result.condition),
          });
        }
      }
      continue;
    }
    if (results[combine]((result) => result.hits)) {
      if (matchesSpecs(device)) passing.push({ device, hits: results.filter((result) => result.hits).map(toHit) });
    } else if (hasUsage && results[combine](relaxed)) {
      if (matchesSpecs(device)) failing.push({ device, hits: results.filter((result) => result.hits || result.partial.length).map(toHit) });
    }
  }
  const all = view === "incomplete" ? failing : view === "unknown" ? unknown : passing;
  const pageCount = Math.ceil(all.length / pageSize);
  const current = Math.min(Math.max(0, page), Math.max(0, pageCount - 1));
  return {
    items: all.slice(current * pageSize, (current + 1) * pageSize),
    total: all.length,
    page: current,
    pageCount,
    unrecorded,
    uncovered: unknown.length,
    incompleteCount: failing.length,
    specUnknownCount,
  };
}

/*
  一条命中的展示文字：
    存在类条件   "SDMMC ×2：SDMMC1(14) SDMMC2(10)"，括号里是本封装引出的信号数
                 （0 = 内部功能或此封装没引出，CORDIC、HASH 这类本来就没有脚）
    用途条件     "SDMMC1 ✓6 信号"；不全时 "FMC 缺 SDCLK、BA0、A0–A15"
*/
export function describeHit(hit) {
  if (hit.condition.kind === "usage") {
    const ok = hit.instances.map((item) => `${item.name} ✓${item.check.signals} 信号`);
    const missing = hit.instances.length ? [] : (hit.partial || [])
      .map((item) => `${item.name} 缺 ${compactSignals(item.check.missing)}`);
    return [...ok, ...missing].join("；");
  }
  const list = hit.instances.map((item) => `${item.name}(${item.signals.length})`).join(" ");
  return hit.instances.length > 1 ? `${conditionLabel({ ...hit.condition, min: 1 })} ×${hit.instances.length}：${list}` : list;
}

/* 厂商数据库条目末尾的 x 是温度/包装等级占位符，不是完整订货型号。 */
export function hasPlaceholder(part) {
  return /x/.test(part || "");
}
