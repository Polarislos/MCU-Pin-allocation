/*
  从 STM32CubeMX 的器件库导出符合 src/data/mcu.schema.json 的引脚数据。

  用法：
    node tools/import-stm32.mjs --part STM32F103C8T6 --db D:/CubeMX/db
    node tools/import-stm32.mjs --part STM32H743VIT6 --dry-run
    （--db 省略时依次尝试常见安装路径，也可用环境变量 CUBEMX_DB）

  同一份数据 ST 也发布在 github.com/STMicroelectronics/STM32_open_pin_data
  （BSD-3-Clause，约 11.5 MB），目录结构与 CubeMX 的 db/ 一致，--db 指向仓库
  根下的同名层级即可。

  ── 数据来自两个文件，缺一不可 ────────────────────────────────────────
  1. db/mcu/<RefName>.xml       封装、脚号、脚名、每个脚有哪些 Signal
  2. db/mcu/IP/GPIO-<ver>_Modes.xml   AF 编号 / 重映射组

  第一个文件的 <Signal Name="USART1_TX"/> 只说"这个脚能做 USART1_TX"，不含
  AF 编号。第二个文件的名字不用猜，第一个文件里写着：
      <IP Name="GPIO" Version="STM32F103x8_gpio_v1_0"/>
  拼成 mcu/IP/GPIO-{Version}_Modes.xml 即可。

  ── AF 层有两种形态，对应 schema 的 afGrouping ──────────────────────
  逐脚选择（H7/F4/G4…，afGrouping: "pin"）：
      <PinSignal Name="USART1_TX">
        <SpecificParameter Name="GPIO_AF">
          <PossibleValue>GPIO_AF7_USART1</PossibleValue>
  → 抓出 af: 7。

  整组重映射（F1，afGrouping: "instance"）：
      <PinSignal Name="USART1_TX">
        <RemapBlock Name="USART1_REMAP1">
          <SpecificParameter Name="GPIO_AF">
            <PossibleValue>__HAL_AFIO_REMAP_USART1_ENABLE</PossibleValue>
  → af 承载重映射组号，PossibleValue 进 remapMacros。

  ── 三个不能想当然的地方 ────────────────────────────────────────────
  (1) REMAP<n> 里的 n 不是可靠的逻辑序号。ST 在 2024 年后的库里把 TIM3 改成了
      寄存器位值（REMAP0/2/3，中间空一档，因为 RM0008 里 01 未使用），却没动
      同样是 00/10/11 编码的 CAN（仍是 REMAP0/1/2）。所以本脚本一律按出现的
      块**重新编号成连续的 0..n-1**，寄存器的真实编码交给 remapMacros 里的
      HAL 宏承载。两个版本的库因此产出相同结果。

  (2) GPIO IP 文件是按 die 分的，不按封装。F103x8 里 TIM3 的完全重映射指向
      PC6-PC9，而 LQFP48 根本没引出这几个脚。所以每一档都要与本封装的引脚表
      求交集，整档落空就丢弃，丢弃后再重新编号。

  (3) F1 的 GPIO IP 只列**有重映射选项**的外设。SPI2 / I2C2 这类固定脚外设
      压根不在里面，但它们是实打实的复用功能，必须补进 functions（组 0），
      否则求解器会认为这颗片子没有 SPI2。

  ── 唯一导不出来的字段 ──────────────────────────────────────────────
  electrical.fiveVoltTolerantIoStructures（5V 耐压白名单）。整个 CubeMX 库里
  没有任何 FT / TTa / TC 信息，只能查 datasheet 的引脚定义表。本脚本因此不写
  electrical——allocator.js 的约定是"没声明就隐藏 5V 开关"，而不是把所有脚判成
  不耐压，所以留空是安全的降级，补上之后 5V 约束才会出现在界面里。
*/
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseXml, childrenNamed, firstNamed, descendantsNamed } from "./xml.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const DEFAULT_DB_PATHS = [
  process.env.CUBEMX_DB,
  "D:/CubeMX/db",
  "C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX/db",
  "C:/ST/STM32CubeMX/db",
].filter(Boolean);

/* ── CLI ──────────────────────────────────────────────────────────── */


function resolveDb(explicit) {
  const candidates = explicit ? [explicit] : DEFAULT_DB_PATHS;
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "mcu"))) return candidate;
  }
  throw new Error(
    `找不到 CubeMX 器件库。试过：${candidates.join(", ")}\n`
    + "用 --db 指定，或设环境变量 CUBEMX_DB。它应该是含 mcu/ 子目录的那一层。",
  );
}

/*
  RefName → 具体型号的匹配。

  括号里是短横分隔的**枚举**而不是范围——库里存在 (G-E) 这种顺序颠倒的写法，
  按范围解释会漏掉一半。末尾的 x 是温度/质量等级占位符，匹配任意一个字符。
*/
function refNameMatches(refName, part) {
  const alternatives = [""];
  let buffer = alternatives;
  const expand = (prefix, rest) => {
    const open = rest.indexOf("(");
    if (open === -1) return [prefix + rest];
    const close = rest.indexOf(")", open);
    const head = prefix + rest.slice(0, open);
    const options = rest.slice(open + 1, close).split("-");
    return options.flatMap((option) => expand(head + option, rest.slice(close + 1)));
  };
  buffer = expand("", refName);

  const target = part.toUpperCase();
  return buffer.some((candidate) => {
    const pattern = new RegExp(`^${candidate.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/X/g, ".")}$`);
    return pattern.test(target);
  });
}

async function findDeviceFile(db, part) {
  const dir = path.join(db, "mcu");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".xml"));
  const matches = files.filter((file) => refNameMatches(file.replace(/\.xml$/, ""), part));
  if (matches.length === 0) {
    throw new Error(`在 ${dir} 里找不到覆盖 ${part} 的器件文件`);
  }
  if (matches.length > 1) {
    throw new Error(`${part} 匹配到多个器件文件，请确认型号：\n  ${matches.join("\n  ")}`);
  }
  return path.join(dir, matches[0]);
}

/* ── 解析 ─────────────────────────────────────────────────────────── */

/*
  非复用功能的识别。这些名字在 mcu XML 里与外设信号并排出现，但它们不是
  "可以分配给某一路外设的复用功能"，而是引脚自带的模拟通道或系统功能，
  应该进 additionalFunctions（求解器对模拟通道走的是另一条候选构建路径）。
*/
const ANALOG_SIGNAL = /^ADC\d*_IN[A-Z]?\d+$/;
/* SYS_WKUP 是唤醒输入，不是可分配的复用功能——它和 RCC_OSC / RTC_ 一样属于
   引脚自带的系统功能。注意不能整个 SYS_ 前缀都算进来：SYS_JTMS-SWDIO 这类
   调试口在 H7 上是有真实 AF 编号的复用功能。 */
const SYSTEM_SIGNAL = /^(SYS_WKUP|RCC_OSC|RCC_MCO|RTC_|WKUP)/;
/* EXTI 是中断线映射，不占用复用功能，也不该出现在接线表里 */
const NOISE_SIGNAL = /_EXTI\d+$/;

/* MonoIO 是只有单一固定用途的引脚（H743 上是 VREF+），不是可分配的 GPIO。 */
const PIN_KIND = { "I/O": "gpio", Power: "supply", Reset: "special", Boot: "special", MonoIO: "supply" };

/*
  拆解库里的脚名。三种修饰会同时出现，且各有含义：

    PA13 (JTMS/SWDIO)          括号里是复位后的默认用途
    PC14-OSC32_IN (OSC32_IN)   短横后是该脚兼任的系统功能
    PH0-OSC_IN (PH0)           括号里反而是 GPIO 名（振荡器脚的写法反过来）
    PC2_C                      H7 双焊盘脚，_C 是直连模拟通道的那一版
    PA0-WKUP                   短横后是唤醒功能

  拆出三样东西：
  - base:  纯 GPIO 名（PA13 / PC14 / PC2），用于查 GPIO IP、算端口和位号。
           export.js 是按 name.slice(1,2)/slice(2) 取端口和位的，留着 _C
           会生成 GPIO_PIN_2_C 这种编译不过的宏。
  - reset: 库里的完整写法（去掉括号前的空格），原样留档。
  - extra: 短横后的系统功能，进 additionalFunctions。

  注意 GPIO IP 那边对 PC2_C 用的是 PC2，对 PA13 却用带括号的全名——所以查表
  时全名和 base 都要试。
*/
function splitPinName(fullName) {
  const reset = fullName.replace(/\s+\(/, "(");
  const withoutAlias = fullName.replace(/\s*\([^)]*\)\s*$/, "");
  const match = /^(P[A-Z]\d+)(_C)?(?:-(.+))?$/.exec(withoutAlias);
  if (!match) return { base: withoutAlias, reset, extra: null };
  return { base: match[1], reset, extra: match[3] || null };
}

function parseMcuFile(source) {
  const root = parseXml(source);
  const pins = descendantsNamed(root, "Pin").map((node) => ({
    fullName: node.attrs.Name,
    position: Number(node.attrs.Position),
    type: node.attrs.Type,
    signals: childrenNamed(node, "Signal")
      .map((signal) => signal.attrs.Name)
      .filter((name) => name && name !== "GPIO" && !NOISE_SIGNAL.test(name)),
  }));

  const gpioIp = descendantsNamed(root, "IP").find((node) => node.attrs.Name === "GPIO");
  if (!gpioIp) throw new Error("器件文件里没有 GPIO 的 <IP> 条目，无法定位 AF 数据");

  return {
    refName: root.attrs.RefName,
    family: root.attrs.Family,
    line: root.attrs.Line,
    package: root.attrs.Package,
    core: firstNamed(root, "Core")?.text || "",
    ioCount: Number(firstNamed(root, "IONb")?.text || 0),
    gpioVersion: gpioIp.attrs.Version,
    pins,
  };
}

/*
  GPIO IP → Map<脚名, Map<信号名, 条目>>。

  条目要么是 { af }（逐脚选择），要么是 { blocks: [{ instance, index, macro,
  isDefault }] }（整组重映射，同一个信号可能出现在多档里）。
*/
function parseGpioFile(source) {
  const root = parseXml(source);
  const byPin = new Map();
  let sawRemap = false;

  for (const pinNode of descendantsNamed(root, "GPIO_Pin")) {
    const signals = new Map();
    for (const signalNode of childrenNamed(pinNode, "PinSignal")) {
      const remapNodes = childrenNamed(signalNode, "RemapBlock");
      if (remapNodes.length > 0) {
        sawRemap = true;
        signals.set(signalNode.attrs.Name, {
          blocks: remapNodes.map((node) => {
            const match = /^(.*)_REMAP(\d+)$/.exec(node.attrs.Name);
            if (!match) throw new Error(`看不懂的 RemapBlock 名字：${node.attrs.Name}`);
            return {
              instance: match[1],
              index: Number(match[2]),
              isDefault: node.attrs.DefaultRemap === "true",
              macro: possibleValue(node),
            };
          }),
        });
      } else {
        const value = possibleValue(signalNode);
        const match = value && /GPIO_AF(\d+)_/.exec(value);
        signals.set(signalNode.attrs.Name, { af: match ? Number(match[1]) : null });
      }
    }
    byPin.set(pinNode.attrs.Name, signals);
  }
  return { byPin, sawRemap };
}

function possibleValue(node) {
  const parameter = childrenNamed(node, "SpecificParameter").find((item) => item.attrs.Name === "GPIO_AF");
  return parameter ? firstNamed(parameter, "PossibleValue")?.text || null : null;
}

/* ── 重映射组的重新编号 ───────────────────────────────────────────── */

/*
  把库里的 REMAP<n> 收敛成连续的逻辑组号，并丢掉在本封装上无脚可用的档次。

  返回 Map<实例, { order: 库里的 index 升序数组, macros: 逻辑组号 → HAL 宏 }>。
  order 的下标就是逻辑组号，也就是最终写进 functions[].af 的值。
*/
function buildRemapPlan(pinSignalEntries) {
  const seen = new Map(); // 实例 → Map<库 index, { macro, isDefault }>
  for (const { entry } of pinSignalEntries) {
    if (!entry.blocks) continue;
    for (const block of entry.blocks) {
      if (!seen.has(block.instance)) seen.set(block.instance, new Map());
      const existing = seen.get(block.instance).get(block.index);
      /* 同一档会在多个脚上重复出现，宏名只需记一次；有的脚上省略了宏
         （默认档常见），所以取第一个非空的。 */
      seen.get(block.instance).set(block.index, {
        macro: existing?.macro || block.macro,
        isDefault: existing?.isDefault || block.isDefault,
      });
    }
  }

  const plan = new Map();
  for (const [instance, blocks] of seen) {
    const order = [...blocks.keys()].sort((left, right) => left - right);
    const defaultIndex = order.findIndex((index) => blocks.get(index).isDefault);
    if (defaultIndex > 0) {
      throw new Error(
        `${instance}: 标了 DefaultRemap 的是第 ${defaultIndex + 1} 档而不是第一档，`
        + "重新编号后组 0 将不再是复位默认接法，需要人工确认",
      );
    }
    plan.set(instance, {
      order,
      macros: order.map((index) => blocks.get(index).macro),
    });
  }
  return plan;
}

/* ── 组装 ─────────────────────────────────────────────────────────── */

function packageGeometryOf(packageName, pinCount) {
  const shape = /^[A-Z]+/.exec(packageName)?.[0] || packageName;
  const geometry = { shape };
  if (/^(LQFP|QFP|QFN|UFQFPN|TQFP|VFQFPN)$/.test(shape) && pinCount % 4 === 0) {
    geometry.pinsPerSide = pinCount / 4;
    geometry.numbering = "counterclockwise";
  }
  return geometry;
}

const DEBUG_SIGNAL = /(JTMS|SWDIO|JTCK|SWCLK|JTDI|JTDO|NJTRST|JTRST|TRACESWO)/;
const OSC_SIGNAL = /^OSC(32)?_(IN|OUT)$/;

/* SYS_ / RCC_ 前缀是 CubeMX 的分组名，不是信号本身的一部分。既有的 H743
   数据里写的是裸的 JTMS-SWDIO / OSC_IN，这里保持一致，否则同一颗片子从两条
   路径进来会得到两种写法。 */
function stripPrefix(name) {
  return name.replace(/^(SYS|RCC|DEBUG)_/, "");
}

function buildDevice({ mcu, gpio, part, uiProfile }) {
  const isF1 = /^STM32F1/.test(mcu.family);
  const afGrouping = gpio.sawRemap ? "instance" : "pin";

  /* GPIO IP 的脚名与 mcu XML 不总是一致：PA0-WKUP / PA13 (JTMS/SWDIO) 两边都
     带修饰，PC2_C 那边却写作 PC2。全名和 base 都试一遍——F103 上 PA0 漏查就
     等于把 TIM2 的 CH1/ETR 整个丢掉。 */
  const signalsOfPin = (pin) => gpio.byPin.get(pin.fullName) || gpio.byPin.get(pin.baseName) || new Map();

  for (const pin of mcu.pins) Object.assign(pin, splitPinName(pin.fullName));
  for (const pin of mcu.pins) pin.baseName = pin.base;

  /* 先把 (脚, 信号) 摊平，重映射计划要基于**本封装实际存在的脚**来算 */
  const entries = [];
  for (const pin of mcu.pins) {
    const signalMap = signalsOfPin(pin);
    for (const signal of pin.signals) {
      const entry = signalMap.get(signal);
      if (entry) entries.push({ pin: pin.baseName, signal, entry });
    }
  }

  const remapPlan = gpio.sawRemap ? buildRemapPlan(entries) : new Map();

  const stats = { fixedPinFunctions: 0, droppedRemapGroups: 0 };
  /* 库里有、但本封装上一个脚都没有的档次：buildRemapPlan 已经只看本封装的
     entries，所以这里统计的是"库里声明过、交集后消失"的档数。 */
  if (gpio.sawRemap) {
    const declared = new Map();
    for (const signals of gpio.byPin.values()) {
      for (const entry of signals.values()) {
        for (const block of entry.blocks || []) {
          if (!declared.has(block.instance)) declared.set(block.instance, new Set());
          declared.get(block.instance).add(block.index);
        }
      }
    }
    for (const [instance, indices] of declared) {
      const kept = remapPlan.get(instance)?.order.length || 0;
      stats.droppedRemapGroups += indices.size - kept;
    }
  }

  /*
    补全"没挪窝"的信号。

    CubeMX 的 GPIO IP 只登记**会随重映射改变归属**的 (脚, 档) 组合，一个信号
    在某档下留在原地时往往一条记录都不写。直接照抄就会得到残缺的档次：
      - USART1_CK / CTS / RTS 只登记在 REMAP0，但 USART1_REMAP 位只管 TX/RX，
        这三根线两档都在原位；
      - I2C1_SMBA 只登记在 REMAP0，而 I2C1_REMAP 只挪 SCL/SDA；
      - TIM2_CH1 在 PA0 上登记了 REMAP0/REMAP2，PA15 上登记 REMAP1/REMAP3——
        这个是全的，说明库本身就不一致。
    残缺的后果很具体：求解器要求一路外设的所有信号同组，USART1 选了组 1 就会
    发现组 1 里没有 CTS/RTS，于是"带硬件流控的 USART1"被判成无解。

    推断规则：某一档下库里**在整个 die 范围内**都没为这个信号登记过任何脚，
    才认定它在该档没挪窝，归给它的基准脚——优先取"完全没有 RemapBlock 登记
    的那个脚"（如 TIM3_CH1 的 PA6），否则取登记在默认档的脚（如 USART1_CK
    的 PA8）。

    "整个 die 范围"这个限定是必须的，不能只看本封装。USART3 部分重映射会把
    TX 挪到 PC10，而 LQFP48 没有 PC10——只看本封装会看到"组 1 里没有
    USART3_TX 的登记"，从而错误地推断成"TX 在组 1 没挪窝、仍在 PB10"。
    实际上它挪了，只是挪到了这个封装引不出来的脚上，此时正确的结论是
    USART3_TX 在组 1 **不可用**。
  */
  const inferred = new Map(); // `${pin}|${signal}` → Set<组号>
  let inferredCount = 0;
  if (gpio.sawRemap) {
    /* 整个 die 上每个信号被登记过的原始 REMAP 序号 */
    const dieClaimed = new Map();
    for (const signals of gpio.byPin.values()) {
      for (const [signal, entry] of signals) {
        if (!entry.blocks) continue;
        if (!dieClaimed.has(signal)) dieClaimed.set(signal, new Set());
        for (const block of entry.blocks) dieClaimed.get(signal).add(block.index);
      }
    }

    /* 本封装上每个信号落在哪些脚，以及是否带 RemapBlock */
    const bySignal = new Map();
    for (const pin of mcu.pins) {
      if (PIN_KIND[pin.type] !== "gpio") continue;
      const signalMap = signalsOfPin(pin);
      for (const signal of pin.signals) {
        if (ANALOG_SIGNAL.test(signal) || SYSTEM_SIGNAL.test(signal)) continue;
        if (!bySignal.has(signal)) bySignal.set(signal, { defaultPin: null, plain: [] });
        const record = bySignal.get(signal);
        const entry = signalMap.get(signal);
        if (entry?.blocks) {
          const plan = remapPlan.get(signal.split("_")[0]);
          if (entry.blocks.some((block) => block.index === plan?.order[0])) record.defaultPin = pin.baseName;
        } else {
          record.plain.push(pin.baseName);
        }
      }
    }

    for (const [signal, record] of bySignal) {
      const plan = remapPlan.get(signal.split("_")[0]);
      if (!plan) continue; // 固定脚外设（SPI2/I2C2），下面按组 0 处理
      const claimed = dieClaimed.get(signal) || new Set();
      const basePin = record.plain[0] || record.defaultPin;
      if (!basePin) continue; // 只在某几档存在，不臆造

      plan.order.forEach((originalIndex, group) => {
        if (claimed.has(originalIndex)) return; // 库登记过——挪没挪窝都以库为准
        const key = `${basePin}|${signal}`;
        if (!inferred.has(key)) inferred.set(key, new Set());
        inferred.get(key).add(group);
        inferredCount += 1;
      });
    }
  }
  stats.inferredFunctions = inferredCount;

  const pins = mcu.pins.map((pin) => {
    const baseName = pin.baseName;
    const kind = PIN_KIND[pin.type] || "special";

    const functions = [];
    const additionalFunctions = [];
    if (pin.extra) additionalFunctions.push(pin.extra);

    if (kind === "gpio") {
      const signalMap = signalsOfPin(pin);
      for (const signal of pin.signals) {
        if (ANALOG_SIGNAL.test(signal)) {
          additionalFunctions.push(signal);
          continue;
        }
        if (SYSTEM_SIGNAL.test(signal)) {
          additionalFunctions.push(stripPrefix(signal));
          continue;
        }
        const extra = inferred.get(`${baseName}|${signal}`);
        for (const group of extra || []) functions.push({ name: stripPrefix(signal), af: group });

        const entry = signalMap.get(signal);
        if (!entry) {
          /* GPIO IP 里没有：F1 上是固定脚外设（SPI2/I2C2），归入组 0；
             逐脚选 AF 的器件上则是没有复用功能的系统信号。 */
          if (afGrouping === "instance" && !extra) {
            functions.push({ name: stripPrefix(signal), af: 0 });
            stats.fixedPinFunctions += 1;
          } else if (afGrouping !== "instance") {
            additionalFunctions.push(stripPrefix(signal));
          }
          continue;
        }
        if (entry.blocks) {
          for (const block of entry.blocks) {
            const group = remapPlan.get(block.instance)?.order.indexOf(block.index);
            if (group === undefined || group < 0) continue;
            functions.push({ name: stripPrefix(signal), af: group });
          }
        } else if (entry.af != null) {
          functions.push({ name: stripPrefix(signal), af: entry.af });
        } else {
          additionalFunctions.push(stripPrefix(signal));
        }
      }
    }

    const protection = [];
    if (functions.some((item) => DEBUG_SIGNAL.test(item.name))) protection.push("debug");
    if (additionalFunctions.some((name) => DEBUG_SIGNAL.test(name))) {
      if (!protection.includes("debug")) protection.push("debug");
    }
    if (additionalFunctions.some((name) => OSC_SIGNAL.test(name))) protection.push("oscillator");
    if (kind === "special" && pin.type === "Reset") protection.push("system");
    if (kind === "special" && pin.type === "Boot") protection.push("system");

    /* 同名同 af 去重：一个信号在多个未被丢弃的档里出现是正常的（部分重映射
       下没挪窝的通道），但同一档里重复就是解析出了问题。 */
    const deduped = [];
    const seen = new Set();
    for (const item of functions) {
      const key = `${item.name}|${item.af}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }

    return {
      number: pin.position,
      name: baseName,
      resetName: pin.reset,
      kind,
      ioType: kind === "supply" ? "S" : "I/O",
      /* ioStructure 只有电源脚能确定（恒为 "-"）。GPIO 的 FT / TTa / TC 要查
         datasheet，这里**不写这个键**——空字符串会被 checkElectrical 当成一个
         真实取值，而"不知道"和"是空的"必须区分得开。 */
      ...(kind === "supply" ? { ioStructure: "-" } : {}),
      notes: "-",
      functions: deduped,
      additionalFunctions: [...new Set(additionalFunctions)],
      protection,
    };
  }).sort((left, right) => left.number - right.number);

  const packageName = mcu.package;
  const device = {
    id: `st-${part.toLowerCase()}-${packageName.toLowerCase()}`,
    /* 小写 x 是 CubeMX 的等级占位符（STM32F407VGTx），不能大写成字母 X——那会把
       "这一档里任意等级"写成一个看似确定的订货型号。真实订货号里没有字母 X。 */
    partNumber: part.replace(/[a-wyz]/g, (letter) => letter.toUpperCase()),
    vendor: "STMicroelectronics",
    family: mcu.line || mcu.family,
    core: mcu.core.replace(/^Arm /, "ARM "),
    package: packageName,
    pinCount: pins.length,
    uiProfile: uiProfile || "generic",
    status: "generated",
    analogConvention: "st",
    signalDialect: isF1 ? "st-f1" : "st",
    packageGeometry: packageGeometryOf(packageName, pins.length),
    source: {
      document: `STM32CubeMX DB ${mcu.refName}`,
      revision: mcu.gpioVersion,
      url: "https://github.com/STMicroelectronics/STM32_open_pin_data",
      pinTable: `mcu/${mcu.refName}.xml`,
      afTable: `mcu/IP/GPIO-${mcu.gpioVersion}_Modes.xml`,
    },
    pins,
  };

  if (afGrouping === "instance") {
    device.afGrouping = "instance";
    device.remapMacros = {};
    for (const [instance, plan] of [...remapPlan].sort()) {
      /* 空串 = 库里没给宏名。组 0 恒定如此，因为"不重映射"就是复位状态，
         没有需要调用的宏——不能在这里编一个 __HAL_AFIO_REMAP_x_DISABLE 出来，
         那是猜的。导出层按空串走"无需调用"的分支。 */
      device.remapMacros[instance] = plan.macros.map((macro) => (macro ? `${macro}()` : ""));
    }
  }

  return { device, stats, remapPlan, ioCount: mcu.ioCount };
}


/* ── 对外入口 ─────────────────────────────────────────────────────── */

export { resolveDb, findDeviceFile };

/*
  从 CubeMX 器件库生成一颗器件的数据。

  `previous` 是同一颗片子上一次的产物（如果有）：5V 耐压是这个流程里唯一需要人
  翻 datasheet 的部分，重新导入时要把它搬过来，否则没人愿意补第二次。
*/
export async function importStm32({ db, part, uiProfile, previous }) {
  const deviceFile = await findDeviceFile(db, part);
  const mcu = parseMcuFile(await readFile(deviceFile, "utf8"));

  const gpioFile = path.join(db, "mcu", "IP", `GPIO-${mcu.gpioVersion}_Modes.xml`);
  if (!existsSync(gpioFile)) throw new Error(`找不到 AF 数据文件：${gpioFile}`);
  const gpio = parseGpioFile(await readFile(gpioFile, "utf8"));

  const built = buildDevice({ mcu, gpio, part, uiProfile });

  let carried = 0;
  if (previous) {
    if (previous.electrical) built.device.electrical = previous.electrical;
    const structures = new Map(
      previous.pins.filter((pin) => pin.ioStructure).map((pin) => [pin.name, pin.ioStructure]),
    );
    for (const pin of built.device.pins) {
      const structure = structures.get(pin.name);
      if (structure && !pin.ioStructure) { pin.ioStructure = structure; carried += 1; }
    }
  }

  return { ...built, deviceFile, gpioFile, carried };
}
