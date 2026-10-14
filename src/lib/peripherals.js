import {
  analogFamilyOfInstance, analogFunctions, analogInputs, analogInstances, isAnalogFunctionName,
} from "./analog.js";
import { DEFINITIONS, PERIPHERAL_TYPE_ORDER, instancesForType } from "./allocator.js";

const FAMILY_GROUPS = {
  Connectivity: [
    { id: "SPI", label: "SPI", type: "SPI", pattern: /^SPI\d+_/ },
    { id: "I2C", label: "I²C", type: "I2C", pattern: /^I2C\d+_/ },
    { id: "USART", label: "USART", type: "UART", pattern: /^USART\d+_/ },
    { id: "UART", label: "UART", type: "UART", pattern: /^UART\d+_/ },
    { id: "LPUART", label: "LPUART", type: "UART", pattern: /^LPUART\d+_/ },
    { id: "FDCAN", label: "CAN / FDCAN", type: "FDCAN", pattern: /^(?:FDCAN|CAN)\d+_/ },
    { id: "ETH", label: "Ethernet", pattern: /^ETH_/ },
    { id: "SDMMC", label: "SDMMC", pattern: /^SDMMC\d+_/ },
    { id: "USB", label: "USB OTG", pattern: /^OTG_/ },
  ],
  Timers: [
    { id: "TIM", label: "TIM", pattern: /^(?:TIM\d+|TIMA\d+|TIMG\d+)_/ },
    { id: "LPTIM", label: "LPTIM", pattern: /^LPTIM\d+_/ },
    { id: "HRTIM", label: "HRTIM", pattern: /^HRTIM\d+_/ },
  ],
  Analog: [
    /* ADC / DAC 走 analog.js 取实例：ST 的 ADC123_INP10 是"同时挂在 ADC1/2/3 上"，
       用 /^(ADC\d+)_/ 会造出并不存在的实例 "ADC123"。 */
    { id: "ADC", label: "ADC", type: "ADC", analogFamily: "ADC" },
    { id: "DAC", label: "DAC", type: "DAC", analogFamily: "DAC" },
    { id: "COMP", label: "COMP", pattern: /^(COMP\d+)_/ },
    { id: "OPAMP", label: "OPAMP", pattern: /^(OPAMP\d+)_/ },
  ],
  Multimedia: [
    { id: "SAI", label: "SAI", pattern: /^SAI\d+_/ },
    { id: "I2S", label: "I²S", pattern: /^(I2S\d+)_/ },
    { id: "DCMI", label: "DCMI", pattern: /^DCMI_/ },
    { id: "QUADSPI", label: "QUADSPI", pattern: /^QUADSPI_/ },
    { id: "SPDIFRX", label: "SPDIFRX", pattern: /^(SPDIFRX\d+)_/ },
  ],
};

const STATIC_GROUPS = {
  "System Core": [
    { id: "RCC", label: "RCC", status: "配置项", description: "系统时钟与复位配置" },
    { id: "SYS", label: "SYS", status: "配置项", description: "系统核心与调试占用" },
    { id: "NVIC", label: "NVIC", status: "配置项", description: "中断控制器，不占用外部引脚" },
  ],
  Security: [
    { id: "RNG", label: "RNG", status: "片上资源", description: "随机数发生器，不占用外部引脚" },
    { id: "HASH", label: "HASH", status: "片上资源", description: "HASH 加速器，不占用外部引脚" },
    { id: "CRYP", label: "CRYP", status: "片上资源", description: "密码学加速器，不占用外部引脚" },
  ],
  Computing: [
    { id: "DMA", label: "DMA1 / DMA2", status: "片上资源", description: "DMA控制器，不占用外部引脚" },
    { id: "MDMA", label: "MDMA", status: "片上资源", description: "MDMA控制器，不占用外部引脚" },
    { id: "CORTEX", label: "Cortex-M7", status: "片上资源", description: "内核配置，不占用外部引脚" },
  ],
  "Middleware and Software Packs": [
    { id: "FREERTOS", label: "FreeRTOS", status: "软件组件", description: "需要单独配置软件包" },
    { id: "LWIP", label: "LwIP", status: "软件组件", description: "需要以太网外设支持" },
    { id: "FATFS", label: "FatFS", status: "软件组件", description: "需要SDMMC或SPI存储设备" },
  ],
  "Trace and Debug": [
    { id: "SWD", label: "SWD / JTAG", status: "系统占用", description: "PA13、PA14等调试引脚" },
    { id: "TRACE", label: "Trace", status: "查询项", description: "TRACE信号的可用复用功能" },
  ],
  "Power and Thermal": [
    { id: "PWR", label: "PWR", status: "配置项", description: "电源、VBAT、VCAP和复位相关引脚" },
    { id: "VREFBUF", label: "VREFBUF", status: "查询项", description: "内部参考电压相关功能" },
  ],
};

export const TIMER_MODE_LABELS = Object.freeze({
  general: "通用定时器",
  capture: "输入捕获",
  compare: "输出比较",
  pwm: "PWM 输出",
  qei: "正交编码器",
  fault: "故障输入",
});

const TIMER_INSTANCE_RE = /^(?:TIMA\d+|TIMG\d+)_/;
const TIMER_CHANNEL_RE = /_(?:C[0-3]N?|CH[1-4]N?)$/;
const TIMER_INDEX_RE = /_IDX$/;
const TIMER_FAULT_RE = /^TIMA_FAL\d+$/;

const MSPM0_STATIC = {
  project: [
    { id: "project-configuration", label: "Project Configuration", status: "配置项", description: "工程级别的芯片与 SysConfig 配置入口。" },
  ],
  driver: [
    { id: "board", label: "Board", status: "配置项", description: "板级驱动与 LaunchPad/自定义板配置。" },
    { id: "configuration-nvm", label: "Configuration NVM", status: "配置项", description: "将外设配置保存到非易失存储。" },
    { id: "dma", label: "DMA", status: "配置项", description: "MSPM0 DMA 通道与触发源。" },
    { id: "gpio", label: "GPIO", status: "配置项", description: "通用输入输出与唤醒配置。" },
    { id: "iwdt", label: "IWDT", status: "配置项", description: "独立看门狗配置。" },
    { id: "mathacl", label: "MATHACL", status: "配置项", description: "数学加速器配置。" },
    { id: "rtc-b", label: "RTC_B", status: "配置项", description: "实时时钟配置。" },
    { id: "sysctl", label: "SYSCTL", status: "配置项", description: "系统控制器与时钟配置。" },
    { id: "systick", label: "SYSTICK", status: "配置项", description: "系统节拍定时器配置。" },
    { id: "wwdt", label: "WWDT", status: "配置项", description: "窗口看门狗配置。" },
  ],
  analog: [
    { id: "adc12", label: "ADC12", status: "配置项", description: "ADC12 通道、触发与采样配置。" },
    { id: "comp", label: "COMP", status: "配置项", description: "模拟比较器输入与输出配置。" },
    { id: "dac12", label: "DAC12", status: "配置项", description: "DAC12 输出配置。" },
    { id: "vref", label: "VREF", status: "配置项", description: "模拟参考电压配置。" },
  ],
  communication: [
    { id: "i2c-smbus", label: "I2C - SMBUS", status: "配置项", description: "I2C/SMBus 工作模式配置。" },
    { id: "uart-lin", label: "UART - LIN", status: "配置项", description: "UART/LIN 工作模式配置。" },
  ],
  timers: [
    { id: "timer", label: "TIMER", status: "配置项", timerMode: "general", description: "通用定时器实例与时钟配置。选择后显示所有可用 TIMA/TIMG 实例。" },
    { id: "timer-capture", label: "TIMER - CAPTURE", status: "配置项", timerMode: "capture", description: "输入捕获通道配置。仅显示带 C0-C3 通道的定时器实例。" },
    { id: "timer-compare", label: "TIMER - COMPARE", status: "配置项", timerMode: "compare", description: "输出比较通道配置。仅显示带 C0-C3 通道的定时器实例。" },
    { id: "timer-pwm", label: "TIMER - PWM", status: "配置项", timerMode: "pwm", description: "PWM 通道与占空比配置。芯片图会高亮可用于 PWM 的 C0-C3 引脚。" },
    { id: "timer-qei", label: "TIMER - QEI", status: "配置项", timerMode: "qei", description: "正交编码器接口配置。仅显示同时具备 IDX 与至少两个 C 通道的定时器。" },
    { id: "timer-fault", label: "Timer Fault", status: "配置项", timerMode: "fault", description: "定时器故障输入与保护动作配置。芯片图会高亮 TIMA_FAL0-TIMA_FAL2。" },
  ],
  security: [
    { id: "aes", label: "AES", status: "片上资源", description: "AES 加密加速器配置。" },
    { id: "crc", label: "CRC", status: "片上资源", description: "CRC 校验模块配置。" },
    { id: "trng", label: "TRNG", status: "片上资源", description: "真随机数模块配置。" },
  ],
};

const MSPM0_GROUPS = {
  Analog: [
    { id: "ADC", label: "ADC", type: "ADC", analogFamily: "ADC" },
    { id: "DAC", label: "DAC", type: "DAC", analogFamily: "DAC" },
    { id: "COMP", label: "COMP", pattern: /^(COMP\d+)_/ },
  ],
  Communications: [
    { id: "I2C", label: "I2C", type: "I2C", pattern: /^I2C\d+_/ },
    { id: "MCAN", label: "MCAN", type: "FDCAN", pattern: /^CAN\d+_/ },
    { id: "SPI", label: "SPI", type: "SPI", pattern: /^SPI\d+_/ },
    { id: "UART", label: "UART", type: "UART", pattern: /^UART\d+_/ },
  ],
  Timers: [
    { id: "TIMER", label: "TIMER", type: "TIM", pattern: /^(?:TIMA\d+|TIMG\d+)_/ },
  ],
};

/*
  通用 profile：不复刻任何厂商的界面，全部从器件数据现推。

  没有它的话，新接一颗 NXP / 兆易的片子会顶着 CubeMX 那套写死的静态项
  （Middleware and Software Packs、Cortex-M7…）显示——那些条目在别家片子上
  根本不存在。有了它，加一颗片子的 UI 工作量是零；只有想复刻厂商原生观感
  （像 ti-mspm0 那样对着 SysConfig 侧边栏做）时才需要手写 profile。

  可分配的外设直接取 DEFINITIONS + 方言解析出的实例，所以厂商叫 CAN0 还是
  FDCAN1 都能归到同一类。只能查询、还不能参与求解的家族另列，
  剩下认不出来的前缀统一进 "Other"——宁可列出来让人自己看，
  也好过悄悄丢掉半张 AF 表。
*/
const GENERIC_CATEGORIES = {
  Connectivity: ["SPI", "I2C", "UART", "FDCAN", "SDMMC", "QUADSPI", "USB", "ETH"],
  Timers: ["TIM"],
  Analog: ["ADC", "DAC"],
};

/* 尚未建模、但值得单独成组的家族。有 pattern 没 type，所以是"可查询"。 */
const GENERIC_QUERYABLE = {
  Analog: [
    { id: "COMP", label: "COMP", pattern: /^(COMP\d+)_/ },
    { id: "OPAMP", label: "OPAMP", pattern: /^(OPAMP\d+)_/ },
    { id: "VREF", label: "VREF", pattern: /^(VREF)[-+_]/ },
  ],
  Multimedia: [
    { id: "SAI", label: "SAI", pattern: /^(SAI\d+)_/ },
    { id: "I2S", label: "I²S", pattern: /^(I2S\d+)_/ },
    { id: "DCMI", label: "DCMI", pattern: /^(DCMI)_/ },
  ],
  Memory: [
    { id: "FMC", label: "FMC / FSMC", pattern: /^(FMC|FSMC)_/ },
    { id: "OCTOSPI", label: "OCTOSPI", pattern: /^(OCTOSPI\d*)_/ },
  ],
};

const GENERIC_CATEGORY_ORDER = ["Analog", "Timers", "Connectivity", "Multimedia", "Memory", "Other"];

const PROFILE_CONFIGS = {
  generic: {
    generic: true,
    categoryOrder: GENERIC_CATEGORY_ORDER,
  },
  "stm32-cube": {
    requestTypes: ["SPI", "I2C", "UART", "FDCAN", "SDMMC", "QUADSPI", "USB", "ETH", "TIM", "ADC", "DAC", "GPIO"],
    categoryOrder: [
      "System Core", "Analog", "Timers", "Connectivity", "Multimedia", "Security", "Computing",
      "Middleware and Software Packs", "Trace and Debug", "Power and Thermal",
    ],
    groups: FAMILY_GROUPS,
    staticGroups: STATIC_GROUPS,
  },
  "ti-mspm0": {
    requestTypes: ["SPI", "I2C", "UART", "FDCAN", "TIM", "ADC", "DAC", "GPIO"],
    sections: [
      { id: "project-configuration", label: "PROJECT CONFIGURATION", count: 1, items: MSPM0_STATIC.project },
      { id: "mspm0-driver-library", label: "MSPM0 DRIVER LIBRARY", count: 10, items: MSPM0_STATIC.driver },
      { id: "analog", label: "ANALOG", count: 4, items: MSPM0_STATIC.analog, groups: MSPM0_GROUPS.Analog },
      { id: "communications", label: "COMMUNICATIONS", count: 6, items: MSPM0_STATIC.communication, groups: MSPM0_GROUPS.Communications },
      { id: "timers", label: "TIMERS", count: 6, items: MSPM0_STATIC.timers, groups: MSPM0_GROUPS.Timers },
      { id: "security", label: "SECURITY", count: 3, items: MSPM0_STATIC.security },
    ],
  },
};

/* 认不出来的 profile 一律退到 generic，而不是退到 stm32-cube——把别家的片子
   套上 CubeMX 的静态条目，等于凭空捏造这颗片子上并不存在的东西。 */
export function getMcuUiProfile(profileId) {
  return PROFILE_CONFIGS[profileId] || PROFILE_CONFIGS.generic;
}

/*
  这颗片子上真正能提需求的类型。

  profile 列了什么不算数，数据里解析不出实例的类型不给出选项——在一颗没有
  以太网的片子上摆一个 "Ethernet" 按钮，点下去只会得到无解。
*/
export function requestTypesFor(mcu, profileId) {
  const profile = getMcuUiProfile(profileId);
  const declared = profile.requestTypes || PERIPHERAL_TYPE_ORDER;
  const available = declared.filter((type) => (
    type === "GPIO"
      ? mcu.pins.some((pin) => pin.kind === "gpio")
      : instancesForType(mcu, type).length > 0
  ));
  return available.length ? available : declared;
}

function compactName(functionName, pattern) {
  const match = functionName.match(pattern);
  if (!match) return null;
  return match[1] || match[0].replace(/_.*/, "");
}

function pinFunctionNames(pin) {
  return [
    ...pin.functions.map((item) => item.name),
    ...pin.additionalFunctions,
  ];
}

function timerSignalsForInstance(mcu, instance) {
  const signals = [];
  for (const pin of mcu.pins) {
    for (const name of pinFunctionNames(pin)) {
      if (name.startsWith(`${instance}_`)) signals.push(name.slice(instance.length + 1));
      if (instance.startsWith("TIMA") && TIMER_FAULT_RE.test(name)) signals.push(name);
    }
  }
  return [...new Set(signals)];
}

function timerModeSupportsSignals(signals, mode = "general") {
  if (mode === "general") return signals.length > 0;
  if (mode === "fault") return signals.some((signal) => TIMER_FAULT_RE.test(signal));
  const channelCount = signals.filter((signal) => TIMER_CHANNEL_RE.test(`_${signal}`)).length;
  if (mode === "qei") return signals.some((signal) => TIMER_INDEX_RE.test(`_${signal}`)) && channelCount >= 2;
  return channelCount > 0;
}

function timerModeSignalMatches(name, mode = "general") {
  if (mode === "general") return true;
  if (mode === "fault") return TIMER_FAULT_RE.test(name);
  if (mode === "qei") return TIMER_CHANNEL_RE.test(name) || TIMER_INDEX_RE.test(name);
  return TIMER_CHANNEL_RE.test(name);
}

function timerInstanceNames(mcu) {
  const names = new Set();
  for (const pin of mcu.pins) {
    for (const name of pinFunctionNames(pin)) {
      const match = name.match(TIMER_INSTANCE_RE);
      if (match) names.add(match[0].slice(0, -1));
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function timerModesForInstance(mcu, instance) {
  const signals = timerSignalsForInstance(mcu, instance);
  return Object.keys(TIMER_MODE_LABELS).filter((mode) => timerModeSupportsSignals(signals, mode));
}

function timerPinMatches(mcu, pin, instance, mode = "general") {
  const candidates = instance ? [instance] : timerInstanceNames(mcu);
  const names = pinFunctionNames(pin);
  return candidates.some((candidate) => {
    const signals = timerSignalsForInstance(mcu, candidate);
    if (!timerModeSupportsSignals(signals, mode)) return false;
    return names.some((name) => {
      const belongsToInstance = name.startsWith(`${candidate}_`)
        || (candidate.startsWith("TIMA") && TIMER_FAULT_RE.test(name));
      return belongsToInstance && timerModeSignalMatches(name, mode);
    });
  });
}

function instancesFor(mcu, pattern) {
  const names = new Set();
  for (const pin of mcu.pins) {
    for (const item of pin.functions) {
      const name = compactName(item.name, pattern);
      if (name) names.add(name);
    }
    for (const item of pin.additionalFunctions) {
      const name = compactName(item, pattern);
      if (name) names.add(name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

/* 模拟组不走 AF 表：实例名和通道都由 analog.js 按厂商约定解析。 */
function instanceNamesForGroup(mcu, group) {
  return group.analogFamily
    ? analogInstances(mcu, group.analogFamily)
    : instancesFor(mcu, group.pattern);
}

function analogInstanceItem(mcu, group, instance) {
  const channels = analogInputs(mcu, group.analogFamily).get(instance) || [];
  return {
    id: instance,
    label: instance,
    type: group.type,
    instance,
    modeled: true,
    status: "可分配",
    analogFamily: group.analogFamily,
    signalCount: channels.length,
    signals: channels.map((candidate) => candidate.channel),
  };
}

function instanceItem(mcu, group, instance) {
  if (group.analogFamily) return analogInstanceItem(mcu, group, instance);
  const functions = mcu.pins.flatMap((pin) => [
    ...pin.functions
      .filter((item) => item.name.startsWith(`${instance}_`))
      .map((item) => ({ ...item, pin })),
    ...pin.additionalFunctions
      .filter((name) => name.startsWith(`${instance}_`))
      .map((name) => ({ name, af: null, pin })),
  ]);
  const signals = [...new Set(functions.map((item) => item.name.slice(instance.length + 1)))];
  return {
    id: instance,
    label: instance,
    type: group.type,
    instance,
    modeled: Boolean(group.type),
    status: group.type ? "可分配" : "可查询",
    signalCount: signals.length,
    signals,
    ...(group.id === "TIMER" ? { timerModes: timerModesForInstance(mcu, instance) } : {}),
  };
}

/* 功能名的家族前缀：`SPI1_SCK` → `SPI1`、`ETH_MDIO` → `ETH`。
   拿它兜底列出所有没被任何分组认领的家族。 */
const FAMILY_PREFIX_RE = /^([A-Z][A-Z0-9]*?\d*)_/;

function genericCatalog(mcu) {
  const claimed = new Set();
  const categories = new Map(GENERIC_CATEGORY_ORDER.map((label) => [label, []]));

  /* 一、已建模、可参与求解的类型。实例名由方言解析，所以 CAN0 和 FDCAN1
     都会落到 FDCAN 这一类下。 */
  for (const [category, types] of Object.entries(GENERIC_CATEGORIES)) {
    for (const type of types) {
      const definition = DEFINITIONS[type];
      const group = {
        id: type,
        label: definition.label,
        type,
        ...(definition.family === "analog" ? { analogFamily: type } : {}),
      };
      for (const instance of instancesForType(mcu, type)) {
        claimed.add(instance);
        categories.get(category).push(instanceItem(mcu, group, instance));
      }
    }
  }

  /* 二、只能查询的家族。 */
  for (const [category, groups] of Object.entries(GENERIC_QUERYABLE)) {
    for (const group of groups) {
      for (const instance of instancesFor(mcu, group.pattern)) {
        claimed.add(instance);
        categories.get(category).push(instanceItem(mcu, group, instance));
      }
    }
  }

  /*
    三、剩下的前缀。数据里有、上面又都没认领的，全部摆进 Other。

    两类要先排除，否则 Other 会塞满其实已经归好类的东西：
    - 模拟通道的原始名。ST 的 `ADC123_INP10` 前缀是逐位展开的，按字面取前缀
      会造出并不存在的 "ADC123" 家族；TI 的 `A0_8` 同理会变成 "A0"。
    - 已建模实例自己的信号。`OTG_HS_ULPI_D0` 按字面取前缀是 "OTG"，
      但它属于已经列出来的 OTG_HS。
  */
  const claimedPrefixes = [...claimed].map((instance) => `${instance}_`);

  const rest = new Map();
  for (const pin of mcu.pins) {
    for (const name of pinFunctionNames(pin)) {
      if (isAnalogFunctionName(mcu, name)) continue;
      if (claimedPrefixes.some((prefix) => name.startsWith(prefix))) continue;
      const match = name.match(FAMILY_PREFIX_RE);
      if (!match || claimed.has(match[1])) continue;
      if (!rest.has(match[1])) rest.set(match[1], new Set());
      rest.get(match[1]).add(name.slice(match[1].length + 1));
    }
  }
  for (const [instance, signals] of [...rest].sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))) {
    categories.get("Other").push({
      id: instance,
      label: instance,
      instance,
      modeled: false,
      status: "可查询",
      signalCount: signals.size,
      signals: [...signals],
    });
  }

  return GENERIC_CATEGORY_ORDER
    .filter((label) => categories.get(label).length > 0)
    .map((label) => ({ id: label.toLowerCase(), label, items: categories.get(label) }));
}

export function buildPeripheralCatalog(mcu, profileId) {
  const profile = getMcuUiProfile(profileId);
  if (profile.generic) return genericCatalog(mcu);
  if (profile.sections) {
    return profile.sections.map((section) => {
      const familyItems = (section.groups || []).flatMap((group) => {
        const names = instanceNamesForGroup(mcu, group);
        return names.map((instance) => instanceItem(mcu, group, instance));
      });
      const staticItems = (section.items || []).map((item) => item.timerMode
        ? {
          ...item,
          availableInstances: familyItems
            .filter((candidate) => candidate.timerModes?.includes(item.timerMode))
            .map((candidate) => candidate.instance),
        }
        : item);
      return {
        id: section.id,
        label: section.label,
        count: section.count,
        items: [...staticItems, ...familyItems],
      };
    });
  }

  return profile.categoryOrder.map((category) => {
    const familyItems = (profile.groups[category] || []).flatMap((group) => {
      const names = instanceNamesForGroup(mcu, group);
      return names.map((instance) => instanceItem(mcu, group, instance));
    });
    const staticItems = profile.staticGroups[category] || [];
    return {
      id: category.toLowerCase().replaceAll(" ", "-"),
      label: category,
      items: [...staticItems, ...familyItems],
    };
  });
}

export function peripheralFunctions(mcu, instance, timerMode = null) {
  /* 模拟实例的通道在 additionalFunctions 里，且 ADC123_INP10 并不以 "ADC1_"
     开头——下面的前缀匹配对它无效，必须先走模拟路径。 */
  const analogFamily = analogFamilyOfInstance(mcu, instance);
  if (analogFamily) return analogFunctions(mcu, analogFamily, instance);

  const bySignal = new Map();
  for (const pin of mcu.pins) {
    for (const item of pin.functions) {
      const belongsToInstance = item.name.startsWith(`${instance}_`)
        || (timerMode === "fault" && instance.startsWith("TIMA") && TIMER_FAULT_RE.test(item.name));
      if (!belongsToInstance) continue;
      if (timerMode && !timerModeSignalMatches(item.name, timerMode)) continue;
      const signal = TIMER_FAULT_RE.test(item.name) ? item.name : item.name.slice(instance.length + 1);
      if (!bySignal.has(signal)) bySignal.set(signal, []);
      bySignal.get(signal).push({ ...item, pin });
    }
    for (const name of pin.additionalFunctions) {
      const belongsToInstance = name.startsWith(`${instance}_`)
        || (timerMode === "fault" && instance.startsWith("TIMA") && TIMER_FAULT_RE.test(name));
      if (!belongsToInstance) continue;
      if (timerMode && !timerModeSignalMatches(name, timerMode)) continue;
      const signal = TIMER_FAULT_RE.test(name) ? name : name.slice(instance.length + 1);
      if (!bySignal.has(signal)) bySignal.set(signal, []);
      bySignal.get(signal).push({ name, af: null, pin });
    }
  }
  return [...bySignal.entries()].sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));
}

export function isPeripheralPin(pin, instance, timerMode = null, mcu = null) {
  if (timerMode && mcu) return timerPinMatches(mcu, pin, instance, timerMode);
  if (mcu) {
    const analogFamily = analogFamilyOfInstance(mcu, instance);
    if (analogFamily) {
      return (analogInputs(mcu, analogFamily).get(instance) || [])
        .some((candidate) => candidate.pin.number === pin.number);
    }
  }
  return Boolean(instance) && (
    pin.functions.some((item) => item.name.startsWith(`${instance}_`))
    || pin.additionalFunctions.some((name) => name.startsWith(`${instance}_`))
  );
}
