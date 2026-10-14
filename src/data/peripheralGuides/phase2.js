export const GUIDE_COMPARISONS = {
  fmc: [
    { title: "FMC 与 FSMC", left: "FMC 覆盖并行存储器控制；支持 SDRAM 的具体型号需单独核对。", right: "FSMC 是较早的静态存储控制器，不能据名称推断支持 SDRAM。" },
    { title: "FMC 与串行 Flash", left: "FMC 使用并行地址/数据及控制信号，适合外部并行存储器。", right: "QUADSPI/OCTOSPI 使用较少引脚访问串行存储器，协议和吞吐特性不同。" },
  ],
  fsmc: [{ title: "FSMC 与 FMC", left: "FSMC 常用于 SRAM、NOR、NAND 和并行接口。", right: "FMC 扩展了支持范围，但是否支持 SDRAM 必须查具体器件资料。" }],
  sdmmc: [{ title: "SDMMC 与 SPI 接 SD 卡", left: "SDMMC 是专用主机接口，常见 1/4 位 SD 总线或型号支持的 eMMC。", right: "SPI 模式通常引脚较少、速率和协议不同；MCU 侧使用普通 SPI 控制器。" }],
  sdio: [{ title: "SDIO 与 SDMMC", left: "不同系列或代际可能使用不同外设名称。", right: "按 SD 卡用途可以比较，但应按目标器件文档确认协议及控制器能力。" }],
  ltdc: [{ title: "LTDC 与 SPI 屏", left: "LTDC 连续输出并行 RGB 像素和同步信号，通常需要帧缓冲。", right: "SPI 屏由 MCU 通过串行命令/数据更新，接口脚少但刷新方式不同。" },
    { title: "LTDC 与 MIPI DSI", left: "LTDC 面向并行 RGB 屏时序。", right: "DSI Host 面向 MIPI DSI 屏；两者电气接口与屏幕要求不同。" }],
  dcmi: [{ title: "DCMI 与 MIPI CSI-2", left: "DCMI 接收并行 DVP 摄像头数据。", right: "CSI-2 通过高速差分通道接收串行摄像头数据，器件支持情况要单独查证。" }],
  dcmipp: [{ title: "DCMI 与 DCMIPP", left: "DCMI 是并行摄像头采集接口。", right: "DCMIPP 是带像素处理流水线的接口块，具体输入和处理功能按型号核对。" }],
  dma2d: [{ title: "DMA 与 DMA2D", left: "DMA 搬运外设与内存数据。", right: "DMA2D 针对图像操作做二维搬运、颜色转换和混合，不是普通 DMA 的替代品。" }],
  sai: [{ title: "SAI 与 I²S", left: "SAI 是可配置的串行音频接口，支持的模式较广。", right: "I²S 是常见音频串行协议；SAI 实例可能支持 I²S 模式，但需按型号确认。" }],
  hrtim: [{ title: "HRTIM 与通用 TIM", left: "HRTIM 提供高分辨率、多定时单元和复杂事件联动，面向电源控制等场景。", right: "通用定时器适合常见 PWM、输入捕获和计时任务，配置更简单。" }],
  cordic: [{ title: "CORDIC 与 FMAC", left: "CORDIC 加速三角、双曲等函数计算。", right: "FMAC 加速数字滤波中的乘加运算；两者优化的算法类型不同。" }],
};

export const GUIDE_USE_CASES = {
  fmc: [
    { usage: "fmc-sdram", title: "SDRAM", parts: ["MCU · FMC", "地址 / 数据 / 控制线", "外部 SDRAM"] },
    { usage: "fmc-sram", title: "SRAM / PSRAM", parts: ["MCU · FMC/FSMC", "地址 / 数据 / 读写线", "外部 RAM"] },
    { usage: "fmc-nand", title: "NAND Flash", parts: ["MCU · FMC/FSMC", "命令 / 地址 / 数据线", "NAND Flash"] },
    { usage: "fmc-lcd", title: "8080 并口屏", parts: ["MCU · FMC/FSMC", "数据 / 读写 / 片选", "LCD 控制器"] },
  ],
  fsmc: [
    { usage: "fmc-sram", title: "SRAM / PSRAM", parts: ["MCU · FSMC", "地址 / 数据 / 读写线", "外部 RAM"] },
    { usage: "fmc-nand", title: "NAND Flash", parts: ["MCU · FSMC", "命令 / 地址 / 数据线", "NAND Flash"] },
    { usage: "fmc-lcd", title: "8080 并口屏", parts: ["MCU · FSMC", "数据 / 读写 / 片选", "LCD 控制器"] },
  ],
  sdmmc: [{ usage: "sd", title: "SD 卡 4 位", parts: ["MCU · SDMMC", "CLK / CMD / D0–D3", "SD 卡"] }],
  sdio: [{ usage: "sd", title: "SD 卡 4 位", parts: ["MCU · SDIO", "CLK / CMD / D0–D3", "SD 卡"] }],
  quadspi: [{ usage: "qspi", title: "QSPI Flash", parts: ["MCU · QUADSPI", "CLK / CS / IO0–IO3", "外部 Flash"] }],
  eth: [{ usage: "eth", title: "以太网 RMII", parts: ["MCU · ETH MAC", "RMII · MDC/MDIO", "外部 PHY → 网口"] }],
  dcmi: [{ usage: "dcmi", title: "并行摄像头", parts: ["摄像头", "DVP · PCLK / 同步 / 数据", "MCU · DCMI"] }],
  ltdc: [{ usage: "ltdc", title: "RGB565 屏", parts: ["MCU · LTDC", "RGB / PCLK / 同步", "RGB 屏"] }],
};
