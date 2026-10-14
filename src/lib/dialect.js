/*
  信号方言。

  同一条物理信号，各家 datasheet 的名字不一样：ST 叫 `SPI1_MOSI`，TI MSPM0 叫
  `SPI0_PICO`；ST 的定时器通道是 `TIM1_CH1`，TI 是 `TIMA0_C0`；ST 的 CAN 实例
  叫 `FDCAN1`，TI 叫 `CAN0`。求解器内部只认一套**规范名**（沿用 ST 的写法），
  厂商名字在进入求解器之前由这一层翻译掉。

  为什么单独一层，而不是像以前那样把各家名字塞进同一个正则、再跟一串 if：

  - 正则会越堆越长，而且互相污染——`(?:FDCAN|CAN)\d+_` 让 ST 器件也去匹配
    并不存在的 `CAN1_TX`。
  - 翻译规则本来就与器件绑定，第三家一来只能继续堆 if。
  - `PICO → MISO` / `POCI → MOSI` 曾经译反过（PICO = Peripheral In / Controller
    Out，控制器这侧是输出，对应 MOSI）。埋在 if 链里看不出来，摆成对照表就
    一目了然，也能直接和 datasheet 逐行核对。

  器件数据用 `signalDialect` 字段选方言，省略等同于 `"st"`。方言只**追加**
  别名，不删除规范名：同一颗片子上两种写法并存也能解析。
*/

/*
  每种方言按外设类型给三样东西（都可省略）：
  - instances: 追加的实例名模式（正则源码字符串）
  - signals:   追加的信号名模式
  - rename:    [模式, 规范名] 对照表。规范名可以是字符串、拿到 match 数组的
               函数（定时器通道要做 C0 → CH1 的编号平移），也可以是**字符串
               数组**——一个厂商名对应多个规范名，见下面 ETH 的说明。
*/
const DIALECTS = {
  st: {
    label: "STMicroelectronics",
    types: {
      /*
        以太网的 MII / RMII 之分。

        datasheet 的 AF 表把模式写进信号名（ETH_MII_TXD0 / ETH_RMII_REF_CLK），
        CubeMX 的器件库却用模式中立的写法（ETH_TXD0 / ETH_REF_CLK）——因为它
        在外设层选模式，不在引脚层。两种数据源都要能进求解器，而变体表
        （rmii / mii）认的是带模式限定的规范名，所以中立写法要在这里翻译。

        三类信号，翻译方式不同：
        - 名字本身就区分模式的，1:1 直译（RX_CLK 只存在于 MII，REF_CLK 只存在
          于 RMII，两者在 PA1 上是库里并列的两条）；
        - MII 独有的（4 位数据线、独立收发时钟、载波/冲突检测），加 MII_ 前缀；
        - **两种模式共用同一个脚的**（TXD0/TXD1/TX_EN/RXD0/RXD1），一个厂商名
          要同时充当 MII_ 和 RMII_ 两个规范名——库里 PB12 只写了一条 ETH_TXD0，
          但它在两种模式下都是那根线。这就是 rename 允许给数组的原因。

        注意这不会让求解器把一个脚同时算作两路：候选是按 (实例, 规范信号) 索引
        的，而一次求解只会选中 rmii 或 mii 其中一套信号，组合枚举里的 usedPins
        又保证同一个脚不会在一组内被用两次。
      */
      ETH: {
        rename: [
          /* 名字自带模式区分：直译 */
          ["REF_CLK", "RMII_REF_CLK"],
          ["CRS_DV", "RMII_CRS_DV"],
          ["RX_CLK", "MII_RX_CLK"],
          ["RX_DV", "MII_RX_DV"],
          /* MII 独有 */
          ["TX_CLK", "MII_TX_CLK"],
          ["TXD2", "MII_TXD2"],
          ["TXD3", "MII_TXD3"],
          ["RXD2", "MII_RXD2"],
          ["RXD3", "MII_RXD3"],
          ["RX_ER", "MII_RX_ER"],
          ["CRS", "MII_CRS"],
          ["COL", "MII_COL"],
          /* 两种模式共用同一根线 */
          ["TX_EN", ["MII_TX_EN", "RMII_TX_EN"]],
          ["TXD0", ["MII_TXD0", "RMII_TXD0"]],
          ["TXD1", ["MII_TXD1", "RMII_TXD1"]],
          ["RXD0", ["MII_RXD0", "RMII_RXD0"]],
          ["RXD1", ["MII_RXD1", "RMII_RXD1"]],
        ],
      },
      /*
        以下三条都是"datasheet 写法 vs CubeMX 库写法"的差异。手工录入的固化器件
        （H743）按 datasheet 写 OTG_HS_DM、SDMMC1_CK，而按需从 CubeMX 库转换的
        器件写 USB_OTG_HS_DM、SDIO_CK（F4 的老名字）、CAN1_TX（F4/F7 的 bxCAN）。
        不追加的话，选了一颗按需转换的 F407，USB / SD / CAN 需求都会无解。

        CAN 的实例名只是一层壳：bxCAN 和 FDCAN 在引脚层都是一对 TX/RX，求解器
        要回答的是"脚够不够、冲不冲突"。H7 这类器件库里根本没有 CAN1_ 开头的
        信号，追加这条不会让它们匹配到不存在的东西。
      */
      USB: { instances: ["USB_OTG_FS", "USB_OTG_HS"] },
      SDMMC: { instances: ["SDIO"] },
      FDCAN: { instances: ["CAN\\d+"] },
      /* 只有一个 bank 的 QUADSPI（L4、F7 部分型号）片选叫 NCS，就是 BK1 的片选 */
      QUADSPI: { rename: [["NCS", "BK1_NCS"]] },
    },
  },
  /*
    STM32F1 与新系列的两处叫法差异。单独一份方言而不是并进 `st`：把
    `CAN\d+` 加进基础方言会让 H7 这类器件也去匹配并不存在的 `CAN1_TX`，
    正是这个文件开头警告过的那种污染。
  */
  "st-f1": {
    label: "STMicroelectronics (F1)",
    types: {
      /* F1 上是 bxCAN，没有 FD。实例号可有可无：RM0008 和 HAL 宏写 CAN1
         （__HAL_AFIO_REMAP_CAN1_1），但 ST 官方的 STM32_open_pin_data 里
         中容量 F103 只有一路 CAN，信号名就写作裸的 CAN_TX / CAN_RX。
         两种写法都要认，否则从官方 XML 导入的数据会一条都匹配不上。 */
      FDCAN: {
        instances: ["CAN\\d*"],
      },
      /* F1 的 USB 是独立的设备控制器，不叫 OTG_FS。信号名沿用 CubeMX 的
         USB_DM / USB_DP（datasheet 引脚表里写作 USBDM / USBDP）。 */
      USB: {
        instances: ["USB"],
      },
      /* F103 大容量（RCT6/ZET6）的 SD 卡接口叫 SDIO */
      SDMMC: { instances: ["SDIO"] },
    },
  },
  "ti-mspm0": {
    label: "TI MSPM0",
    types: {
      SPI: {
        /* PICO = Peripheral In / Controller Out —— 控制器这侧是输出，即 MOSI。
           POCI 同理是输入，即 MISO。译反了不会让求解失败（两个脚照样都分到），
           但导出的 CSV 和 HAL 头文件会把两根线标反。 */
        signals: ["PICO", "POCI", "CS\\d+"],
        rename: [["PICO", "MOSI"], ["POCI", "MISO"], ["CS\\d+", "NSS"]],
      },
      FDCAN: {
        instances: ["CAN\\d+"],
      },
      TIM: {
        instances: ["TIMA\\d+", "TIMG\\d+"],
        /* TI 的通道从 C0 起编号，ST 从 CH1 起——差一位，不是改个前缀而已。 */
        signals: ["C[0-3]N?"],
        rename: [["C([0-3])(N?)", (match) => `CH${Number(match[1]) + 1}${match[2]}`]],
      },
    },
  },
};

export const SIGNAL_DIALECTS = Object.keys(DIALECTS);

export function dialectIdOf(mcu) {
  const id = mcu?.signalDialect;
  return id && DIALECTS[id] ? id : "st";
}

export function dialectLabel(id) {
  return DIALECTS[id]?.label || id;
}

/*
  (方言, 类型) → 解析语法。整份数据每个功能名都要跑一次匹配，H743 一颗片子
  就有 700 多个功能名，所以按 key 缓存编译好的正则。
*/
const grammarCache = new Map();

export function signalGrammar(mcu, type, definition) {
  const dialectId = dialectIdOf(mcu);
  const key = `${dialectId}|${type}`;
  const cached = grammarCache.get(key);
  if (cached) return cached;

  const extra = DIALECTS[dialectId].types[type] || {};
  const instances = [...(definition.instances || []), ...(extra.instances || [])];
  const signals = [...(definition.signals || []), ...(extra.signals || [])];
  const renames = (extra.rename || []).map(([source, target]) => [new RegExp(`^${source}$`), target]);

  const grammar = {
    pattern: new RegExp(`^(${instances.join("|")})_(${signals.join("|")})$`),
    instancePattern: new RegExp(`^(${instances.join("|")})_`),
    /* 一个厂商写法可能对应多个规范名（ETH 上 MII 与 RMII 共用的那几根线），
       所以规范化的结果一律是数组。 */
    normalizeAll(rawSignal) {
      for (const [pattern, target] of renames) {
        const match = rawSignal.match(pattern);
        if (!match) continue;
        if (Array.isArray(target)) return target;
        return [typeof target === "function" ? target(match) : target];
      }
      return [rawSignal];
    },
    /* 只要一个名字的调用方（抽检、方言回归）用这个；一对多时取第一个。 */
    normalize(rawSignal) {
      return grammar.normalizeAll(rawSignal)[0];
    },
  };
  grammarCache.set(key, grammar);
  return grammar;
}
