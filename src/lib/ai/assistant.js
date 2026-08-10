import { DEFINITIONS, createRequest } from "../allocator.js";
import { MODULE_CATALOG, moduleMatchesText, resolveModule } from "../../data/moduleCatalog.js";
import { createRequirementsEnvelope, validateRequirementsEnvelope } from "./requirements.js";

const NUMBER_TOKEN = "(?:[0-9]+|一|两|二|三|四|五|六|七|八|九|十)";

const DIRECT_PROTOCOLS = [
  { type: "SPI", aliases: ["spi"] },
  { type: "I2C", aliases: ["i2c", "i²c", "iic", "双线总线"] },
  { type: "UART", aliases: ["uart", "usart", "lpuart", "串口"] },
  { type: "FDCAN", aliases: ["fdcan", "can总线", "can"] },
  { type: "SDMMC", aliases: ["sdmmc"] },
  { type: "QUADSPI", aliases: ["quadspi", "qspi"] },
  { type: "USB", aliases: ["usb"] },
  { type: "ETH", aliases: ["ethernet", "以太网", "rmii", "mii"] },
  { type: "TIM", aliases: ["timer", "tim", "pwm", "定时器", "脉宽"] },
  { type: "ADC", aliases: ["adc", "模拟输入", "模数", "采样通道", "电位器", "热敏"] },
  { type: "DAC", aliases: ["dac", "模拟输出", "数模"] },
];

/* 模拟需求的"N 路"是**一行 N 通道**，不是 N 行。求解器禁止同一实例被两行
   共用，H743 上只有 3 个 ADC 实例，拆成 4 行会直接判成无解。 */
function analogVariantForCount(type, count) {
  const variants = Object.entries(DEFINITIONS[type].variants)
    .map(([id, variant]) => ({ id, channels: variant.channels }))
    .sort((left, right) => left.channels - right.channels);
  return (variants.find((variant) => variant.channels >= count) || variants.at(-1)).id;
}

const INSTANCE_TYPES = ["SPI", "I2C", "USART", "UART", "LPUART", "FDCAN", "SDMMC", "TIM", "OTG", "ETH", "QUADSPI"];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readNumber(token) {
  if (!token) return 1;
  if (/^\d+$/.test(token)) return Math.max(1, Number(token));
  return { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[token] || 1;
}

function hasAny(text, values) {
  return values.some((value) => text.includes(value.toLowerCase()));
}

function protocolCount(text, aliases) {
  const aliasPattern = aliases.map(escapeRegex).join("|");
  const before = new RegExp(`(${NUMBER_TOKEN})\\s*(?:个|路|组|套)?\\s*(?:${aliasPattern})`, "i").exec(text);
  /* 不能把 SPI1 / I2C4 / USART3 的实例编号误读成“需要 1/4/3 路”。
     只有协议名后存在空格或明确的“接口/总线/实例”分隔词时，才把后面的数字当数量。 */
  const after = new RegExp(`(?:${aliasPattern})(?:\\s+|(?:接口|总线|设备|实例)\\s*)(${NUMBER_TOKEN})\\s*(?:个|路|组|套)?`, "i").exec(text);
  const explicit = Boolean(before || after);
  return {
    count: readNumber(before?.[1] || after?.[1]),
    explicit,
  };
}

function findInstancePreferences(text) {
  const instances = {};
  const pattern = new RegExp(`\\b(${INSTANCE_TYPES.join("|")})\\s*([1-9]\\d*)\\b`, "gi");
  for (const match of text.matchAll(pattern)) {
    const prefix = match[1].toUpperCase();
    const instance = `${prefix}${match[2]}`;
    const type = ["USART", "UART", "LPUART"].includes(prefix) ? "UART" : prefix === "OTG" ? "USB" : prefix;
    if (DEFINITIONS[type]) instances[type] = instance;
  }
  return instances;
}

function preferredSide(text) {
  if (/(?:靠|从|位于|放在).*(?:右侧|右边|靠右)|右侧|右边|靠右/.test(text)) return "right";
  if (/(?:靠|从|位于|放在).*(?:左侧|左边|靠左)|左侧|左边|靠左/.test(text)) return "left";
  if (/(?:靠|从|位于|放在).*(?:上侧|顶部|顶边|靠上)|上侧|顶边|靠上/.test(text)) return "top";
  if (/(?:靠|从|位于|放在).*(?:下侧|底部|底边|靠下)|下侧|底边|靠下/.test(text)) return "bottom";
  return null;
}

function variantOverride(type, text, current) {
  if (type === "SPI" && /(?:四线|硬件 NSS|nss)/i.test(text)) return "full4";
  if (type === "SPI" && /(?:只发|单向|仅发送|tx only)/i.test(text)) return "tx2";
  if (type === "UART" && /(?:硬件流控|流控|cts|rts)/i.test(text)) return "flow";
  if (type === "UART" && /(?:只发|仅发送|tx only)/i.test(text)) return "txonly";
  if (type === "SDMMC" && /(?:1.?bit|1 位)/i.test(text)) return "bit1";
  if (type === "SDMMC" && /(?:8.?bit|8 位|emmc)/i.test(text)) return "bit8";
  if (type === "ETH" && /\bmii\b/i.test(text) && !/\brmii\b/i.test(text)) return "mii";
  if (type === "USB" && /(?:otg|id 脚|id脚)/i.test(text)) return "otg";
  if (type === "TIM" && /(?:单路|单相)/i.test(text)) return "pwm1";
  return current;
}

function requirementTypeSet(requirements) {
  return new Set(requirements.map((item) => item.type));
}

function addRequirementRequests(target, requirement, source, resolvedModule) {
  if (!DEFINITIONS[requirement.type]) return;
  const count = Math.max(1, Number(requirement.count) || 1);
  for (let index = 0; index < count; index += 1) {
    target.push({
      type: requirement.type,
      variant: requirement.variant || DEFINITIONS[requirement.type].defaultVariant,
      instance: requirement.instance || null,
      side: requirement.side || null,
      fiveVolt: Boolean(requirement.fiveVolt),
      source,
      sourceLabel: resolvedModule?.name || source,
      role: requirement.role || "模块接口",
    });
  }
}

/**
 * 将自然语言需求解析成可审查的结构化草案。
 * 这是离线 fallback；后续接入真实模型时，只需让模型输出同一 envelope，再复用校验和应用流程。
 */
export function analyzeRequirementsText(input, { mcuId = null } = {}) {
  const text = String(input || "").trim().toLowerCase();
  const warnings = [];
  const resolvedModules = MODULE_CATALOG
    .filter((module) => moduleMatchesText(module, text))
    .map((module) => resolveModule(module, text));
  const requests = [];

  for (const module of resolvedModules) {
    for (const requirement of module.requirements) {
      addRequirementRequests(requests, requirement, module.id, module);
    }
  }

  const moduleTypes = requirementTypeSet(requests);
  const extraRequested = /(?:另外|额外|再增加|再加|再要)/.test(text);
  for (const protocol of DIRECT_PROTOCOLS) {
    if (!hasAny(text, protocol.aliases)) continue;
    const { count, explicit } = protocolCount(text, protocol.aliases);
    if (!moduleTypes.has(protocol.type) || extraRequested || (explicit && !resolvedModules.length)) {
      const analog = DEFINITIONS[protocol.type].family === "analog";
      const rows = analog ? 1 : count;
      const variant = analog
        ? analogVariantForCount(protocol.type, count)
        : DEFINITIONS[protocol.type].defaultVariant;
      for (let index = 0; index < rows; index += 1) {
        requests.push({
          type: protocol.type,
          variant,
          instance: null,
          side: null,
          source: "direct",
          sourceLabel: "直接需求",
          role: analog ? "用户指定模拟通道" : "用户指定接口",
        });
      }
    }
  }

  const instances = findInstancePreferences(text);
  const side = preferredSide(text);
  const constraints = [];
  if (side) constraints.push({ kind: "side", value: side, label: `优先从${{ left: "左", right: "右", top: "上", bottom: "下" }[side]}侧出线` });
  if (/(?:保留|保护).*(?:调试|swd|jtag)|不要占用.*(?:调试|swd|jtag)/i.test(text)) constraints.push({ kind: "protectDebug", value: true, label: "保留 SWD / JTAG" });
  if (/(?:保留|保护).*(?:晶振|hse|hsi)|不要占用.*(?:晶振|hse|hsi)/i.test(text)) constraints.push({ kind: "protectOscillator", value: true, label: "保留晶振相关引脚" });
  /* 5V 现在是求解器的硬约束（只挑耐压的 I/O 结构），不再只是一句提示。
     和方位偏好一样按整板施加——这是可审查的草案，用户可以逐行改掉。 */
  const fiveVolt = /(?:5\s*v|5 ?伏)/i.test(text);
  if (fiveVolt) constraints.push({ kind: "fiveVolt", value: true, label: "只用耐 5V 的引脚" });

  let usedInstance = new Set();
  for (const request of requests) {
    const preferred = instances[request.type];
    if (preferred && !usedInstance.has(request.type)) {
      request.instance = preferred;
      usedInstance.add(request.type);
    }
    request.variant = variantOverride(request.type, text, request.variant);
    if (side) request.side = side;
    if (fiveVolt) request.fiveVolt = true;
  }

  if (!resolvedModules.length && !requests.length) {
    warnings.push("没有识别到模块或总线需求。可以输入“1 个 SPI、1 个 I²C、1 个调试串口”，或直接选择下方模块。");
  }
  if (resolvedModules.some((module) => /GPIO|中断|控制脚/.test(module.notes))) {
    warnings.push("模块中的 GPIO 中断脚和供电控制仍属于板级约束，需要自行预留。");
  }

  const moduleEnvelope = resolvedModules.map((module) => ({
    id: module.id,
    name: module.name,
    variant: module.variantId,
    requirements: module.requirements,
  }));
  const envelope = createRequirementsEnvelope({
    mcuId,
    modules: moduleEnvelope,
    constraints,
    notes: warnings,
  });

  return {
    input: input || "",
    envelope,
    modules: resolvedModules,
    requests,
    constraints,
    warnings,
    source: "offline",
    summary: requests.length ? `识别到 ${resolvedModules.length} 个模块、${requests.length} 路可求解接口` : "尚未形成可求解的接口需求",
  };
}

export function analysisToRequestRows(analysis) {
  return (analysis?.requests || []).map((request) => createRequest(request.type, {
    variant: request.variant,
    instance: request.instance,
    side: request.side,
    fiveVolt: Boolean(request.fiveVolt),
  }));
}

/**
 * 将远程模型返回的 envelope 走同一条本地审查路径。
 * 远程模型可以推荐模块和总线，但不会被允许直接写入物理 pin。
 */
export function analysisFromEnvelope(inputEnvelope, { input = "", mcuId = null, source = "remote" } = {}) {
  const checked = validateRequirementsEnvelope(inputEnvelope, { mcuId });
  if (!checked.ok) throw new Error(checked.errors.join("；"));

  const envelope = checked.value;
  const modules = envelope.modules.map((module) => ({
    id: module.id,
    name: module.name,
    category: "AI 推荐",
    variantId: module.variant || "custom",
    variantLabel: module.variant || "结构化接口需求",
    requirements: module.requirements,
    notes: "来自 AI 需求草案，物理引脚由本地求解器重新计算。",
  }));
  const requests = [];
  for (const module of modules) {
    for (const requirement of module.requirements) addRequirementRequests(requests, requirement, module.id, module);
  }

  const constraints = envelope.constraints.map((constraint, index) => {
    if (typeof constraint === "string") return { kind: `note-${index}`, value: constraint, label: constraint };
    return {
      kind: constraint.kind || `constraint-${index}`,
      value: constraint.value ?? true,
      label: constraint.label || String((constraint.value ?? constraint.kind) || "AI 约束"),
    };
  });
  const globalSide = constraints.find((constraint) => ["left", "right", "top", "bottom"].includes(constraint.value))?.value;
  const globalFiveVolt = constraints.some((constraint) => constraint.kind === "fiveVolt" && constraint.value !== false);
  for (const request of requests) {
    if (!request.side && globalSide) request.side = globalSide;
    if (globalFiveVolt) request.fiveVolt = true;
  }
  const warnings = envelope.notes.map(String);
  if (!requests.length) warnings.unshift("AI 没有返回可求解的数字外设需求，请补充接口类型或模块信息。");

  return {
    input,
    envelope,
    modules,
    requests,
    constraints,
    warnings,
    source,
    summary: requests.length ? `AI 识别到 ${modules.length} 个模块、${requests.length} 路可求解接口` : "AI 尚未形成可求解的接口需求",
  };
}
