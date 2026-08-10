import { analogInputs, analogInstances, isAnalogFamily } from "./analog.js";
import { signalGrammar } from "./dialect.js";
import { SIDES, pinPosition, sideOfPin } from "./package.js";

/*
  外设定义表。每个类型给出：
  - instances: 实例名的正则源码（"SPI\d+"）。只写**规范名**——厂商自己的
               叫法（TI 的 CAN0、TIMA0）由 dialect.js 按器件追加，不在这里堆。
  - signals:   信号名的正则源码，同样只写规范名。
  - variants:  接线变体。变体决定"这一路接口到底要占哪几个信号"，
               这是 per-request 的，不再是全局开关——实际板子上
               UART1 接蓝牙要流控、UART2 是调试口不要，二者必须能共存。
               变体里写的一律是规范信号名，所以同一份变体表对所有厂商通用。

  family: "analog" 的类型走另一条候选构建路径：它们的通道不在 AF 表里，
  而且"要几路"不对应固定的信号名列表——见 combinationsForAnalogInstance。
*/
const DEFINITIONS = {
  SPI: {
    label: "SPI",
    protocol: "spi",
    instances: ["SPI\\d+"],
    signals: ["SCK", "MISO", "MOSI", "NSS"],
    defaultVariant: "full3",
    variants: {
      full3: { label: "全双工 3 线", signals: ["SCK", "MISO", "MOSI"] },
      full4: { label: "全双工 + 硬件 NSS", signals: ["SCK", "MISO", "MOSI", "NSS"] },
      tx2: { label: "单向发送 2 线", signals: ["SCK", "MOSI"] },
    },
  },
  I2C: {
    label: "I²C",
    protocol: "i2c",
    instances: ["I2C\\d+"],
    signals: ["SCL", "SDA"],
    defaultVariant: "std",
    variants: {
      std: { label: "SCL / SDA", signals: ["SCL", "SDA"] },
    },
  },
  UART: {
    label: "UART / USART",
    protocol: "uart",
    instances: ["USART\\d+", "UART\\d+", "LPUART\\d+"],
    signals: ["TX", "RX", "CTS", "RTS"],
    defaultVariant: "duplex",
    variants: {
      duplex: { label: "TX / RX", signals: ["TX", "RX"] },
      flow: { label: "TX / RX + 硬件流控", signals: ["TX", "RX", "CTS", "RTS"] },
      txonly: { label: "仅 TX（单向日志）", signals: ["TX"] },
    },
  },
  FDCAN: {
    label: "FDCAN",
    protocol: "fdcan",
    instances: ["FDCAN\\d+"],
    signals: ["TX", "RX"],
    defaultVariant: "std",
    variants: {
      std: { label: "TX / RX", signals: ["TX", "RX"] },
    },
  },
  SDMMC: {
    label: "SDMMC",
    protocol: "sdmmc",
    instances: ["SDMMC\\d+"],
    signals: [".+"],
    defaultVariant: "bit4",
    variants: {
      bit4: { label: "4-bit 总线", signals: ["CK", "CMD", "D0", "D1", "D2", "D3"] },
      bit1: { label: "1-bit 总线", signals: ["CK", "CMD", "D0"] },
      bit8: {
        label: "8-bit 总线（eMMC）",
        signals: ["CK", "CMD", "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7"],
      },
    },
  },
  QUADSPI: {
    label: "QUADSPI",
    protocol: "quadspi",
    instances: ["QUADSPI"],
    signals: [".+"],
    defaultVariant: "bank1",
    variants: {
      bank1: {
        label: "单 Bank 四线",
        signals: ["CLK", "BK1_IO0", "BK1_IO1", "BK1_IO2", "BK1_IO3", "BK1_NCS"],
      },
      dual: {
        label: "双 Bank 四线",
        signals: [
          "CLK", "BK1_IO0", "BK1_IO1", "BK1_IO2", "BK1_IO3", "BK1_NCS",
          "BK2_IO0", "BK2_IO1", "BK2_IO2", "BK2_IO3", "BK2_NCS",
        ],
      },
    },
  },
  USB: {
    label: "USB OTG",
    protocol: "usb",
    instances: ["OTG_FS", "OTG_HS"],
    signals: [".+"],
    defaultVariant: "device",
    variants: {
      device: { label: "内置 PHY（DM / DP）", signals: ["DM", "DP"] },
      otg: { label: "OTG（DM / DP / ID）", signals: ["DM", "DP", "ID"] },
      ulpi: {
        label: "外部 ULPI PHY（高速）",
        signals: [
          "ULPI_CK", "ULPI_DIR", "ULPI_NXT", "ULPI_STP",
          "ULPI_D0", "ULPI_D1", "ULPI_D2", "ULPI_D3",
          "ULPI_D4", "ULPI_D5", "ULPI_D6", "ULPI_D7",
        ],
      },
    },
  },
  ETH: {
    label: "Ethernet",
    protocol: "eth",
    instances: ["ETH"],
    signals: [".+"],
    defaultVariant: "rmii",
    variants: {
      rmii: {
        label: "RMII + MDIO",
        signals: [
          "RMII_REF_CLK", "RMII_CRS_DV", "RMII_RXD0", "RMII_RXD1",
          "RMII_TX_EN", "RMII_TXD0", "RMII_TXD1", "MDC", "MDIO",
        ],
      },
      mii: {
        label: "MII + MDIO",
        signals: [
          "MII_TX_CLK", "MII_TX_EN", "MII_TXD0", "MII_TXD1", "MII_TXD2", "MII_TXD3",
          "MII_RX_CLK", "MII_RX_DV", "MII_RXD0", "MII_RXD1", "MII_RXD2", "MII_RXD3",
          "MDC", "MDIO",
        ],
      },
    },
  },
  TIM: {
    label: "定时器 PWM",
    protocol: "timer",
    instances: ["TIM\\d+"],
    signals: ["CH[1-4]N?", "ETR", "BKIN"],
    defaultVariant: "pwm1",
    variants: {
      pwm1: { label: "1 路 PWM", signals: ["CH1"] },
      pwm2: { label: "2 路 PWM", signals: ["CH1", "CH2"] },
      pwm3: { label: "3 路 PWM", signals: ["CH1", "CH2", "CH3"] },
      pwm4: { label: "4 路 PWM", signals: ["CH1", "CH2", "CH3", "CH4"] },
      bldc: {
        label: "三相互补 + 刹车",
        signals: ["CH1", "CH1N", "CH2", "CH2N", "CH3", "CH3N", "BKIN"],
      },
    },
  },
  /* 模拟需求说的是"我要 N 路"，具体是哪几条通道由求解器挑——所以变体给
     channels 而不是 signals。通道号最终由被选中的引脚决定。 */
  ADC: {
    label: "ADC 模拟输入",
    protocol: "analog",
    family: "analog",
    defaultVariant: "ch1",
    variants: {
      ch1: { label: "1 路单端输入", channels: 1 },
      ch2: { label: "2 路单端输入", channels: 2 },
      ch4: { label: "4 路单端输入", channels: 4 },
      ch8: { label: "8 路单端输入", channels: 8 },
    },
  },
  DAC: {
    label: "DAC 模拟输出",
    protocol: "analog",
    family: "analog",
    defaultVariant: "out1",
    variants: {
      out1: { label: "1 路输出", channels: 1 },
      out2: { label: "2 路输出", channels: 2 },
    },
  },
};

/* 封装几何全部来自 package.js——求解器打分和界面画图必须用同一份换算，
   否则"靠右"这个偏好在两边指的不是同一条边。 */
export { SIDES, sideOfPin, pinPosition } from "./package.js";

/* 界面按类型排列需求行和"添加"按钮的顺序。放在这里而不是 App.jsx，
   是为了让派生出来的 UI profile 也能拿到同一份顺序。 */
export const PERIPHERAL_TYPE_ORDER = Object.freeze(Object.keys(DEFINITIONS));

/*
  5V 容忍。判定依据是器件数据里显式枚举的 ioStructure 白名单
  （STM32H7: FT/FT_x 耐 5V，TT_x 只到 3.3V）。

  没声明 electrical.fiveVoltTolerantIoStructures 的器件（如 MSPM0，数据里
  所有 GPIO 都是 STD、根本不区分）表示"这颗片子的数据支持不了这条约束"。
  这时必须整体忽略该约束，而不是把每个脚都判成不耐 5V——后者会让求解直接
  无解，且是凭空捏造的结论。
*/
export function supportsFiveVolt(mcu) {
  return Array.isArray(mcu?.electrical?.fiveVoltTolerantIoStructures)
    && mcu.electrical.fiveVoltTolerantIoStructures.length > 0;
}

export function isFiveVoltTolerant(mcu, pin) {
  if (!supportsFiveVolt(mcu)) return null; // 未知，不是 false
  return mcu.electrical.fiveVoltTolerantIoStructures.includes(pin.ioStructure);
}

/*
  复用功能的选择粒度。

  默认（`afGrouping` 省略或为 "pin"）是**逐脚**的：H7 / MSPM0 每个脚自带一个
  AF 选择器，给 USART1_TX 挑 PA9 完全不限制 RX 能挑哪个脚。求解器因此可以
  逐个信号独立挑脚。

  STM32F1 是**整组**的（`afGrouping: "instance"`）：它没有 GPIOx_AFRL/AFRH，
  换脚靠 AFIO_MAPR 里的重映射位，而那是按外设整体切换的。USART1 只有
  `TX=PA9,RX=PA10`（不重映射）和 `TX=PB6,RX=PB7`（重映射）两种合法接法，
  `TX=PA9,RX=PB7` 在硬件上根本不存在。这类器件的 `af` 字段承载的不是 AF 编号
  而是**重映射组号**（0 = 无重映射，1 = 部分，2 = 完全），同一路外设的所有
  信号必须同组。

  注意"部分重映射"下有些信号的脚是不变的（F103 的 TIM3 部分重映射只挪
  CH1/CH2，CH3/CH4 仍在 PB0/PB1）。这种脚要在数据里对同一个功能名登记多条
  af——`TIM3_CH3` 在 PB0 上同时属于组 0 和组 1。
*/
function afGroupingOf(mcu) {
  return mcu?.afGrouping === "instance" ? "instance" : "pin";
}

export function usesRemapGroups(mcu) {
  return afGroupingOf(mcu) === "instance";
}

function pinCost(pin, type) {
  let cost = pin.functions.length * 0.22;
  const specialText = pin.additionalFunctions.join(" ");
  const alternateText = pin.functions.map((item) => item.name).join(" ");
  /* 模拟脚是稀缺资源，数字外设占用要罚分——但正在分配的就是模拟通道时不能罚，
     否则求解器会绕开用户明确要的东西（和下面 TIM 的道理一样）。 */
  if (!isAnalogFamily(type) && /ADC/.test(specialText)) cost += 4;
  /* 高级定时器的脚是稀缺资源，占用要罚分——但正在分配的就是定时器时不能罚，
     否则求解器会绕开用户明确要的东西。 */
  if (type !== "TIM" && /(HRTIM|TIM1_|TIM8_)/.test(alternateText)) cost += 2;
  return cost;
}

/* 布线代价用归一化包围盒的半周长表示：它衡量这一组信号在封装上
   摊开了多大面积，比"各脚到第一个脚的距离和"更贴近实际布线难度，
   对 ETH（9 脚）、SDMMC（6 脚）这种大组尤其明显。 */
function groupSpread(assignments, mcu) {
  const positions = assignments.map((assignment) => pinPosition(assignment.pin.number, mcu));
  const xs = positions.map((position) => position.x);
  const ys = positions.map((position) => position.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return (width + height) * 6;
}

/* 方位偏好分两部分算。对 LQFP 来说"从哪条边出线"是离散事实：顶边右角的脚
   几何上离右边很近，但走线是往上出的，不能算满足"我要它靠右"。所以先按
   是否落在目标边给固定罚分，再叠加几何距离——这样右边排满时会优先退到
   右上角而不是退到左边。两项之和上限 11，压得过引脚代价（单脚 ~2-7 分），
   但仍是软约束：目标边实在排不下时不会导致无解。 */
const SIDE_EDGE_PENALTY = 6;
const SIDE_DISTANCE_WEIGHT = 5;

function pinSidePenalty(pin, side, mcu) {
  const definition = SIDES[side];
  if (!definition) return 0;
  const offEdge = sideOfPin(pin.number, mcu) === side ? 0 : SIDE_EDGE_PENALTY;
  return offEdge + definition.distance(pinPosition(pin.number, mcu)) * SIDE_DISTANCE_WEIGHT;
}

function sidePenalty(assignments, side, mcu) {
  if (!SIDES[side]) return 0;
  const total = assignments.reduce((sum, assignment) => sum + pinSidePenalty(assignment.pin, side, mcu), 0);
  return total / assignments.length;
}

function isUnavailable(pin, options, excluded) {
  if (excluded.has(pin.number)) return true;
  if (options.protectDebug && pin.protection.includes("debug")) return true;
  if (options.protectOscillator && pin.protection.includes("oscillator")) return true;
  return pin.kind !== "gpio";
}

/* 5V 是硬约束：这一路接的是 5V 电平，落到不耐压的脚上就是烧片，
   不能像方位偏好那样降级成罚分。器件数据支持不了这条约束时返回 false
   （放行），由界面负责不给出这个开关。 */
function violatesFiveVolt(mcu, pin, fiveVolt) {
  if (!fiveVolt) return false;
  const tolerant = isFiveVoltTolerant(mcu, pin);
  return tolerant === false;
}

function indexSignals(mcu, type, options, excluded, fiveVolt) {
  /* 匹配规则和信号改名都由方言层给出——这颗片子叫 SPI0_PICO 还是 SPI1_MOSI，
     求解器不需要知道，它只认规范名。 */
  const grammar = signalGrammar(mcu, type, DEFINITIONS[type]);
  const instances = new Map();
  for (const pin of mcu.pins) {
    if (isUnavailable(pin, options, excluded)) continue;
    if (violatesFiveVolt(mcu, pin, fiveVolt)) continue;
    for (const functionItem of pin.functions) {
      const match = functionItem.name.match(grammar.pattern);
      if (!match) continue;
      const [, instance, rawSignal] = match;
      if (!instances.has(instance)) instances.set(instance, new Map());
      const signals = instances.get(instance);
      /* 一个厂商写法可能落到多个规范信号上——CubeMX 库里 ETH_TXD0 一条要同时
         充当 MII_TXD0 和 RMII_TXD0。两边都登记成候选，一次求解只会用到其中
         一套（变体决定要哪些信号），组合枚举的 usedPins 保证不会重复占用。 */
      for (const signal of grammar.normalizeAll(rawSignal)) {
        if (!signals.has(signal)) signals.set(signal, []);
        signals.get(signal).push({ pin, signal, function: functionItem.name, af: functionItem.af });
      }
    }
  }
  return instances;
}

/* 每个外设实例最多保留多少种引脚组合。达到上限说明有组合被丢弃，
   此时即使搜索跑完也不能断言"无解"。 */
const COMBO_LIMIT = 80;
/* 同一实例、同一前缀下最多给几组备选模拟通道。通道可互换，换一组得到的仍是
   同一套外设实例组合、分数也只差一点，备选主要有两个用处：让方案 A/B 之间
   看得出区别，以及在多个模拟组互相抢脚时留出回溯余地（DAC1 只有 PA4/PA5 两个
   脚，而它们同时是 ADC12_INP18/INP19——ADC 抢走就把 DAC 饿死了）。 */
const ANALOG_BRANCH_LIMIT = 8;
/* 单个实例枚举组合时的节点上限。ETH MII（14 信号）、ULPI（12 信号）
   的组合树很深，没有这道闸会在建候选阶段就卡住。 */
const COMBO_NODE_CAP = 40000;
/* 收集多少个候选方案供多样性筛选。远大于 maxSolutions，
   否则 DFS 只会在最深一层微调，产出几乎相同的方案。 */
const POOL_LIMIT = 600;
/* 凑够这么多种不同的"外设实例组合"就收工——足够挑出 5 套差异明显的方案，
   不必把 18 万节点预算跑满。 */
const VARIETY_TARGET = 120;
const NODE_BUDGET = 180000;

function combinationsForInstance(mcu, type, instance, signals, required, limit = COMBO_LIMIT) {
  if (required.some((signal) => !signals.has(signal))) return { list: [], truncated: false };

  /* 关键：每个信号的候选脚先按引脚代价升序，让 DFS 从最便宜的分支开始。
     不排序的话枚举顺序就是引脚编号顺序，limit 个名额会被最先撞上的分支
     灌满——例如 TIM1_CH1N 会锁死在 PA7(#31, 占用 ADC 通道) 上，永远轮不到
     紧邻 CH1 的 PE8(#38)。信号越多（ETH 9 个、三相互补 7 个）偏差越大。 */
  const ordered = new Map();
  for (const signal of required) {
    ordered.set(signal, [...signals.get(signal)].sort(
      (left, right) => pinCost(left.pin, type) - pinCost(right.pin, type)
        || left.pin.number - right.pin.number,
    ));
  }

  /* 整组重映射的器件上，一路外设的所有信号必须同属一个重映射组。见
     afGroupingOf()。在 DFS 里就地剪枝而不是等到叶子再筛：混组的分支一个
     合法解都长不出来，让它展开纯粹是在烧 COMBO_NODE_CAP 的预算。 */
  const uniformAf = usesRemapGroups(mcu);

  const results = [];
  let nodes = 0;
  let capped = false;

  function visit(index, assignments, usedPins) {
    if (results.length >= limit || capped) return;
    if (nodes >= COMBO_NODE_CAP) {
      capped = true;
      return;
    }
    nodes += 1;
    if (index === required.length) {
      const score = assignments.reduce((sum, item) => sum + pinCost(item.pin, type), 0)
        + groupSpread(assignments, mcu);
      const combination = { type, instance, assignments: [...assignments], baseScore: score };
      /* 重映射组号要带出去：导出 HAL 头时得据此写 __HAL_AFIO_REMAP_*。 */
      if (uniformAf && assignments.length > 0) combination.remap = assignments[0].af;
      results.push(combination);
      return;
    }
    const signal = required[index];
    for (const candidate of ordered.get(signal)) {
      if (usedPins.has(candidate.pin.number)) continue;
      if (uniformAf && assignments.length > 0 && candidate.af !== assignments[0].af) continue;
      usedPins.add(candidate.pin.number);
      assignments.push(candidate);
      visit(index + 1, assignments, usedPins);
      assignments.pop();
      usedPins.delete(candidate.pin.number);
    }
  }

  visit(0, [], new Set());
  return {
    list: results.sort((left, right) => left.baseScore - right.baseScore).slice(0, limit),
    truncated: capped || results.length >= limit,
  };
}

/*
  模拟需求不预先枚举组合，只把可用通道池准备好。

  数字外设的组合受"每个信号只有几个候选脚"约束，穷举得起；模拟通道彼此完全
  可互换，一个 14 脚的 ADC 取 8 路就是 C(14,8) = 3003 种，而这些组合之间只是
  换了几个等价的脚，对方案多样性毫无贡献。预枚举必然要截断，一截断就再也
  证明不了无解——而"这块板子到底装不装得下"正是求解器该回答的问题。
  （具体地：RMII 恰好吃掉 ADC1 那 14 个脚里的 6 个，剩下 8 个脚只有唯一一种
  8 通道组合，靠截断后的候选表几乎不可能命中。）

  所以模拟组改在搜索时按"当前还空着哪些脚"现挑，见 analogCandidatesAt()。
*/
function buildAnalogPools(mcu, type, options, excluded, fiveVolt) {
  const entries = [];
  for (const [instance, list] of analogInputs(mcu, type)) {
    const pool = list.filter((candidate) => (
      !isUnavailable(candidate.pin, options, excluded)
      && !violatesFiveVolt(mcu, candidate.pin, fiveVolt)
    ));
    if (pool.length > 0) entries.push({ instance, pool });
  }
  return entries;
}

/*
  给定"已经被占掉的脚"，现挑一组模拟通道。

  取代价最低的 k 个可用脚即可——通道可互换，所以这对可行性是**精确**的：
  只要池子里还剩 k 个空脚就一定挑得出来，不存在"组合被截断所以找不到"。
  代价是 O(池大小) 而不是 O(C(n,k))。

  方位偏好并进单脚代价一起排序，这样"ADC 尽量靠右"依然生效；再按代价顺序
  滑窗给出几组备选，让多套方案之间的模拟通道也有区别。
*/
function analogCandidatesAt(mcu, request, entry, taken) {
  const channels = DEFINITIONS[request.type].variants[request.variant]?.channels;
  if (!channels) return { list: [], capped: false };
  const available = entry.pool.filter((candidate) => !taken(candidate.pin.number));
  /* 可用脚不够 channels 个——这是纯计数结论，与滑窗无关，仍然可以拿来证明无解。 */
  if (available.length < channels) return { list: [], capped: false };

  const ranked = available
    .map((candidate) => ({
      candidate,
      key: pinCost(candidate.pin, request.type) + pinSidePenalty(candidate.pin, request.side, mcu),
    }))
    .sort((left, right) => left.key - right.key || left.candidate.pin.number - right.candidate.pin.number)
    .map((item) => item.candidate);

  const results = [];
  const possible = ranked.length - channels + 1;
  const windows = Math.min(ANALOG_BRANCH_LIMIT, possible);
  for (let start = 0; start < windows; start += 1) {
    const assignments = ranked.slice(start, start + channels).map((candidate) => ({
      pin: candidate.pin,
      signal: candidate.channel,
      function: candidate.function,
      af: null,
    }));
    const score = assignments.reduce((sum, item) => sum + pinCost(item.pin, request.type), 0)
      + groupSpread(assignments, mcu)
      + sidePenalty(assignments, request.side, mcu);
    results.push({
      type: request.type,
      instance: entry.instance,
      variant: request.variant,
      requestId: request.id,
      assignments,
      baseScore: score,
      score,
    });
  }
  return {
    list: results.sort((left, right) => left.score - right.score),
    /* 滑窗没覆盖全部取法时这一路就不算穷举过，上层据此拒绝声称"已确认无解"。 */
    capped: windows < possible,
  };
}

/* 组合是否被截断要**逐实例**记账，不能对整个类型取或。
   请求指定了 SPI2 或 ADC3 时，SPI1 / ADC1 的截断与这一路无关；混为一谈会
   把"已穷举确认无解"降级成"无法判定"——ADC3 只有 4 个 INP 脚，要 8 路本该
   是能证明的无解，却会被 ADC1 那 C(14,8) 的组合爆炸带偏。
   list 为空但 truncated 的条目也要保留，否则截断信号会连同条目一起丢掉。 */
function collectInstances(entries) {
  return entries.filter((entry) => entry.list.length > 0 || entry.truncated);
}

/* 按 (类型, 变体, 耐压要求) 建候选。返回按实例分开的条目——方位偏好是
   per-request 的，要等到具体请求时才能定序，所以这里只算基础分。
   模拟类型返回的是通道池（analogPools），组合留到搜索时才现挑。 */
function buildCandidates(mcu, type, variant, options, excluded, fiveVolt) {
  const definition = DEFINITIONS[type];
  if (definition.family === "analog") {
    return { perInstance: [], analogPools: buildAnalogPools(mcu, type, options, excluded, fiveVolt) };
  }
  const required = definition.variants[variant]?.signals;
  if (!required) return { perInstance: [] };
  const instances = indexSignals(mcu, type, options, excluded, fiveVolt);
  const entries = [];
  for (const [instance, signals] of instances) {
    const built = combinationsForInstance(mcu, type, instance, signals, required);
    entries.push({ instance, list: built.list, truncated: built.truncated });
  }
  return { perInstance: collectInstances(entries) };
}

/* 给一个具体请求定序：先按方位偏好重新打分，再按"实例内排名"轮转交错。
   全局排序会让 DFS 先把某一个实例的 80 种微调组合试完，结果 5 套方案
   只差一两个引脚；交错后每一轮都换一个外设实例。

   注意：top-COMBO_LIMIT 的截断发生在基础分阶段，所以一个"基础分平庸
   但极其贴合方位偏好"的组合可能从未进入这里。80 的余量对 LQFP100 够用。 */
function candidatesForRequest(perInstance, request, mcu) {
  const relevant = perInstance.filter((entry) => !request.instance || entry.instance === request.instance);
  const lists = relevant
    .map((entry) => entry.list
      .map((combo) => ({
        ...combo,
        variant: request.variant,
        requestId: request.id,
        score: combo.baseScore + sidePenalty(combo.assignments, request.side, mcu),
      }))
      .sort((left, right) => left.score - right.score))
    .filter((list) => list.length > 0);

  const depth = Math.max(...lists.map((list) => list.length), 0);
  const ordered = [];
  for (let rank = 0; rank < depth; rank += 1) {
    const row = lists
      .map((list) => list[rank])
      .filter(Boolean)
      .sort((left, right) => left.score - right.score);
    ordered.push(...row);
  }
  /* 只有这一路真正会用到的实例发生截断，才影响这一路的"无解可证明性" */
  return { ordered, truncated: relevant.some((entry) => entry.truncated) };
}

function pinSetOf(groups) {
  return new Set(groups.flatMap((group) => group.assignments.map((item) => item.pin.number)));
}

function pinDifference(left, right) {
  let diff = 0;
  for (const number of left) if (!right.has(number)) diff += 1;
  return diff;
}

/* 从候选池里挑出彼此差异尽量大的 limit 套方案。按分数排序保证 A 仍是最优解，
   然后分三轮放宽标准：先要求换外设实例且引脚差异大，再只要求换实例，
   最后才退到"引脚不完全相同"。工程上最有价值的差异是选了不同的外设，
   所以实例差异优先于引脚差异。 */
function selectDiverse(pool, limit) {
  if (pool.length <= 1) return pool.slice(0, limit);
  const sorted = [...pool].sort((left, right) => left.score - right.score);
  const pins = new Map(sorted.map((solution) => [solution, pinSetOf(solution.groups)]));
  const instances = new Map(sorted.map((solution) => [
    solution,
    solution.groups.map((group) => `${group.type}:${group.instance}`).sort().join(","),
  ]));
  const total = pins.get(sorted[0]).size || 1;
  const wide = Math.max(2, Math.round(total * 0.25));
  const picked = [sorted[0]];

  const rounds = [
    (set, key) => picked.every((c) => instances.get(c) !== key && pinDifference(set, pins.get(c)) >= wide),
    (set, key) => picked.every((c) => instances.get(c) !== key),
    (set) => picked.every((c) => pinDifference(set, pins.get(c)) >= 1),
  ];

  for (const accepts of rounds) {
    for (const candidate of sorted) {
      if (picked.length >= limit) break;
      if (picked.includes(candidate)) continue;
      if (accepts(pins.get(candidate), instances.get(candidate))) picked.push(candidate);
    }
    if (picked.length >= limit) break;
  }
  /* 每一轮都从头扫 sorted，所以放宽标准后可能挑到比前面更优的候选。
     最后统一按分数排序，保证方案 A 始终是最优解、且 A→E 分数递增。 */
  return picked.sort((left, right) => left.score - right.score);
}

function solutionKey(groups) {
  return groups
    .map((group) => `${group.type}:${group.instance}:${group.assignments.map((item) => item.pin.number).sort((a, b) => a - b).join("-")}`)
    .sort()
    .join("|");
}

/* 列出某个类型在这颗片子上真实存在的实例（供 UI 的"指定实例"下拉用）。 */
export function instancesForType(mcu, type) {
  const definition = DEFINITIONS[type];
  if (!definition) return [];
  if (definition.family === "analog") return analogInstances(mcu, type);
  const grammar = signalGrammar(mcu, type, definition);
  const names = new Set();
  for (const pin of mcu.pins) {
    for (const item of pin.functions) {
      const match = item.name.match(grammar.pattern);
      if (match) names.add(match[1]);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

let autoRequestId = 0;

/* 需求既接受新的请求数组，也接受老的 {SPI:2, I2C:1} 计数对象。
   老形式配合 options.includeNss / flowControl / fixedInstances 翻译成请求，
   这样既有的调用方和测试不用改。 */
function normalizeRequests(requirements, options) {
  if (Array.isArray(requirements)) {
    return requirements
      .filter((request) => DEFINITIONS[request?.type])
      .map((request, index) => {
        const definition = DEFINITIONS[request.type];
        const variant = definition.variants[request.variant] ? request.variant : definition.defaultVariant;
        return {
          id: request.id ?? `req-${index}`,
          type: request.type,
          variant,
          instance: request.instance || null,
          side: SIDES[request.side] ? request.side : null,
          fiveVolt: Boolean(request.fiveVolt),
        };
      });
  }

  const legacyVariant = {
    SPI: options.includeNss ? "full4" : "full3",
    UART: options.flowControl ? "flow" : "duplex",
  };
  const requests = [];
  for (const [type, count] of Object.entries(requirements || {})) {
    if (!DEFINITIONS[type]) continue;
    const fixed = (options.fixedInstances?.[type] || []).filter(Boolean);
    for (let index = 0; index < (Number(count) || 0); index += 1) {
      requests.push({
        id: `legacy-${type}-${index}`,
        type,
        variant: legacyVariant[type] || DEFINITIONS[type].defaultVariant,
        instance: fixed[index] || null,
        side: null,
        fiveVolt: false,
      });
    }
  }
  return requests;
}

export function createRequest(type, overrides = {}) {
  const definition = DEFINITIONS[type];
  autoRequestId += 1;
  return {
    id: `r${autoRequestId}`,
    type,
    variant: definition?.defaultVariant || "std",
    instance: null,
    side: null,
    fiveVolt: false,
    ...overrides,
  };
}

export function allocatePins(mcu, requirements, options = {}, lockedGroups = []) {
  const normalizedOptions = {
    protectDebug: true,
    protectOscillator: true,
    excludedPins: [],
    maxSolutions: 5,
    ...options,
  };
  const excluded = new Set(normalizedOptions.excludedPins);
  const requests = normalizeRequests(requirements, normalizedOptions);

  const cache = new Map();
  /* 缓存键必须带上耐压要求：同一次求解里可能既有一路 5V SPI 又有一路普通
     SPI，两者的候选池不同，共用一个 key 会让后来的那路拿到错误的候选。 */
  function candidatePoolFor(type, variant, fiveVolt) {
    const key = `${type}|${variant}|${fiveVolt ? "5v" : "any"}`;
    if (!cache.has(key)) {
      cache.set(key, buildCandidates(mcu, type, variant, normalizedOptions, excluded, fiveVolt));
    }
    return cache.get(key);
  }

  /* 每把锁认领一个还没被认领的同类请求。认领不到（用户锁完又删了需求行）
     就剥离并通过 droppedLocks 回报，否则结果里的组数会多于需求。 */
  const claimed = new Set();
  const keptLocks = [];
  const droppedLocks = [];
  for (const group of lockedGroups) {
    const request = requests.find((item) => (
      !claimed.has(item.id)
      && item.type === group.type
      && (!item.instance || item.instance === group.instance)
      && (!group.variant || group.variant === item.variant)
    ));
    if (request) {
      claimed.add(request.id);
      keptLocks.push({ ...group, requestId: request.id, variant: group.variant || request.variant });
    } else {
      droppedLocks.push({ type: group.type, instance: group.instance });
    }
  }

  const lockedPins = new Set(keptLocks.flatMap((group) => group.assignments.map((item) => item.pin.number)));
  const lockedInstances = new Set(keptLocks.map((group) => `${group.type}:${group.instance}`));

  /* 候选少的请求先排——固定了实例、或信号多到几乎没得选的（ETH、SDMMC）
     放在最前面能最早剪枝。 */
  const tasks = requests
    .filter((request) => !claimed.has(request.id))
    .map((request) => {
      const pool = candidatePoolFor(request.type, request.variant, request.fiveVolt);
      if (pool.analogPools) {
        /* 模拟组的候选要等搜索时才知道（取决于哪些脚还空着），这里只筛实例。
           排序键取"余量"= 最大通道池 − 所需通道数：余量小的先排。
           DAC1 只有 PA4/PA5 两个脚（余量 0），而这两个脚同时是 ADC12_INP18/INP19；
           让余量大的 ADC 先挑就会把 DAC 饿死。 */
        const entries = pool.analogPools.filter((entry) => !request.instance || entry.instance === request.instance);
        const channels = DEFINITIONS[request.type].variants[request.variant]?.channels || 1;
        const slack = Math.max(0, Math.max(...entries.map((entry) => entry.pool.length), 0) - channels);
        return { request, analogEntries: entries, candidates: [], analog: true, order: slack, truncated: false };
      }
      const built = candidatesForRequest(pool.perInstance, request, mcu);
      return { request, candidates: built.ordered, analog: false, order: built.ordered.length, truncated: built.truncated };
    })
    /* 数字外设先排（候选少的最先，最早剪枝），模拟组统一排在后面——它们最灵活，
       该等数字外设占完再从剩下的脚里挑。模拟组之间再按余量升序。 */
    .sort((left, right) => Number(left.analog) - Number(right.analog) || left.order - right.order);
  const truncated = tasks.some((task) => task.truncated);

  const pool = [];
  const seen = new Set();
  /* 每种"外设实例组合"最多收几套方案。不设上限的话候选池会被
     最深一层的同一组实例灌满，多样性筛选也就无米可炊。 */
  const perInstanceSet = new Map();
  let visited = 0;
  let exhausted = false;
  /* 模拟组的滑窗没覆盖全部取法时置位——与 truncated 同义：搜索没跑完，
     不能声称"已确认无解"。 */
  let analogCapped = false;
  const maxNodes = Number(normalizedOptions.nodeBudget) || NODE_BUDGET;

  function visit(taskIndex, groups, usedPins, usedInstances, score) {
    if (pool.length >= POOL_LIMIT || perInstanceSet.size >= VARIETY_TARGET) return;
    if (visited >= maxNodes) {
      exhausted = true;
      return;
    }
    visited += 1;
    if (taskIndex === tasks.length) {
      const allGroups = [...keptLocks, ...groups];
      const key = solutionKey(allGroups);
      if (seen.has(key)) return;
      seen.add(key);
      const instanceSet = allGroups.map((group) => `${group.type}:${group.instance}`).sort().join(",");
      const count = perInstanceSet.get(instanceSet) || 0;
      if (count >= 3) return;
      perInstanceSet.set(instanceSet, count + 1);
      pool.push({ groups: allGroups, score });
      return;
    }

    const task = tasks[taskIndex];
    /* 模拟组的候选取决于此刻还剩哪些脚，所以现算；数字外设的候选是预先建好的。 */
    let candidates = task.candidates;
    if (task.analog) {
      const taken = (number) => usedPins.has(number) || lockedPins.has(number);
      candidates = [];
      for (const entry of task.analogEntries) {
        const instanceKey = `${task.request.type}:${entry.instance}`;
        if (usedInstances.has(instanceKey) || lockedInstances.has(instanceKey)) continue;
        const built = analogCandidatesAt(mcu, task.request, entry, taken);
        if (built.capped) analogCapped = true;
        candidates.push(...built.list);
      }
      candidates.sort((left, right) => left.score - right.score);
    }

    for (const candidate of candidates) {
      const instanceKey = `${candidate.type}:${candidate.instance}`;
      if (usedInstances.has(instanceKey) || lockedInstances.has(instanceKey)) continue;
      if (candidate.assignments.some((item) => usedPins.has(item.pin.number) || lockedPins.has(item.pin.number))) continue;
      candidate.assignments.forEach((item) => usedPins.add(item.pin.number));
      usedInstances.add(instanceKey);
      groups.push({ ...candidate, locked: false });
      visit(taskIndex + 1, groups, usedPins, usedInstances, score + candidate.score);
      groups.pop();
      usedInstances.delete(instanceKey);
      candidate.assignments.forEach((item) => usedPins.delete(item.pin.number));
    }
  }

  visit(0, [], new Set(), new Set(), keptLocks.reduce((sum, group) => sum + (group.score || 0), 0));

  const solutions = selectDiverse(pool, normalizedOptions.maxSolutions);
  return {
    solutions,
    requests,
    visited,
    poolSize: pool.length,
    /* exhausted: 节点预算用尽，搜索没跑完
       truncated: 某个实例的组合数触及 COMBO_LIMIT，有组合从未进入搜索
       proven:    "确认无解"——只有一个方案都没找到、且搜索完整跑完时才为 true。
                  有解时恒为 false，避免被误读成"这就是全部方案"。 */
    exhausted,
    truncated: truncated || analogCapped,
    proven: pool.length === 0 && !exhausted && !truncated && !analogCapped,
    droppedLocks,
    /* 模拟组没有预建候选表，报可用通道数——那才是"这一路还有多少余地"。 */
    candidates: Object.fromEntries(tasks.map((task) => [
      task.request.id,
      task.analogEntries
        ? task.analogEntries.reduce((sum, entry) => sum + entry.pool.length, 0)
        : task.candidates.length,
    ])),
  };
}

const PROTOCOL_PATTERNS = [
  [/^SPI\d+_/, "spi"],
  [/^I2C\d+_/, "i2c"],
  [/^(USART|UART|LPUART)\d+_/, "uart"],
  [/^(FDCAN|CAN)\d+_/, "fdcan"],
  [/^SDMMC\d+_/, "sdmmc"],
  [/^QUADSPI_/, "quadspi"],
  [/^OTG_/, "usb"],
  [/^ETH_/, "eth"],
  [/^(TIM|TIMA|TIMG|HRTIM|LPTIM)/, "timer"],
  /* ST 的 ADC123_INP10 / DAC1_OUT1，TI 的 A0_8 / DAC_OUT */
  [/^(ADC\d*|DAC\d*|A\d+)_/, "analog"],
];

export function protocolForFunction(name) {
  for (const [pattern, protocol] of PROTOCOL_PATTERNS) {
    if (pattern.test(name)) return protocol;
  }
  return "other";
}

export { DEFINITIONS };
