/*
  能力目录：选型时常问的外设能力，以及它们在各厂商数据库里**实际叫什么**。

  和 deviceSearch.js 的类型条件、分组的区别：
  - 类型条件是严格的厂商名称（FMC 只匹配 FMC）；
  - 分组只看"有没有"，不区分厂商有没有被映射过；
  - 能力条件按厂商分别映射。**某厂商没有映射的能力，这家的器件计为"未收录"**，
    既不算满足也不算不满足——没有核实过对应关系就下结论，等于伪造数据。

  ── 映射的依据 ────────────────────────────────────────────────────
  st：CubeMX db/mcu/*.xml 的 <IP Name>（定时器等例外见 build-device-index.mjs）。
      instances 用于同一 IP 名下要再分的情况：CubeMX 把 ADF1 的 IP 名记成 MDF，
      ADF 与 MDF 只能靠实例名区分。
  ti：SysConfig 器件族数据的接口类型（build-device-index.mjs 的 tiType 归一化后）。
      只收**功能相同**的块：MCAN 就是 CAN FD，OSPI 就是八线 SPI，CSI2_0 的信号是
      CSI-2 的差分对。功能接近但不等同的不收（SDFM ≠ DFSDM，DSS ≠ LTDC），
      名字看不出功能的不收（MSPM33 的 SHAW），数据里没区分规格的不收
      （TI 的 USB 没写 FS/HS/OTG）。

  ── 三态 ──────────────────────────────────────────────────────────
  每颗器件对每项能力的结论只有三种：确定有（命中实例）、确定没有（空数组）、
  数据未知（null）。"未知"有两个来源：这家厂商没映射；或者映射了，但这颗片子的
  记录不足以下结论（有 HS 控制器却没有片上 PHY 的痕迹）。两种都不能当"没有"。

  ── 市场名称 ──────────────────────────────────────────────────────
  只收 ST 在官方资料里与 IP 名并列写出的：
    Chrom-ART Accelerator = DMA2D（RM0090 等参考手册的章节标题
      "Chrom-ART Accelerator controller (DMA2D)"）
    NeoChrom = GPU2D（STM32U5x9 / STM32H7R/S 的参考手册与数据手册把 GPU2D
      称为 NeoChrom GPU）
    Neural-ART = STM32N6 的 NPU——本机库没有 N6，只作关键词，不映射。

  ── 本机库没有记录的能力 ──────────────────────────────────────────
  MIPI CSI-2、ISP、H.264 编码器、Neural-ART NPU 在 ST 这边只出现在 STM32N6 上，
  而本机 CubeMX 库没有 N6 系列，IP 名无从核实，所以 st 不写映射。装了带 N6 的
  CubeMX 之后，查到 IP 名再补，tests/capabilities.mjs 会检查映射名真实存在。
*/

export const CAPABILITY_CATEGORIES = [
  { id: "memory", label: "外部存储" },
  { id: "graphics", label: "显示、图形、摄像头" },
  { id: "comms", label: "通信与音频" },
  { id: "control", label: "控制、模拟、计算" },
  { id: "security", label: "安全与 AI" },
];

export const CAPABILITIES = [
  /* 外部存储 */
  { id: "fmc", category: "memory", label: "FMC", hint: "灵活存储控制器（含 SDRAM）", st: { types: ["FMC"] } },
  { id: "fsmc", category: "memory", label: "FSMC", hint: "静态存储控制器（无 SDRAM）", st: { types: ["FSMC"] } },
  {
    id: "sdmmc", category: "memory", label: "SDMMC", hint: "SD / SDIO / MMC 主机",
    st: { types: ["SDMMC"] }, ti: { types: ["MMC", "MMCSD", "SD"] },
  },
  { id: "sdio", category: "memory", label: "SDIO", hint: "SD/SDIO 主机（老系列命名）", st: { types: ["SDIO"] } },
  { id: "quadspi", category: "memory", label: "QUADSPI", hint: "四线 SPI Flash", st: { types: ["QUADSPI"] }, ti: { types: ["QSPI"] } },
  { id: "octospi", category: "memory", label: "OCTOSPI", hint: "八线 SPI Flash", st: { types: ["OCTOSPI"] }, ti: { types: ["OSPI"] } },
  { id: "hspi", category: "memory", label: "HSPI", hint: "十六线 SPI 存储接口", st: { types: ["HSPI"] } },
  { id: "xspi", category: "memory", label: "XSPI", hint: "扩展 SPI 存储接口", st: { types: ["XSPI"] } },

  /* 显示、图形、摄像头 */
  { id: "ltdc", category: "graphics", label: "LTDC", hint: "RGB 屏控制器", st: { types: ["LTDC"] } },
  { id: "dsihost", category: "graphics", label: "DSI Host", hint: "MIPI DSI 屏", keywords: ["DSI", "MIPI DSI"], st: { types: ["DSIHOST"] }, ti: { types: ["DSI"] } },
  { id: "dma2d", category: "graphics", label: "DMA2D", hint: "Chrom-ART 2D 加速", keywords: ["Chrom-ART", "ChromART"], st: { types: ["DMA2D"] } },
  { id: "gpu2d", category: "graphics", label: "GPU2D", hint: "NeoChrom 2D 图形处理器", keywords: ["NeoChrom"], st: { types: ["GPU2D"] } },
  { id: "dcmi", category: "graphics", label: "DCMI", hint: "并行摄像头接口", st: { types: ["DCMI"] } },
  { id: "dcmipp", category: "graphics", label: "DCMIPP", hint: "摄像头接口（带像素流水线）", st: { types: ["DCMIPP"] } },
  {
    id: "csi2", category: "graphics", label: "MIPI CSI-2", hint: "MIPI 摄像头", keywords: ["CSI", "CSI2", "CSI-2", "MIPI CSI"],
    ti: { types: ["CSI", "ISS_CSI"] },
    note: "ST：仅 STM32N6 有，本机 CubeMX 库未收录该系列",
  },
  { id: "isp", category: "graphics", label: "ISP", hint: "图像信号处理", note: "两家的本机数据库都没有可核实的 ISP 记录" },
  { id: "jpeg", category: "graphics", label: "JPEG", hint: "JPEG 硬件编解码", st: { types: ["JPEG"] } },
  {
    id: "h264", category: "graphics", label: "H.264 编码器", hint: "视频硬件编码", keywords: ["H264", "H.264", "VENC"],
    note: "ST：仅 STM32N6 有，本机 CubeMX 库未收录该系列；TI 数据中无此类接口",
  },
  { id: "pssi", category: "graphics", label: "PSSI", hint: "并行同步从接口", st: { types: ["PSSI"] } },

  /* 通信与音频 */
  { id: "eth", category: "comms", label: "ETH", hint: "以太网 MAC", st: { types: ["ETH"] }, ti: { types: ["CPSW", "EMAC", "ETHERNET"] } },
  {
    id: "can", category: "comms", label: "CAN", hint: "经典 CAN（bxCAN 等）",
    st: { types: ["CAN"] }, ti: { types: ["DCAN", "ECAN", "CAN"] },
    note: "TI 的接口类型 CAN 未区分经典 CAN 与 CAN FD",
  },
  { id: "fdcan", category: "comms", label: "FDCAN", hint: "CAN FD", st: { types: ["FDCAN"] }, ti: { types: ["MCAN"] } },
  {
    id: "usb-fs", category: "comms", label: "USB FS", hint: "全速 USB 控制器", keywords: ["USBFS", "USB全速"],
    st: { types: ["USB", "USB_OTG_FS", "USB_DRD_FS"] },
    note: "TI 数据只有 USB 接口类型，没有区分速率与角色",
  },
  {
    id: "usb-hs", category: "comms", label: "USB HS", hint: "高速 USB 控制器", keywords: ["USBHS", "USB高速"],
    st: { types: ["USB_OTG_HS", "USBH_HS"] },
    note: "有 HS 控制器不等于有片上 HS PHY：多数型号要外接 ULPI PHY 才能跑 480 Mbit/s",
  },
  {
    id: "usb-otg", category: "comms", label: "USB OTG", hint: "OTG 控制器", keywords: ["OTG"],
    st: { types: ["USB_OTG_FS", "USB_OTG_HS"] },
    note: "USB_DRD_FS 是双角色设备，不是 OTG 协议控制器，不计入",
  },
  {
    id: "usb-host", category: "comms", label: "USB 主机模式", hint: "可作 USB Host", keywords: ["USB主机", "USBHOST", "主机模式"],
    st: {
      /* OTG_FS / OTG_HS / DRD_FS / MP1 的 USBH_HS 都能做主机；usb1_* 版本的 USB 只能做设备（DEVONLY）；
         H5/U0 的 usbfs 版本数据里看不出来 → 未知 */
      evaluate(instances) {
        const host = instances.filter((item) => ["USB_OTG_FS", "USB_OTG_HS", "USB_DRD_FS", "USBH_HS"].includes(item.type));
        if (host.length) return host;
        const undecided = instances.filter((item) => item.type === "USB" && !item.features?.includes("DEVONLY"));
        return undecided.length ? null : [];
      },
    },
    note: "依据 CubeMX 的 IP 名与版本：OTG、DRD 控制器可作主机；usb1 版本的 USB 仅设备；H5/U0 的 USB 未能从数据判断",
  },
  {
    id: "usb-hs-phy", category: "comms", label: "内置 USB HS PHY", hint: "片上高速 PHY，无需外接 ULPI",
    keywords: ["HSPHY", "USBHSPHY", "内置PHY", "内置HSPHY", "片上PHY"],
    st: {
      evaluate(instances) {
        const hs = instances.filter((item) => item.type === "USB_OTG_HS");
        if (!hs.length) return [];
        const withPhy = hs.filter((item) => item.features?.includes("HSPHY"));
        return withPhy.length ? withPhy : null;
      },
    },
    note: "依据：OTG_HS 时钟使能里有 USBPHYC（U59x/U5Ax/U5Fx/U5Gx、H7R/S），或封装里有 REXTPHYHS 脚（F723/F733）。"
      + "有 HS 控制器而没有这两种痕迹的（F4/F7/H7 多数型号）记为数据未知，不当作没有",
  },
  { id: "ucpd", category: "comms", label: "UCPD", hint: "USB Type-C / PD", st: { types: ["UCPD"] } },
  { id: "i2s", category: "comms", label: "I2S", hint: "I2S 音频", st: { types: ["I2S"] }, ti: { types: ["I2S"] } },
  { id: "sai", category: "comms", label: "SAI", hint: "串行音频接口", st: { types: ["SAI"] } },
  { id: "spdifrx", category: "comms", label: "SPDIFRX", hint: "S/PDIF 接收", st: { types: ["SPDIFRX"] } },
  { id: "dfsdm", category: "comms", label: "DFSDM", hint: "Σ-Δ 数字滤波（数字麦克风）", st: { types: ["DFSDM"] } },
  { id: "mdf", category: "comms", label: "MDF", hint: "多功能数字滤波", st: { types: ["MDF"], excludeInstances: "ADF\\d*" } },
  { id: "adf", category: "comms", label: "ADF", hint: "音频数字滤波", st: { instances: "ADF\\d*" } },

  /* 控制、模拟、计算 */
  { id: "hrtim", category: "control", label: "HRTIM", hint: "高分辨率定时器", st: { types: ["HRTIM"] } },
  { id: "opamp", category: "control", label: "OPAMP", hint: "运放", st: { types: ["OPAMP"] }, ti: { types: ["OA", "GPAMP"] } },
  { id: "comp", category: "control", label: "COMP", hint: "比较器", st: { types: ["COMP"] }, ti: { types: ["COMP", "ACMP", "CMPSS", "COMPARATOR"] } },
  { id: "dac", category: "control", label: "DAC", hint: "数模转换", st: { types: ["DAC"] }, ti: { types: ["DAC"] } },
  { id: "cordic", category: "control", label: "CORDIC", hint: "三角/双曲函数加速", st: { types: ["CORDIC"] } },
  { id: "fmac", category: "control", label: "FMAC", hint: "滤波乘加加速", st: { types: ["FMAC"] } },

  /* 安全与 AI */
  { id: "aes", category: "security", label: "AES / CRYP", hint: "对称加密", keywords: ["AES", "CRYP", "加密"], st: { types: ["AES", "CRYP"] }, ti: { types: ["AES", "AESADV"] } },
  { id: "saes", category: "security", label: "SAES", hint: "安全 AES（抗侧信道）", st: { types: ["SAES"] } },
  { id: "hash", category: "security", label: "HASH", hint: "SHA / MD5 哈希", st: { types: ["HASH"] } },
  { id: "pka", category: "security", label: "PKA", hint: "公钥加速（RSA/ECC）", st: { types: ["PKA"] }, ti: { types: ["PKA"] } },
  { id: "rng", category: "security", label: "RNG", hint: "真随机数", st: { types: ["RNG"] }, ti: { types: ["TRNG"] } },
  {
    id: "npu", category: "security", label: "NPU / Neural-ART", hint: "神经网络加速", keywords: ["NPU", "NEURAL-ART", "NEURALART", "AI"],
    ti: { types: ["NPU"] },
    note: "ST：Neural-ART 仅 STM32N6 有，本机 CubeMX 库未收录该系列",
  },
];

export function capabilityById(id) {
  return CAPABILITIES.find((item) => item.id === id) || null;
}

/* 这家厂商有没有核实过的映射。没有 → 这家的器件对该能力是"未收录"。 */
export function capabilityMapping(capability, vendor) {
  return capability?.[vendor] || null;
}

/* 档案里命中该能力的实例。三态：数组非空 = 有，空数组 = 没有，null = 未知/未收录。 */
export function matchCapability(capability, vendor, instances) {
  const mapping = capabilityMapping(capability, vendor);
  if (!mapping) return null;
  if (mapping.evaluate) return mapping.evaluate(instances);
  const types = new Set(mapping.types || []);
  const include = mapping.instances ? new RegExp(`^(?:${mapping.instances})$`) : null;
  const exclude = mapping.excludeInstances ? new RegExp(`^(?:${mapping.excludeInstances})$`) : null;
  return instances.filter((item) => (types.has(item.type) || include?.test(item.name)) && !exclude?.test(item.name));
}

/*
  每项能力在本机索引里的覆盖情况：
    { [vendor]: { mapped, devices, unknown } }   unknown = 映射了但这颗片子的记录下不了结论
  mapped=false 说明这家没有映射；mapped=true 且 devices=0 说明映射了但本机库里没有
  任何器件带它——两种情况界面都标"未收录"，但原因不同，要分开写。
*/
export function capabilityCoverage(index, profileOf) {
  const vendors = index?.peripherals?.vendors || [];
  const result = new Map();
  for (const capability of CAPABILITIES) {
    const entry = {};
    for (const vendor of vendors) entry[vendor] = { mapped: Boolean(capabilityMapping(capability, vendor)), devices: 0, unknown: 0 };
    result.set(capability.id, entry);
  }
  for (const device of index?.devices || []) {
    const instances = profileOf(index, device);
    if (!instances) continue;
    for (const capability of CAPABILITIES) {
      const hits = matchCapability(capability, device.vendor, instances);
      const entry = result.get(capability.id)[device.vendor];
      if (hits?.length) entry.devices += 1;
      else if (hits === null && entry.mapped) entry.unknown += 1;
    }
  }
  return result;
}
