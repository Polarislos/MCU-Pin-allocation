/*
  扫描本机的厂商器件库，生成"可选器件索引" src/data/deviceIndex.json。

  用法：npm run mcu:catalog

  ── 为什么要索引，而不是把器件数据全打包进来 ──────────────────────
  CubeMX 库里约 2300 个 STM32 型号，SysConfig 里约 475 个 TI 型号 ×
  1077 个 (型号,封装) 组合。单颗器件的引脚数据平均 60 KB，全打包约 200 MB——
  仓库和首屏都受不了。

  所以索引只放**选型元数据**：型号、系列、封装、脚数、内核、CubeMX 可核实的
  Flash/RAM/频率/供电范围，以及去重后的外设摘要。完整引脚数据仍在用户选中时才
  现场转换（见 tools/vite-mcu-server.mjs），转完缓存落盘，用过的器件就永久可用。

  ── 索引项不等于"已经能用" ────────────────────────────────────────
  索引是从厂商库的**文件名和元数据**推出来的，没有真正跑过转换。个别器件可能
  在转换时才暴露问题（封装形态判断不出来、信号命名对不上）。界面在加载失败时
  要如实报错，而不是假装这颗片子不存在。

  ── 外设摘要────────────────────────────────────────
  为了"按外设找片子"，STM32 要读**整份** XML：
    <IP InstanceName="SDMMC1" Name="SDMMC" .../>   外设实例与类型
    <Pin ...><Signal Name="SDMMC1_D0"/>            本封装引得出哪些信号
  CubeMX 的 RefName 文件本身就是按封装分的（FMC 的 Version 都写着
  "lqfp100_fmc_v3_0"），所以 IP 列表就是这个封装的外设清单。

  这一层只回答"厂商数据库里有这个外设、这个封装引出了哪些信号"，**不**回答
  "这个用途能不能接成"——引脚冲突要交给求解器。

  体积：同一个 RefName 展开出的型号共享一份外设档案（profiles），各实例的
  信号集合再全局去重（signalSets），条目只存档案下标 pf。

  TI 的外设来自 SysConfig 器件族数据，见 scanTi() 前的说明。族数据缺失或封装
  对不上的条目没有 pf，界面显示为"外设数据未收录"而不是"不支持"。

  ── 脚数为什么能不打开文件就知道 ──────────────────────────────────
  两家的封装名里都编了脚数：STM32 的 Package 属性是 "LQFP100"，TI 的封装键是
  "LQFP-64(PM)"。TI 只需读 gpns.json 一个文件。
*/
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDb } from "./lib/stm32.mjs";
import { childrenNamed, firstNamed, parseXml } from "./lib/xml.mjs";
import { datasheetPeripheralName, resolveDeviceData, translateSignalName } from "./lib/ti.mjs";

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

/* 软件中间件（FATFS/FREERTOS…）和系统模块（RCC/NVIC/GPIO…）也以 <IP> 出现，
   但不是选型时要找的外设，留着只会让候选词里混进噪音。 */
const NON_PERIPHERAL_IPS = new Set([
  "ADV_TRACE", "BOOTPATH", "CORTEX_A7", "CORTEX_M33", "CORTEX_M33_NS", "CORTEX_M33_S", "CORTEX_M4", "CORTEX_M7",
  "DEBUG", "EXTMEM_LOADER", "EXTMEM_MANAGER", "FATFS", "FREERTOS", "GIC", "GPIO", "GRAPHICS", "GUI_INTERFACE",
  "KMS", "LIBJPEG", "LINKEDLIST", "LWIP", "MBEDTLS", "MEMORYMAP", "MISC", "NVIC", "NVIC1", "NVIC2", "OPENAMP",
  "PDM2PCM", "PWR", "RCC", "RESMGR_UTILITY", "SAU", "SECURE_MANAGER_API", "SEQUENCER", "STM32_WPAN", "SYS",
  "SYS_M4", "SYS_S", "SYSM0P", "TIMER", "TINY_LPM", "TOUCHSENSING", "TRACER_EMB", "USBPD", "USBX", "USB_DEVICE",
  "USB_HOST",
]);

/* CubeMX 新版本里的中间件（ThreadX、FileX、USB_Device…）用大小写混写命名，
   LPBAM* 是低功耗后台调度的软件配置，CORTEX_* 是内核本身——都不算外设。 */
function isPeripheralIp(name) {
  return !NON_PERIPHERAL_IPS.has(name) && name === name.toUpperCase()
    && !/^(CORTEX_|LPBAM)/.test(name);
}

/* 定时器的 IP Name 是 IP 版本（TIM1_8H7、TIM6_7L4），类型统一归成 TIM。 */
function peripheralType(name) {
  return /^TIM\d/.test(name) ? "TIM" : name;
}

const signalSets = [];
const signalSetIndex = new Map();
function internSignals(list) {
  const key = [...new Set(list)].sort().join(" ");
  if (!signalSetIndex.has(key)) {
    signalSetIndex.set(key, signalSets.length);
    signalSets.push(key);
  }
  return signalSetIndex.get(key);
}

const peripheralTypes = new Set();
let tiCoverage = null;
/* 解析失败的厂商文件：写进索引的 gaps，而不是悄悄少几颗片子 */
const skipped = [];

/* 返回空格分隔的档案串，每项 "实例:信号集下标"，类型与"实例去掉尾部数字"
   不同时写成 "实例=类型:下标"（TIM1=TIM 不需要，I2S1→I2S 也不需要，
   但 ADC 之类的组合实例可能需要）。比对象数组小三分之二。
   信号按最长实例名前缀归属：USB_OTG_HS_ULPI_D0 属于 USB_OTG_HS 而不是 USB。 */
/*
  实例级的能力标记，追加在档案项后面："USB_OTG_HS:83+HSPHY"。

  HSPHY = 片上高速 USB PHY。CubeMX 没有专门的字段，但留下了两种可核实的痕迹：
  - U59x/U5Ax/U5Fx/U5Gx、H7R/S：USB_OTG_HS 的 ClockEnableMode 里有
    __HAL_RCC_USBPHYC_CLK_ENABLE（PHY 控制器的时钟）；
  - F723/F733：封装里有 USB_OTG_HS_REXTPHYHS 脚（HS PHY 的外接偏置电阻）。
    同代的 F722/F732 没有 HS PHY，库里也确实没有这个脚。
  没有痕迹不等于没有 PHY，所以只记"有"；界面对没痕迹的 HS 控制器报"数据未知"。

  DEVONLY = 只能做设备的全速 USB。CubeMX 里 IP 名都叫 USB，但版本号分两支：
  usb1_*（F0/F1/F3/L0/L1/L4/L5/G4/WB，参考手册里的 "USB full-speed device
  interface"）和 usbfs_v1.0（H5、U0，另一种控制器）。只给前者打标记，后者的主机
  能力在数据里看不出来，界面报"数据未知"。
*/
function instanceFeatures(instance, ip, signals, type) {
  const features = [];
  if (type === "USB" && /^usb1_/.test(ip?.attrs.Version || "")) features.push("DEVONLY");
  if (instance === "USB_OTG_HS"
    && (/USBPHYC/.test(ip?.attrs.ClockEnableMode || "") || signals.includes("REXTPHYHS"))) {
    features.push("HSPHY");
  }
  return features;
}

function stm32Peripherals(root) {
  const instances = new Map();
  const ipNodes = new Map();
  for (const node of childrenNamed(root, "IP")) {
    const { Name: name, InstanceName: instance } = node.attrs;
    if (!name || !instance || !isPeripheralIp(name)) continue;
    instances.set(instance, peripheralType(name));
    ipNodes.set(instance, node);
  }
  const byLength = [...instances.keys()].sort((left, right) => right.length - left.length);
  const signals = new Map([...instances.keys()].map((instance) => [instance, []]));
  const signalNames = childrenNamed(root, "Pin")
    .flatMap((pin) => childrenNamed(pin, "Signal").map((node) => node.attrs.Name).filter(Boolean));
  for (const signal of signalNames) {
    /* HDMI_CEC 唯一的脚叫 "CEC"，不带实例前缀 */
    if (signal === "CEC" && signals.has("HDMI_CEC")) {
      signals.get("HDMI_CEC").push("CEC");
      continue;
    }
    let owner = byLength.find((instance) => signal.startsWith(`${instance}_`));
    /* USB_DRD_FS（G0B/G0C、U53/U54）的脚在库里写作 USB_DM / USB_DP，没有实例前缀 */
    if (!owner && signal.startsWith("USB_") && signals.has("USB_DRD_FS") && !signals.has("USB")) owner = "USB";
    if (owner === "USB" && !signals.has("USB")) {
      signals.get("USB_DRD_FS").push(signal.slice(4));
      continue;
    }
    if (owner) signals.get(owner).push(signal.slice(owner.length + 1));
  }
  return [...instances]
    .sort(([left], [right]) => left.localeCompare(right, "en", { numeric: true }))
    .map(([instance, type]) => {
      peripheralTypes.add(type);
      const label = instance.replace(/\d+$/, "") === type ? instance : `${instance}=${type}`;
      const features = instanceFeatures(instance, ipNodes.get(instance), signals.get(instance), type);
      return `${label}:${internSignals(signals.get(instance))}${features.map((item) => `+${item}`).join("")}`;
    })
    .join(" ");
}

const profiles = [];
const profileIndex = new Map();
function internProfile(profile) {
  if (!profileIndex.has(profile)) {
    profileIndex.set(profile, profiles.length);
    profiles.push(profile);
  }
  return profileIndex.get(profile);
}

async function scanStm32(db) {
  const dir = path.join(db, "mcu");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".xml"));
  const entries = [];
  for (const file of files) {
    let root;
    try {
      root = parseXml(await readFile(path.join(dir, file), "utf8"));
    } catch (error) {
      skipped.push(`${file}：${error.message}`);
      continue;
    }
    if (root.name !== "Mcu") continue;
    const attr = (name) => root.attrs[name] || "";
    const packageName = attr("Package");
    if (!packageName) continue;
    /* 脚数取封装名里的数字（LQFP100、UFBGA176）。不用 <IONb>：它只数 I/O，不含电源脚 */
    const pinCount = Number(/(\d+)/.exec(packageName)?.[1] || 0);
    const refName = file.replace(/\.xml$/, "");
    const pf = internProfile(stm32Peripherals(root));
    const tag = (name) => firstNamed(root, name)?.text || "";
    const parts = expandRefName(refName);
    const specificationNodes = new Map(["Flash", "Ram", "CCMRam", "Frequency", "Voltage"]
      .map((name) => [name, childrenNamed(root, name)]));
    const specificationNode = (name, partIndex) => {
      const nodes = specificationNodes.get(name) || [];
      if (nodes.length === 1) return nodes[0];
      /* 多值字段按 RefName 展开顺序对应型号；遇到新格式/不等长时保留未知，不猜。 */
      return nodes.length === parts.length ? nodes[partIndex] : null;
    };
    const numericTag = (name, partIndex) => {
      const raw = specificationNode(name, partIndex)?.text?.trim() || "";
      if (!raw) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };
    const numericAttr = (node, name) => {
      const value = node?.attrs?.[name];
      if (value == null || value === "") return undefined;
      const number = Number(value);
      return Number.isFinite(number) ? number : undefined;
    };
    for (const [partIndex, part] of parts.entries()) {
      const voltage = specificationNode("Voltage", partIndex);
      const specs = {
        flashKB: numericTag("Flash", partIndex),
        ramKB: numericTag("Ram", partIndex),
        ccmRamKB: numericTag("CCMRam", partIndex),
        frequencyMHz: numericTag("Frequency", partIndex),
        voltageMinV: numericAttr(voltage, "Min"),
        voltageMaxV: numericAttr(voltage, "Max"),
        /* CubeMX RefName 对应一个器件记录；括号内的容量变体按文件字段顺序映射。 */
        sourceRef: `${refName}.xml`,
      };
      for (const key of Object.keys(specs)) {
        if (specs[key] === undefined) delete specs[key];
      }
      entries.push({
        vendor: "st",
        part,
        series: attr("Line") || attr("Family"),
        family: attr("Family"),
        package: packageName,
        pinCount,
        core: tag("Core").replace(/^Arm /, "ARM "),
        specs,
        pf,
      });
    }
  }
  return entries;
}

/*
  TI 外设摘要。SysConfig 的器件族数据（<族>/<族>.json）有两种写法：

  - MSPM0 / CC23xx 这类：peripherals[].interfaceWrapper 直接指向 interfaces，
    接口名就是类型（UART、SPI、MCAN、GPTIMER…）；信号写作 "UART0.TX"。
  - AM / C2000 / TM4C 这类：外设没有 interfaceWrapper，但每个 peripheralPin 带
    interfacePinID，接口再列出自己的 interfacePin——类型取外设各脚所属接口的
    多数。信号名五花八门（uart0_rxd、SPISIMOA、SSI3RX），去掉实例前缀后原样
    保留，只用于展示和计数。

  一个族覆盖多个型号：parts 里有按型号列的外设清单时（TM4C1231 比 TM4C123G
  少几个），用 gpns 的 legacyPart 取对应那份；只有 Default 时整族通用——
  这是数据本身的粒度，不是这里的简化。

  外设只在本封装至少引出一个脚时才收录（CubeMX 的 IP 清单本来就按封装给，
  两边口径一致）；本来就没有引脚的片上外设（CRC、AES）照收。
*/
const TI_NON_PERIPHERAL_TYPES = new Set([
  "AMUX", "AON_SS", "ASM", "BANDGAP", "BLANK", "CKM", "CNT", "COMBO", "CPUSS", "CPU_DBG", "DEBUGSS", "DFF",
  "DFTSS", "DLY", "DMA", "DMA_CHANNEL", "DTB", "EAM", "EPWM_COMMON", "EVENTMANAGER", "FILTER", "FLASHCTL",
  "FLASHXBAR", "FPI", "FRI", "FSM", "GLUE", "GPIO", "GSC", "IOMUX", "JTAG", "KEYSTORECTL", "LFSS", "LFXT",
  "LPC", "LUT2", "LUT3", "LUT4", "MEMCFG", "OSC", "OSC0", "OSC1", "OSC2", "PDLY", "PGEN", "PIPEDELAY", "POR",
  "SPGSS", "SR", "SWO", "SYSCTL", "SYSMEM", "SYSTEM", "TEST", "USB_EP_IN", "USB_EP_OUT", "VREF", "WUC",
]);

/* 处理器线（AM6x、雷达 AWR）按电源/子系统域给接口加前缀：MCU_UART、WKUP_I2C、
   MSS_MCAN 都还是 UART、I2C、MCAN。接口名还常带实例号（USB0、MMC2、EMIF1）。 */
const TI_DOMAIN_PREFIX = /^(?:MCU|WKUP|MSS|RCSS|DSS|BSS|HWASS)_/;
/* 引脚级的杂项分组：时钟输出、电源域 GPIO、调试/跟踪、同步与中断线、晶振 */
const TI_NOISE = /GPIO|VDD|OSC|CLK|DEBUG|JTAG|SYSTEM|XBAR|TRACE|TRDATA|SWDIO|HI-Z|BLANK|REFCLK|WAKE|WU_REQ|READY_INT|CHIRP|FRAME_START|SYNC|PMIC|PRCM|RESET|^OTHER$|^ERROR$|^DIGITAL$|^ANALOG$|^DRIVE$|^EXT$|^FAST$|^TZ$|^DFE_|LOGGER|^VIN$|^VOUT$|^ARM$|^XTAL$|^HIBERNATE$|^TAMPER$|^ESM$|^INTC$|^NMI$|^CAL$|^ADCCAL$|^ADC_|^LVDS_VALID$|^CHIPGLUE$|^PA_|^HOST_|^CTRIPOUT$|^DC-DC$|^AIO$/;

function tiType(name) {
  let type = String(name || "").toUpperCase().replace(/\s+/g, "_");
  /* PRU / ICSS 子系统内部的外设（MII0_PRUSS1、eCAP0_PRUSS1）由 PRU 固件驱动，不是选型时说的那个外设 */
  if (!type || /PRU|ICSS/.test(type)) return null;
  while (TI_DOMAIN_PREFIX.test(type)) type = type.replace(TI_DOMAIN_PREFIX, "");
  type = type.replace(/(?<=[A-Z])\d+$/, "");
  if (!type || TI_NON_PERIPHERAL_TYPES.has(type) || TI_NOISE.test(type)) return null;
  return type;
}

function tiSignalSuffix(raw, instance, original) {
  if (raw.includes(".")) {
    const translated = translateSignalName(raw);
    if (translated?.startsWith(`${instance}_`)) return translated.slice(instance.length + 1);
    return raw.slice(raw.indexOf(".") + 1);
  }
  for (const prefix of [original, instance]) {
    const at = raw.toUpperCase().indexOf(prefix.toUpperCase());
    if (at !== -1) {
      const rest = raw.slice(at + prefix.length).replace(/^[._]/, "");
      if (rest) return rest.toUpperCase();
    }
  }
  return raw.toUpperCase();
}

function tiProfile(data, packageName, partName, family) {
  const pkg = Object.values(data.packages || {}).find((item) => item.name === packageName);
  if (!pkg) return { profile: null };
  const bonded = new Set();
  const muxByPin = new Map((data.muxes || []).map((item) => [item.devicePinID, item.muxSetting || []]));
  for (const entry of pkg.packagePin || []) {
    for (const setting of muxByPin.get(entry.devicePinID) || []) bonded.add(setting.peripheralPinID);
  }

  const interfaces = data.interfaces || {};
  const interfaceOfPin = new Map();
  for (const item of Object.values(interfaces)) {
    for (const wrapper of item.interfacePinWrapper || []) interfaceOfPin.set(wrapper.interfacePinID, item.name);
  }
  const part = Object.values(data.parts || {}).find((item) => item.name === partName)
    || Object.values(data.parts || {}).find((item) => item.name === "Default");
  const allowed = part?.peripheralWrapper?.length ? new Set(part.peripheralWrapper.map((item) => item.peripheralID)) : null;

  const tokens = [];
  for (const peripheral of Object.values(data.peripherals || {})) {
    if (allowed && !allowed.has(peripheral.id)) continue;
    const pinIds = (peripheral.peripheralPinWrapper || []).map((item) => item.peripheralPinID);
    let typeName = interfaces[peripheral.interfaceWrapper?.[0]?.interfaceID]?.name;
    if (!typeName) {
      const votes = new Map();
      for (const id of pinIds) {
        const name = interfaceOfPin.get(data.peripheralPins[id]?.interfacePinID);
        if (name) votes.set(name, (votes.get(name) || 0) + 1);
      }
      typeName = [...votes].sort((left, right) => right[1] - left[1])[0]?.[0];
    }
    let type = tiType(typeName);
    /* C2000 的 "SD" 是 Σ-Δ 滤波模块（TI 自己叫 SDFM），CC3500 的 "SD" 才是 SD 卡 */
    if (type === "SD" && /^F2[89]/.test(family)) type = "SDFM";
    if (!type) continue;
    const translated = datasheetPeripheralName(peripheral.name);
    if (!translated) continue;
    const instance = translated.replace(/[\s:=+]+/g, "_");
    const reachable = pinIds.filter((id) => bonded.has(id));
    if (pinIds.length > 0 && reachable.length === 0) continue; // 本封装没引出
    const signals = reachable
      .map((id) => data.peripheralPins[id]?.name)
      .filter(Boolean)
      .map((raw) => tiSignalSuffix(raw, instance, peripheral.name));
    peripheralTypes.add(type);
    /* 解码端按"实例去尾数字"推类型，大小写必须完全一致：Timer0 / Comparator0 要写明 =TIMER */
    const label = instance.replace(/\d+$/, "") === type ? instance : `${instance}=${type}`;
    tokens.push([instance, `${label}:${internSignals(signals)}`]);
  }
  tokens.sort(([left], [right]) => left.localeCompare(right, "en", { numeric: true }));
  return { profile: tokens.map(([, token]) => token).join(" ") };
}

async function scanTi(deviceDataDir) {
  const gpns = JSON.parse(await readFile(path.join(deviceDataDir, "gpns.json"), "utf8"));
  const byFamily = new Map();
  for (const [part, info] of Object.entries(gpns)) {
    if (info.isPublic === false) continue;
    for (const [packageName, variants] of Object.entries(info.packages || {})) {
      const variant = Object.values(variants)[0];
      const family = variant?.legacyDevice;
      if (!family) continue;
      if (!byFamily.has(family)) byFamily.set(family, []);
      byFamily.get(family).push({ part, packageName, variant });
    }
  }

  const entries = [];
  let withPeripherals = 0;
  /* 按族读：一族的 JSON 可能几十 MB（AM62），读一次处理完就丢 */
  for (const [family, items] of byFamily) {
    const file = path.join(deviceDataDir, family, `${family}.json`);
    let data = null;
    try {
      if (existsSync(file)) data = JSON.parse(await readFile(file, "utf8"));
    } catch {
      data = null;
    }
    for (const { part, packageName, variant } of items) {
      const { profile } = data
        ? tiProfile(data, variant.legacyPackage || packageName, variant.legacyPart, family)
        : { profile: null };
      const entry = {
        vendor: "ti",
        part,
        /* TI 一个型号有多种封装，(型号,封装) 才唯一，所以封装要进 id */
        package: packageName,
        /* 封装名不带脚数时（"LQFP (PZ)"）看 legacyPackage（"100 Pin QFP|25x25"）。
           不能数 packagePin：它只列可复用的焊盘，TM4C123GH6PM 的 64 脚只列了 43 个。 */
        pinCount: Number(/-(\d+)\(/.exec(packageName)?.[1]
          || /(\d+)\s*Pin/i.exec(variant.legacyPackage || "")?.[1]
          || /(\d{2,})/.exec(packageName)?.[1] || 0),
        series: family,
        family,
        core: "",
      };
      if (profile != null) {
        entry.pf = internProfile(profile);
        withPeripherals += 1;
      }
      entries.push(entry);
    }
  }
  tiCoverage = { withPeripherals, total: entries.length };
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
/* 本机缺的数据源要写进索引：界面据此说明"TI 没有参与"，而不是让人以为 TI 没有片子 */
const gaps = [];
let entries = [];

/* 库版本写进来源记录，换了 CubeMX / SysConfig 版本后能看出索引是哪一版生成的 */
async function cubeMxRelease(db) {
  try {
    const root = parseXml(await readFile(path.join(db, "package.xml"), "latin1"));
    return firstNamed(root, "PackDescription")?.attrs.Release || "";
  } catch {
    return "";
  }
}

try {
  const db = await resolveDb();
  const found = await scanStm32(db);
  entries.push(...found);
  sources.push({ vendor: "st", tool: "STM32CubeMX", release: await cubeMxRelease(db), root: db, count: found.length });
  console.log(`STM32   ${found.length} 个型号  ←  ${db}`);
} catch (error) {
  console.warn(`STM32   跳过：${error.message.split("\n")[0]}`);
  gaps.push({ vendor: "st", reason: error.message.split("\n")[0] });
}

try {
  const dir = await resolveDeviceData();
  const found = await scanTi(dir);
  entries.push(...found);
  sources.push({
    vendor: "ti",
    tool: "TI SysConfig",
    release: /sysconfig_([\d.]+)/.exec(dir.replace(/\\/g, "/"))?.[1] || "",
    root: dir,
    count: found.length,
  });
  console.log(`TI      ${found.length} 个 (型号,封装) 组合  ←  ${dir}`);
} catch (error) {
  console.warn(`TI      跳过：${error.message.split("\n")[0]}`);
  gaps.push({ vendor: "ti", reason: error.message.split("\n")[0] });
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

if (skipped.length) {
  console.warn(`\n${skipped.length} 个厂商文件解析失败，已跳过：\n  ${skipped.slice(0, 10).join("\n  ")}`);
  gaps.push({ vendor: "st", reason: `${skipped.length} 个器件文件解析失败`, files: skipped });
}

const index = {
  /* 只写日期：界面显示用；精确时间在 peripherals.generatedAt */
  generatedAt: new Date().toISOString().slice(0, 10),
  sources,
  gaps,
  /* 规格值沿用每条器件记录的 CubeMX RefName；未出现的 XML 字段保持未知。 */
  specifications: {
    version: 1,
    units: { flashKB: "KB", ramKB: "KB", ccmRamKB: "KB", frequencyMHz: "MHz", voltageMinV: "V", voltageMaxV: "V" },
    ramFilterField: "ramKB",
    coverage: Object.fromEntries([...new Set(entries.map((entry) => entry.vendor))].map((vendor) => {
      const vendorEntries = entries.filter((entry) => entry.vendor === vendor);
      return [vendor, {
        total: vendorEntries.length,
        flashKB: vendorEntries.filter((entry) => Number.isFinite(entry.specs?.flashKB)).length,
        ramKB: vendorEntries.filter((entry) => Number.isFinite(entry.specs?.ramKB)).length,
        frequencyMHz: vendorEntries.filter((entry) => Number.isFinite(entry.specs?.frequencyMHz)).length,
        voltage: vendorEntries.filter((entry) => Number.isFinite(entry.specs?.voltageMinV) || Number.isFinite(entry.specs?.voltageMaxV)).length,
      }];
    })),
  },
  /* 外设摘要的覆盖面要写明：没有 pf 的条目是"未收录"，不是"没有外设" */
  peripherals: {
    /* 结构版本：deviceSearch.js 据此认出旧索引（没有这个字段 = 第一版，只有型号元数据） */
    version: 2,
    generatedAt: new Date().toISOString(),
    vendors: [...new Set(entries.filter((entry) => entry.pf != null).map((entry) => entry.vendor))].sort(),
    types: [...peripheralTypes].sort(),
    profiles,
    signalSets,
  },
  devices: entries,
};

const { mergeCubeMx2 } = await import("./lib/cubemx2.mjs");
await mergeCubeMx2(index);
await writeFile(OUT_FILE, `${JSON.stringify(index)}\n`, "utf8");
const bytes = (await readFile(OUT_FILE)).length;
console.log(`\n已写入 ${path.relative(process.cwd(), OUT_FILE)}：${entries.length} 项，${(bytes / 1024).toFixed(0)} KB`);
if (tiCoverage) console.log(`TI 外设：${tiCoverage.withPeripherals}/${tiCoverage.total} 个组合已提取`);
console.log(`外设摘要：${profiles.length} 份档案，${signalSets.length} 组信号，${peripheralTypes.size} 类外设`);
console.log("引脚数据不在索引里——选中某颗时由本地服务器现场转换并缓存。");
