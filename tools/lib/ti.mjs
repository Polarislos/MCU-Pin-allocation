/*
  从 TI SysConfig 的器件库导出符合 src/data/mcu.schema.json 的引脚数据。

  用法：
    node tools/import-ti.mjs --part MSPM0G3519 --package "LQFP-64(PM)"
    node tools/import-ti.mjs --part MSPM0G3519           （列出可选封装）
    node tools/import-ti.mjs --part MSPM0G3519 --package "LQFP-48(PT)" --dry-run
    （--sysconfig 省略时自动找 C:/ti/sysconfig_* 里版本最高的一个，
      也认环境变量 SYSCONFIG_HOME）

  ── 数据在哪 ────────────────────────────────────────────────────────
  不是 CCS 里的那些文件。CCS 的 ccs_base/common/targetdb/devices/<型号>.xml
  是**调试器**的目标描述（内存映射、CS_DAP 路由、GEL 脚本），一条引脚复用信息
  都没有——pinmux 从来是 SysConfig 的活。

    <sysconfig>/dist/deviceData/gpns.json         型号 → 器件族 + 封装列表
    <sysconfig>/dist/deviceData/<族>/<族>.json    引脚、封装、mux 表

  一个族覆盖多个型号和多种封装，所以 --part 之外还要 --package。

  ── 数据链路 ────────────────────────────────────────────────────────
    packages[ID].packagePin[]  → { devicePinID, ball }   ball 即物理脚号
    muxes[]                    → { devicePinID, muxSetting: [{ peripheralPinID, mode }] }
    peripheralPins[id].name    → "UART0.TX"
    devicePins[id]             → { name: "PA0", devicePinType }

  ── mode 的含义（这条是整个转换的支点）────────────────────────────
    mode 0  模拟/特殊功能：ADC 通道、比较器输入、LFXIN/HFXIN/ROSC、VREF
    mode 1  GPIO 本身
    mode ≥2 数字复用功能

  所以 mode 0 进 additionalFunctions，mode 1 丢弃，mode ≥2 进 functions 且
  af = mode。这正是既有手工数据里 af 从 2 起编号的原因。

  ── 命名为什么在这里翻译，而不是丢给 dialect.js ────────────────────
  SysConfig 的写法与 datasheet（SLASFA2B 等）不一致，例如：

    TIMA0.CCP0          → TIMA0_C0
    TIMA0.CCP0_CMPL     → TIMA0_C0N
    TIMA0.FAULT1        → TIMA_FAL1   （SysConfig 按实例拆成 TIMA0/TIMA1 两条）
    SPI0.SCLK           → SPI0_SCK
    SPI0.CS3_CD_POCI3   → SPI0_CS3
    CANFD0.CANTX        → CAN0_TX
    ADC0.13             → A0_13
    DEBUGSS.SWDIO       → SWDIO

  其中只有前几条会经过求解器的方言层，ADC 通道、SWDIO、LFXIN 这些是
  additionalFunctions 和保护标记，dialect.js 根本碰不到它们。映射拆在两处
  必然会走样，所以统一在这里归一化成 datasheet 写法——产出的数据与既有的
  手工 MSPM0 数据同构，dialect.js / peripherals.js / 现有 fixture 都不用改。
*/
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { layoutKindOf, packageLayout } from "../../src/lib/package.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/* 内核在 SysConfig 的器件数据里没有（cores 是空数组），只能按族前缀查。
   认不出来时留空并提示，不猜。 */
const CORE_BY_FAMILY = [
  [/^MSPM0[CGHL]/, "ARM Cortex-M0+"],
  [/^MSPM33/, "ARM Cortex-M33"],
  [/^TM4C/, "ARM Cortex-M4F"],
  [/^CC13|^CC26|^CC23|^CC27/, "ARM Cortex-M4F"],
];

/* ── CLI ──────────────────────────────────────────────────────────── */


async function resolveDeviceData(explicit) {
  const roots = [];
  if (explicit) roots.push(explicit);
  else if (process.env.SYSCONFIG_HOME) roots.push(process.env.SYSCONFIG_HOME);
  else {
    /* 同时装几个 SysConfig 版本很常见，取版本号最大的那个。 */
    for (const base of ["C:/ti", "D:/ti", `${process.env.HOME || ""}/ti`]) {
      if (!existsSync(base)) continue;
      const found = (await readdir(base))
        .filter((name) => name.startsWith("sysconfig_"))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      roots.push(...found.reverse().map((name) => path.join(base, name)));
    }
  }
  for (const root of roots) {
    for (const candidate of [path.join(root, "dist", "deviceData"), root]) {
      if (existsSync(path.join(candidate, "gpns.json"))) return candidate;
    }
  }
  throw new Error(
    `找不到 SysConfig 的器件库。试过：${roots.join(", ") || "(无)"}\n`
    + "用 --sysconfig 指定 SysConfig 安装目录，或设环境变量 SYSCONFIG_HOME。",
  );
}

/* ── 名字翻译 ─────────────────────────────────────────────────────── */

/* 外设名的改写。键是 SysConfig 的外设前缀，值是改写函数；返回 null 表示
   这个外设只是分组名，信号名本身已经够了（SYSCTL.LFXIN → LFXIN）。 */
const PERIPHERAL_RULES = [
  [/^SYSCTL$/, () => null],
  [/^DEBUGSS$/, () => null],
  [/^LFSS\d*$/, () => null],
  [/^SYSMEM$/, () => null],
  [/^VREF$/, () => null],
  /* bxCAN 之外 TI 叫 CANFD，datasheet 的引脚表写 CAN0 */
  [/^CANFD(\d+)$/, (match) => `CAN${match[1]}`],
  /* 只有一路 DAC，datasheet 写 DAC_OUT 不带实例号 */
  [/^DAC\d*$/, () => "DAC"],
];

/* 信号名的改写，按外设族分。 */
const SIGNAL_RULES = {
  TIM: [
    /* 互补输出：CCP0_CMPL → C0N。必须排在 CCP\d 前面，否则会被前者吃掉。 */
    [/^CCP(\d)_CMPL$/, (match) => `C${match[1]}N`],
    [/^CCP(\d)$/, (match) => `C${match[1]}`],
  ],
  SPI: [
    [/^SCLK$/, () => "SCK"],
    /* CS1_POCI1 / CS2_POCI2 / CS3_CD_POCI3 —— 同一个焊盘的多种角色，
       datasheet 的引脚表只写片选那一面。 */
    [/^CS(\d)(_.*)?$/, (match) => `CS${match[1]}`],
  ],
  CAN: [
    [/^CAN(TX|RX)$/, (match) => match[1]],
  ],
  SYSCTL: [
    [/^HFCLKIN$/, () => "HFCLK_IN"],
    [/^LFCLKIN$/, () => "LFCLK_IN"],
  ],
};

/*
  SysConfig 的 "外设.信号" → datasheet 写法。

  TIMA 的故障线要特别说一句：SysConfig 把它按实例拆成 TIMA0.FAULT1 和
  TIMA1.FAULT1 两条挂在同一个 mode 上，而 datasheet 把它当成一条共享的
  TIMA_FAL1。所以这里丢掉实例号，靠后面的 (名字, af) 去重把重复的那条并掉。
*/
function translate(raw) {
  const dot = raw.indexOf(".");
  if (dot === -1) return null; // 形如 "PA0" 的 GPIO 自身条目
  let peripheral = raw.slice(0, dot);
  let signal = raw.slice(dot + 1);

  /* ADC 通道：ADC0.13 → A0_13，这是 analog.js 的 ti 约定 */
  const adc = /^ADC(\d+)$/.exec(peripheral);
  if (adc && /^\d+$/.test(signal)) return `A${adc[1]}_${signal}`;

  /* TIMA 故障线：丢实例号，合并成共享的一条 */
  const fault = /^TIMA\d+$/.test(peripheral) && /^FAULT(\d)$/.exec(signal);
  if (fault) return `TIMA_FAL${fault[1]}`;

  /* 按前缀找规则族，不能靠"字母部分"去切：TIMA0 / TIMG8 的字母部分是 TIMA /
     TIMG，CANFD0 的是 CANFD，都对不上 TIM / CAN 这两个键。 */
  const family = Object.keys(SIGNAL_RULES).find((key) => peripheral.startsWith(key));
  for (const [pattern, rewrite] of SIGNAL_RULES[family] || []) {
    const match = pattern.exec(signal);
    if (match) { signal = rewrite(match); break; }
  }
  for (const [pattern, rewrite] of PERIPHERAL_RULES) {
    const match = pattern.exec(peripheral);
    if (match) { peripheral = rewrite(match); break; }
  }
  return peripheral ? `${peripheral}_${signal}` : signal;
}

/* ── 组装 ─────────────────────────────────────────────────────────── */

const PIN_KIND = { Default: "gpio", Power: "supply", Ground: "supply", Fixed: "special" };

const DEBUG_SIGNAL = /^(SWDIO|SWCLK|TDI|TDO|TMS|TCK)$/;
/* 只保护晶振脚。ROSC 是内部振荡器的可选外接偏置电阻，不装晶振的板子上它就是
   一个普通 GPIO——既有的手工 MSPM0 数据也是这么划的，保持一致。 */
const OSC_SIGNAL = /^(LFXIN|LFXOUT|HFXIN|HFXOUT)$/;

/*
  封装形态的判定交给 src/lib/package.js 的 layoutKindOf()，不在这里另写一套
  正则。四边（LQFP/QFN）、两边（SOP/TSSOP/SSOP）、栅格（BGA/CSP）三种的
  每边脚数算法完全不同——TSSOP-20 按四边算会得到"每边 5 脚"，而 package.js
  按两边布局只会安置 10 个脚，另外 10 个在封装图上根本画不出来。

  pinsPerSide 只在四边封装上显式写出（此时 pinCount/4 是准确的）；两边和栅格
  留给 package.js 自己推（它分别按 ceil(pinCount/2) 和行列数处理），写错还不如
  不写。
*/
function packageInfoOf(name, pinCount) {
  /* "LQFP-64(PM)" → shape LQFP / code PM；"NFBGA-100(ZAW)" 同理 */
  const match = /^([A-Z]+)-(\d+)\(([^)]+)\)$/.exec(name);
  const shape = match?.[1] || name;
  const code = match?.[3] || "";
  const geometry = { shape, ...(code ? { packageCode: code } : {}) };

  const kind = layoutKindOf({ packageGeometry: geometry, pinCount });
  if (kind === "quad" && pinCount % 4 === 0) {
    geometry.pinsPerSide = pinCount / 4;
    geometry.numbering = "counterclockwise";
  }
  return {
    label: match ? `${shape}${match[2]}${code ? ` (${code})` : ""}` : name,
    geometry,
    isGrid: kind === "grid",
  };
}

function buildDevice({ data, packageName, part, args }) {
  const pkg = Object.values(data.packages).find((item) => item.name === packageName);
  if (!pkg) {
    throw new Error(
      `器件族里没有封装「${packageName}」。可选：\n  `
      + Object.values(data.packages).map((item) => item.name).join("\n  "),
    );
  }

  const info = packageInfoOf(pkg.name, pkg.packagePin.length);

  /* packagePin 在库里不是按脚号排的（G3519 的 LQFP-64 从 33 开始），要自己排。
     栅格封装的 ball 是 D3 这种字母数字，排序按数组顺序另行处理。 */
  const ordered = info.isGrid
    ? pkg.packagePin.map((item, index) => ({ ...item, number: index + 1, location: item.ball }))
    : [...pkg.packagePin]
      .map((item) => ({ ...item, number: Number(item.ball) }))
      .sort((left, right) => left.number - right.number);

  /* devicePinID → mux 条目 */
  const muxByPin = new Map(data.muxes.map((item) => [item.devicePinID, item.muxSetting]));

  const stats = { analog: 0, functions: 0, untranslated: new Set() };

  const pins = ordered.map((entry) => {
    const device = data.devicePins[entry.devicePinID];
    if (!device) throw new Error(`封装引用了不存在的 devicePin ${entry.devicePinID}`);
    const kind = PIN_KIND[device.devicePinType] || "special";

    const functions = [];
    const additionalFunctions = [];
    const seen = new Set();

    /* 唤醒能力在 SysConfig 里是引脚属性而不是一条 mux 功能，但 datasheet 的
       "additional functions" 列把它写成 WAKE，既有手工数据也是这么记的。
       核对过：io_wakeup 为真的 GPIO 与手工标 WAKE 的完全一致。 */
    if (device.attributes?.io_wakeup) additionalFunctions.push("WAKE");

    for (const setting of muxByPin.get(entry.devicePinID) || []) {
      const raw = data.peripheralPins[setting.peripheralPinID]?.name;
      if (!raw) continue;
      const mode = Number(setting.mode);
      const name = translate(raw);
      if (!name) continue; // GPIO 自身（mode 1）

      if (mode === 0) {
        /* 模拟通道、振荡器输入、比较器输入、VREF —— 不占复用功能编号 */
        if (!additionalFunctions.includes(name)) additionalFunctions.push(name);
        stats.analog += 1;
        continue;
      }
      /* 同一个 mode 上可能挂多条（TIMA0/TIMA1 的共享故障线合并后重名），
         按 (名字, af) 去重。 */
      const key = `${name}|${mode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      functions.push({ name, af: mode });
      stats.functions += 1;
      if (raw.includes(".") && name.includes("_") === false && !/^[A-Z0-9+_-]+$/.test(name)) {
        stats.untranslated.add(raw);
      }
    }

    const protection = [];
    if (functions.some((item) => DEBUG_SIGNAL.test(item.name))) protection.push("debug");
    if (additionalFunctions.some((name) => OSC_SIGNAL.test(name))) protection.push("oscillator");
    if (device.name === "NRST") protection.push("system");

    return {
      number: entry.number,
      ...(info.isGrid ? { location: entry.location } : {}),
      name: device.name,
      resetName: device.name,
      kind,
      ioType: kind === "supply" ? "S" : "I/O",
      /*
        io_type 是真实的焊盘类型：SD 标准驱动 / SDW 标准驱动带唤醒 /
        HD 高驱动 / HS 高速 / OD 开漏。

        注意**不**据此声明 electrical.fiveVoltTolerantIoStructures：MSPM0 上
        耐 5V 的确实是开漏那几个脚，但"OD 就等于耐 5V"是我的推断而不是这份
        数据说的，编进去等于凭空造一条电气结论。留空则界面隐藏 5V 开关，
        是安全的降级；查过 datasheet 之后可以手工补上，重跑导入会沿用。
      */
      ioStructure: kind === "supply" ? "-" : (device.attributes?.io_type || "STD"),
      notes: "-",
      functions,
      additionalFunctions,
      protection,
    };
  });

  const family = args.family || /^([A-Z]+\d*[A-Z]*\d{2})/.exec(part.toUpperCase())?.[1] || part;
  const core = args.core || CORE_BY_FAMILY.find(([pattern]) => pattern.test(part.toUpperCase()))?.[1] || "";

  return {
    device: {
      id: `ti-${part.toLowerCase()}-${info.geometry.shape.toLowerCase()}${pins.length}`
        + `${info.geometry.packageCode ? `-${info.geometry.packageCode.toLowerCase()}` : ""}`,
      partNumber: part.toUpperCase(),
      vendor: "Texas Instruments",
      family,
      ...(core ? { core } : {}),
      package: info.label,
      pinCount: pins.length,
      uiProfile: args.uiProfile || "generic",
      status: "generated",
      analogConvention: "ti",
      signalDialect: "ti-mspm0",
      packageGeometry: info.geometry,
      source: {
        document: `TI SysConfig deviceData ${data.__family}`,
        revision: data.__sysconfigVersion || "unknown",
        url: "https://www.ti.com/tool/SYSCONFIG",
        pinTable: `deviceData/${data.__family}/${data.__family}.json`,
        packageName: pkg.name,
      },
      pins,
    },
    stats,
    core,
  };
}


/* ── 对外入口 ─────────────────────────────────────────────────────── */

export { resolveDeviceData, packageInfoOf };

/* 型号 → 可选封装。选择器要用它列出一颗片子有哪几种封装。 */
export async function packagesOf(deviceDataDir, part) {
  const gpns = JSON.parse(await readFile(path.join(deviceDataDir, "gpns.json"), "utf8"));
  const key = Object.keys(gpns).find((item) => item.toUpperCase() === part.toUpperCase());
  if (!key) throw new Error(`SysConfig 的器件表里没有 ${part}`);
  return { partKey: key, packages: gpns[key].packages || {} };
}

/*
  从 SysConfig 器件库生成一颗器件的数据。

  `previous` 用于沿用上一次手工补的 5V 白名单——io_type 给了焊盘类型，但
  "哪种类型耐 5V"这份数据没说，那一条只能人查 datasheet。
*/
export async function importTi({ deviceDataDir, part, packageName, uiProfile, core, family, previous }) {
  const { partKey, packages } = await packagesOf(deviceDataDir, part);
  const names = Object.keys(packages);
  const chosen = names.find((name) => name.toLowerCase() === String(packageName).toLowerCase());
  if (!chosen) throw new Error(`${partKey} 没有封装「${packageName}」。可选：${names.join(" / ")}`);

  const familyId = Object.values(packages[chosen])[0]?.legacyDevice;
  if (!familyId) throw new Error(`封装 ${chosen} 没有对应的器件族`);

  const dataPath = path.join(deviceDataDir, familyId, `${familyId}.json`);
  if (!existsSync(dataPath)) throw new Error(`找不到器件族数据：${dataPath}`);
  const data = JSON.parse(await readFile(dataPath, "utf8"));
  data.__family = familyId;
  data.__sysconfigVersion = path.basename(path.resolve(deviceDataDir, "..", "..")).replace(/^sysconfig_/, "");

  const built = buildDevice({
    data, packageName: chosen, part: partKey, args: { uiProfile, core, family },
  });
  if (previous?.electrical) built.device.electrical = previous.electrical;
  return { ...built, family: familyId, packageName: chosen };
}
