/*
  用途筛选：在"外设存在"之上回答"这个封装引出的信号够不够接成这个用途"。

  判断层次（见 deviceSearch.js 开头）：
    1 外设存在       厂商数据库记录了该外设          ← 第一阶段
    2 封装信号满足   所需信号在这个封装里都有候选引脚  ← 这里
    3 引脚分配可行   与其他接口、固定脚、调试口一起无冲突  ← 求解器，尚未接入

  第 2 层**按实例**判断：SDMMC1 有 D0–D3、SDMMC2 有 CK/CMD，不算凑出一个 4 位
  SD。它也只看"每个信号至少有一个候选脚"，不检查这些信号能否同时落在互不相同
  的脚上——那是第 3 层的事。

  ── 需求的写法 ────────────────────────────────────────────────────
  requires(params) 返回需求项数组。每一项是**备选方案**列表，每个方案是一组
  必须同时具备的信号；任一方案齐全，这一项就满足：
    [["SDCLK"]]                                  必须有 SDCLK
    [["SDCKE0", "SDNE0"], ["SDCKE1", "SDNE1"]]   两个 SDRAM bank 任选其一，但时钟使能和片选要配对
    [["RMII_TXD0"], ["TXD0"]]                    同一个信号在新旧库里的两种命名
  缺失报告取每项的第一个方案，所以第一个方案写最常用的那种。

  ── 命名依据 ──────────────────────────────────────────────────────
  信号名都对照过 CubeMX db/mcu/*.xml 里实际出现的写法（去掉实例前缀）。
  新加用途前先在索引的 signalSets 里确认名字，凭印象写会让整个用途永远不匹配。
*/

const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, offset) => `${prefix}${from + offset}`);
const each = (signals) => signals.map((signal) => [[signal]]);
const either = (...names) => names.map((name) => [name]);
const addressRange = (bits) => `A0–A${bits - 1}`;

const FMC_CHIP_SELECT = either("NE1", "NE2", "NE3", "NE4");

export const USAGES = [
  {
    id: "sd",
    label: "SD / SDIO / eMMC 总线",
    short: (params) => `SD ${params.bits} 位`,
    types: ["SDMMC", "SDIO"],
    params: [{ key: "bits", label: "数据线", values: [1, 4, 8], default: 4, format: (value) => `${value} 位` }],
    requires: ({ bits }) => [...each(["CK", "CMD"]), ...each(range("D", 0, bits - 1))],
    /* "SD4"、"SD卡4位"、"SDIO 8bit"、"eMMC"（默认 8 位） */
    parse(word) {
      const match = /^(SD|SDIO|SDMMC|SD卡|TF|TF卡|EMMC|MMC)(?:总线)?(1|4|8)(?:位|BIT|线)?$/.exec(word);
      if (match) return { bits: Number(match[2]) };
      if (word === "EMMC") return { bits: 8 };
      return null;
    },
    keywords: ["SD总线", "SD卡4位", "EMMC", "SDIO"],
  },
  {
    id: "fmc-sdram",
    label: "FMC SDRAM",
    short: (params) => `SDRAM ${params.data} 位 · ${addressRange(params.rows)}`,
    types: ["FMC"],
    params: [
      { key: "data", label: "数据", values: [16, 32], default: 16, format: (value) => `${value} 位` },
      { key: "rows", label: "行地址", values: [11, 12, 13], default: 12, format: addressRange },
    ],
    requires: ({ data, rows }) => [
      ...each(["SDCLK", "SDNRAS", "SDNCAS", "SDNWE", "BA0", "BA1"]),
      [["SDCKE0", "SDNE0"], ["SDCKE1", "SDNE1"]],
      ...each(range("A", 0, rows - 1)),
      ...each(range("D", 0, data - 1)),
      ...each(range("NBL", 0, data / 8 - 1)),
    ],
    parse: (word) => (/^(?:FMC)?SDRAM(16|32)?(?:位|BIT)?$/.exec(word) ? { data: Number(/(16|32)/.exec(word)?.[1] || 16) } : null),
    keywords: ["SDRAM", "FMC SDRAM"],
    note: "行地址按所选 SDRAM 定：64 Mbit ×16 常为 A0–A11，256 Mbit ×16 为 A0–A12",
  },
  {
    id: "fmc-sram",
    label: "SRAM / PSRAM（非复用）",
    short: (params) => `SRAM ${params.data} 位 · ${addressRange(params.addr)}`,
    types: ["FMC", "FSMC"],
    params: [
      { key: "data", label: "数据", values: [8, 16], default: 16, format: (value) => `${value} 位` },
      { key: "addr", label: "地址", values: [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26], default: 19, format: addressRange },
    ],
    requires: ({ data, addr }) => [
      FMC_CHIP_SELECT,
      ...each(["NOE", "NWE"]),
      ...each(range("A", 0, addr - 1)),
      ...each(range("D", 0, data - 1)),
      ...(data === 16 ? each(["NBL0", "NBL1"]) : []),
    ],
    parse: (word) => (/^(?:FMC|FSMC)?P?SRAM(8|16)?(?:位|BIT)?$/.exec(word) ? { data: Number(/(8|16)/.exec(word)?.[1] || 16) } : null),
    keywords: ["SRAM", "PSRAM", "外部SRAM"],
    note: "地址线按容量定：512K×16 SRAM 需 A0–A18",
  },
  {
    id: "fmc-nor",
    label: "NOR Flash（非复用）",
    short: (params) => `NOR ${params.data} 位 · ${addressRange(params.addr)}`,
    types: ["FMC", "FSMC"],
    params: [
      { key: "data", label: "数据", values: [8, 16], default: 16, format: (value) => `${value} 位` },
      { key: "addr", label: "地址", values: [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26], default: 22, format: addressRange },
    ],
    requires: ({ data, addr }) => [
      FMC_CHIP_SELECT,
      ...each(["NOE", "NWE"]),
      ...each(range("A", 0, addr - 1)),
      ...each(range("D", 0, data - 1)),
    ],
    parse: (word) => (/^(?:FMC|FSMC)?NOR(?:FLASH)?$/.exec(word) ? {} : null),
    keywords: ["NOR", "并口NOR"],
  },
  {
    id: "fmc-nand",
    label: "NAND Flash",
    short: (params) => `NAND ${params.data} 位`,
    types: ["FMC", "FSMC"],
    params: [{ key: "data", label: "数据", values: [8, 16], default: 8, format: (value) => `${value} 位` }],
    /* 新库写 ALE/CLE，部分老库只给 A17/A16（NAND 模式下就是这两根）。
       R/B 可接 NWAIT 或任意 GPIO，不作为必需信号。 */
    requires: ({ data }) => [
      either("NCE", "NCE2", "NCE3"),
      ...each(["NOE", "NWE"]),
      either("ALE", "A17"),
      either("CLE", "A16"),
      ...each(range("D", 0, data - 1)),
    ],
    parse: (word) => (/^(?:FMC|FSMC)?NAND(?:FLASH)?(8|16)?(?:位|BIT)?$/.exec(word) ? { data: Number(/(8|16)/.exec(word)?.[1] || 8) } : null),
    keywords: ["NAND", "NAND FLASH"],
    note: "R/B 可接 NWAIT 或普通 GPIO，未计入必需信号",
  },
  {
    id: "fmc-lcd",
    label: "8080 并口屏（FMC/FSMC）",
    short: (params) => `8080 屏 ${params.data} 位`,
    types: ["FMC", "FSMC"],
    params: [{ key: "data", label: "数据", values: [8, 16], default: 16, format: (value) => `${value} 位` }],
    /* RS（D/C）接任意一根地址线 */
    requires: ({ data }) => [
      FMC_CHIP_SELECT,
      ...each(["NOE", "NWE"]),
      either(...range("A", 0, 25)),
      ...each(range("D", 0, data - 1)),
    ],
    parse(word) {
      const match = /^(?:8080|MCU屏|并口屏|FSMC屏|FMC屏)(8|16)?(?:位|BIT)?$/.exec(word);
      return match ? { data: Number(match[1] || 16) } : null;
    },
    keywords: ["8080", "并口屏", "MCU屏"],
    note: "RS（D/C）占用任意一根地址线",
  },
  {
    id: "qspi",
    label: "QSPI 四线 Flash",
    short: () => "QSPI 四线",
    types: ["QUADSPI"],
    params: [],
    /* 单 bank 四线：BK1 或 BK2 任一组齐全即可。部分器件 BK1 的片选就叫 NCS。 */
    requires: () => [
      [["CLK"]],
      [
        [...range("BK1_IO", 0, 3), "BK1_NCS"],
        [...range("BK1_IO", 0, 3), "NCS"],
        [...range("BK2_IO", 0, 3), "BK2_NCS"],
      ],
    ],
    parse: (word) => (/^(?:QSPI|QUADSPI)(?:FLASH)?$/.exec(word) ? {} : null),
    keywords: ["QSPI", "四线FLASH", "QSPI FLASH"],
  },
  {
    id: "eth",
    label: "以太网 RMII / MII",
    short: (params) => `以太网 ${params.phy}`,
    types: ["ETH"],
    params: [{ key: "phy", label: "PHY 接口", values: ["RMII", "MII"], default: "RMII", format: (value) => value }],
    /* 老库写 RMII_TXD0 / MII_TXD0，新库（F4/H7 等）统一写 TXD0 */
    requires: ({ phy }) => {
      const sig = (name, prefix) => either(`${prefix}_${name}`, name);
      if (phy === "RMII") {
        return [
          ...each(["MDC", "MDIO"]),
          ...["REF_CLK", "CRS_DV", "TX_EN", "TXD0", "TXD1", "RXD0", "RXD1"].map((name) => sig(name, "RMII")),
        ];
      }
      return [
        ...each(["MDC", "MDIO"]),
        ...["TX_CLK", "RX_CLK", "TX_EN", "RX_DV", "CRS", "COL", ...range("TXD", 0, 3), ...range("RXD", 0, 3)]
          .map((name) => sig(name, "MII")),
      ];
    },
    parse: (word) => (word === "RMII" || word === "MII" ? { phy: word } : null),
    keywords: ["RMII", "MII", "以太网RMII"],
  },
  {
    id: "dcmi",
    label: "DCMI 摄像头",
    short: (params) => `摄像头 ${params.bits} 位`,
    types: ["DCMI", "DCMIPP"],
    params: [{ key: "bits", label: "数据线", values: [8, 10, 12, 14], default: 8, format: (value) => `${value} 位` }],
    requires: ({ bits }) => [...each(["PIXCLK", "HSYNC", "VSYNC"]), ...each(range("D", 0, bits - 1))],
    parse: (word) => {
      const match = /^(?:DCMI|摄像头|CAMERA)(8|10|12|14)(?:位|BIT)?$/.exec(word);
      return match ? { bits: Number(match[1]) } : null;
    },
    keywords: ["DCMI8位", "摄像头8位"],
  },
  {
    id: "ltdc",
    label: "LTDC RGB 屏",
    short: (params) => `RGB 屏 ${params.format}`,
    types: ["LTDC"],
    params: [{ key: "format", label: "色深", values: ["RGB565", "RGB666", "RGB888"], default: "RGB565", format: (value) => value }],
    /* 低位不接时取高位：RGB565 用 R3–R7 G2–G7 B3–B7 */
    requires: ({ format }) => {
      const [red, green, blue] = { RGB565: [3, 2, 3], RGB666: [2, 2, 2], RGB888: [0, 0, 0] }[format];
      return [
        ...each(["CLK", "HSYNC", "VSYNC", "DE"]),
        ...each(range("R", red, 7)), ...each(range("G", green, 7)), ...each(range("B", blue, 7)),
      ];
    },
    parse: (word) => (/^(?:LTDC|RGB屏)?(RGB565|RGB666|RGB888)$/.exec(word) ? { format: /RGB\d+/.exec(word)[0] } : null),
    keywords: ["RGB565", "RGB888", "RGB屏"],
  },
];

export function usageById(id) {
  return USAGES.find((usage) => usage.id === id) || null;
}

/* 用途定义按 CubeMX 的信号名写成，目前只对 ST 器件有意义。TI 的 SD 卡接口叫
   MMC、外部总线叫 EMIF/GPMC，信号名也是另一套，没有定义就**不判断**——
   不能因为找不到 SDMMC 就说 AM335x 接不了 SD 卡。 */
export const USAGE_VENDORS = Object.freeze(["st"]);

export function usageCovers(vendor) {
  return USAGE_VENDORS.includes(vendor);
}

export function defaultParams(usage) {
  return Object.fromEntries(usage.params.map((param) => [param.key, param.default]));
}

/* 参数只接受定义里列出的值，工程文件或手输带进来的怪值退回默认 */
export function normalizeParams(usage, params = {}) {
  return Object.fromEntries(usage.params.map((param) => [
    param.key,
    param.values.includes(params[param.key]) ? params[param.key] : param.default,
  ]));
}

/*
  对一个实例判断用途。返回：
    { ok: true, chosen: [[...]], signals: n }   chosen 为每项选中的方案
    { ok: false, missing: ["SDCLK", "A0", ...] } 缺的信号（取每项第一方案里缺的那些）
*/
export function checkUsage(usage, params, instance) {
  const available = new Set(instance.signals);
  const chosen = [];
  const missing = [];
  for (const requirement of usage.requires(normalizeParams(usage, params))) {
    const option = requirement.find((signals) => signals.every((signal) => available.has(signal)));
    if (option) chosen.push(option);
    else missing.push(...requirement[0].filter((signal) => !available.has(signal)));
  }
  if (missing.length) return { ok: false, missing };
  return { ok: true, chosen, signals: new Set(chosen.flat()).size };
}

/* 缺失列表压缩显示："A0–A15、SDCLK、BA0、BA1" */
export function compactSignals(signals) {
  const groups = [];
  for (const signal of signals) {
    const match = /^(.*?)(\d+)$/.exec(signal);
    const last = groups[groups.length - 1];
    if (match && last && last.prefix === match[1] && last.to + 1 === Number(match[2])) {
      last.to += 1;
    } else if (match) {
      groups.push({ prefix: match[1], from: Number(match[2]), to: Number(match[2]) });
    } else {
      groups.push({ text: signal });
    }
  }
  return groups.map((group) => group.text
    || (group.from === group.to ? `${group.prefix}${group.from}` : `${group.prefix}${group.from}–${group.prefix}${group.to}`))
    .join("、");
}

/* 输入词 → 用途条件。normalize 之后的词（大写、无空格）。 */
export function parseUsage(word) {
  for (const usage of USAGES) {
    const params = usage.parse?.(word);
    if (params) return { kind: "usage", value: usage.id, params: normalizeParams(usage, { ...defaultParams(usage), ...params }), min: 1 };
  }
  return null;
}
