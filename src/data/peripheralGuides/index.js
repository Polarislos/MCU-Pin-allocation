import { CAPABILITIES } from "../../lib/capabilities.js";
const content = {
  "fmc": {
    "summary": "连接外部并行存储器的控制器，也可驱动部分并行屏。",
    "uses": "扩展SRAM、支持型号上的SDRAM、8080接口屏",
    "signals": "地址、数据、片选、读写控制",
    "caution": "存储器类型、位宽和封装信号必须逐项确认；有FMC不等于能接SDRAM。"
  },
  "fsmc": {
    "summary": "用于访问外部静态存储器的控制器。",
    "uses": "SRAM、NOR、支持型号上的NAND、并行屏",
    "signals": "地址、数据、片选、读写控制",
    "caution": "与FMC分别筛选，不能据名称推断支持SDRAM。"
  },
  "sdmmc": {
    "summary": "直接与SD、SDIO或MMC设备通信的主机接口。",
    "uses": "SD卡存储、支持型号上的eMMC",
    "signals": "CLK、CMD、数据线",
    "caution": "确认总线宽度、设备协议、电压和封装信号。"
  },
  "sdio": {
    "summary": "部分STM32采用的SD/SDIO主机外设名称。",
    "uses": "SD卡、支持型号上的SDIO设备",
    "signals": "CLK、CMD、数据线",
    "caution": "保留数据库实际名称；与SDMMC按用途关联，不视为完全相同。"
  },
  "quadspi": {
    "summary": "使用多条数据线访问外部串行存储器。",
    "uses": "外部Flash、支持协议下的其他存储器",
    "signals": "时钟、片选、数据线",
    "caution": "确认存储器指令、寻址和是否支持内存映射。"
  },
  "octospi": {
    "summary": "支持更宽数据通路的外部串行存储接口。",
    "uses": "外部Flash、兼容的PSRAM",
    "signals": "时钟、片选、数据、可选数据选通信号",
    "caution": "并非任意八线存储器都兼容，检查协议和时序。"
  },
  "hspi": {
    "summary": "用于高速外部存储的十六线接口。",
    "uses": "兼容的外部存储器",
    "signals": "时钟、片选、数据、选通信号",
    "caution": "检查具体协议、数据宽度、供电及封装。"
  },
  "xspi": {
    "summary": "用于外部串行存储器的接口。",
    "uses": "外部Flash、兼容的RAM",
    "signals": "时钟、片选、数据、可选选通信号",
    "caution": "宽度和协议取决于型号，不从名称推断。"
  },
  "ltdc": {
    "summary": "持续输出像素和同步信号，直接驱动RGB屏。",
    "uses": "图形界面、仪表、显示终端",
    "signals": "RGB、像素时钟、HSYNC、VSYNC、DE",
    "caution": "还需考虑帧缓冲容量和带宽；LTDC不是SPI屏接口。"
  },
  "dsihost": {
    "summary": "将显示数据传给MIPI DSI屏幕。",
    "uses": "高分辨率显示终端",
    "signals": "差分时钟和数据通道",
    "caution": "确认通道数量、屏幕时序、电气要求和工作模式。"
  },
  "dma2d": {
    "summary": "在内存中加速图像搬运、颜色转换和混合。",
    "uses": "GUI绘制、帧缓冲处理",
    "signals": "内部功能，无专属外部引脚",
    "caution": "它不直接驱动屏幕，也不等于通用GPU。"
  },
  "gpu2d": {
    "summary": "提供二维图形绘制加速。",
    "uses": "图形界面、图像变换",
    "signals": "内部功能，无专属外部引脚",
    "caution": "支持的操作和软件库依具体器件而定。"
  },
  "dcmi": {
    "summary": "接收并行摄像头输出的像素数据。",
    "uses": "DVP摄像头采集",
    "signals": "数据、像素时钟、行场同步",
    "caution": "它不负责摄像头寄存器配置；还需存储带宽与合适时序。"
  },
  "dcmipp": {
    "summary": "接收并处理摄像头像素数据的流水线。",
    "uses": "摄像头采集和像素处理",
    "signals": "输入接口取决于器件",
    "caution": "可用处理功能和输入类型需核对具体器件。"
  },
  "csi2": {
    "summary": "通过MIPI CSI-2接口接收摄像头数据。",
    "uses": "串行摄像头接入",
    "signals": "差分时钟与数据通道",
    "caution": "CSI-2与DSI用途不同；检查通道、格式和带宽。"
  },
  "isp": {
    "summary": "对传感器原始图像进行图像处理。",
    "uses": "颜色处理、RAW图像处理",
    "signals": "内部像素处理路径",
    "caution": "处理模块和算法支持取决于器件。"
  },
  "jpeg": {
    "summary": "硬件执行JPEG图像编解码操作。",
    "uses": "照片压缩、图像显示",
    "signals": "内部功能，无专属外部引脚",
    "caution": "确认编码或解码能力、像素格式和存储带宽。"
  },
  "h264": {
    "summary": "将视频帧压缩成H.264码流的硬件。",
    "uses": "视频记录、传输",
    "signals": "内部功能，无专属外部引脚",
    "caution": "确认分辨率、帧率、格式；编码器不代表解码器。"
  },
  "pssi": {
    "summary": "与外部器件同步交换并行数据。",
    "uses": "外部逻辑或采集器件通信",
    "signals": "数据、时钟、控制信号",
    "caution": "检查方向、位宽和握手；可能与摄像头资源共享。"
  },
  "eth": {
    "summary": "以太网MAC负责网络帧的收发。",
    "uses": "有线网络设备",
    "signals": "MII/RMII等，依器件确定",
    "caution": "通常还需外部PHY及网络软件；MAC不等于完整网口。"
  },
  "can": {
    "summary": "用于经典CAN总线通信的控制器。",
    "uses": "工业设备、控制网络",
    "signals": "TX、RX",
    "caution": "需要外部收发器；经典CAN不等于CAN FD。"
  },
  "fdcan": {
    "summary": "支持CAN FD能力的CAN控制器。",
    "uses": "工业网络、较大数据帧通信",
    "signals": "TX、RX",
    "caution": "需要兼容收发器，检查位时序、实例和消息RAM。"
  },
  "usb-fs": {
    "summary": "提供全速USB通信的控制器。",
    "uses": "USB串口、HID等设备",
    "signals": "D+、D−及供电检测等",
    "caution": "设备、主机角色需单独确认。"
  },
  "usb-hs": {
    "summary": "提供高速USB控制器能力。",
    "uses": "高速数据交换",
    "signals": "取决于内置PHY或外部ULPI接口",
    "caution": "有HS控制器不代表自带HS PHY，需核对具体器件。"
  },
  "usb-otg": {
    "summary": "支持USB OTG控制的功能。",
    "uses": "需要切换USB角色的设备",
    "signals": "接口及角色检测依器件确定",
    "caution": "OTG、双角色和主机模式分别核实。"
  },
  "usb-host": {
    "summary": "让MCU作为USB主机访问外设。",
    "uses": "读U盘、接USB输入设备",
    "signals": "USB数据与VBUS供电控制",
    "caution": "还需VBUS供电、保护和主机协议栈。"
  },
  "usb-hs-phy": {
    "summary": "片内提供高速USB物理层。",
    "uses": "减少外接ULPI PHY需求",
    "signals": "高速USB数据和专用模拟供电等",
    "caution": "控制器与PHY分别确认，布线和供电要求见数据手册。"
  },
  "ucpd": {
    "summary": "处理USB Type-C与PD的协商控制。",
    "uses": "Type-C接口、电源协商",
    "signals": "CC及相关控制信号",
    "caution": "仍需按方案配置电源路径和保护电路。"
  },
  "i2s": {
    "summary": "在芯片与音频器件间传输数字音频。",
    "uses": "数字麦克风、DAC、功放",
    "signals": "时钟、左右声道时钟、数据，可选MCLK",
    "caution": "检查主从角色、采样格式及与SPI共享资源。"
  },
  "sai": {
    "summary": "可配置的串行音频接口。",
    "uses": "音频编解码器、多通道音频",
    "signals": "时钟、帧同步、数据",
    "caution": "协议、通道数量和PDM支持依型号确定。"
  },
  "spdifrx": {
    "summary": "接收S/PDIF数字音频流。",
    "uses": "数字音频输入",
    "signals": "接收数据输入",
    "caution": "它是接收功能；电气接口与解码格式需核对。"
  },
  "dfsdm": {
    "summary": "对数字采样流执行滤波和抽取。",
    "uses": "数字麦克风、隔离采样",
    "signals": "数字时钟与数据，依通道确定",
    "caution": "检查通道数、采样方式和滤波配置。"
  },
  "mdf": {
    "summary": "对数字数据流执行可配置滤波。",
    "uses": "数字采样、音频处理",
    "signals": "输入通道依器件确定",
    "caution": "不默认与DFSDM完全等价。"
  },
  "adf": {
    "summary": "面向音频数据流的数字滤波功能。",
    "uses": "数字麦克风音频处理",
    "signals": "时钟与数据等",
    "caution": "检查PDM输入、通道和时钟要求。"
  },
  "hrtim": {
    "summary": "生成高分辨率定时波形的定时器。",
    "uses": "数字电源、精细PWM",
    "signals": "输出、事件和故障输入",
    "caution": "分辨率与时钟依器件而定；还需驱动和保护电路。"
  },
  "opamp": {
    "summary": "集成在芯片中的运算放大器。",
    "uses": "电流采样、模拟信号调理",
    "signals": "输入、输出或内部模拟连接",
    "caution": "检查输入范围、增益模式、带宽和内部连通关系。"
  },
  "comp": {
    "summary": "比较两个模拟电压的大小。",
    "uses": "阈值检测、过流保护",
    "signals": "模拟输入及内部/外部输出",
    "caution": "检查阈值来源、迟滞和响应时间。"
  },
  "dac": {
    "summary": "把数字值转换成模拟电压。",
    "uses": "模拟控制、波形输出",
    "signals": "模拟输出，部分通道仅内部连接",
    "caution": "确认外引通道、精度、速率和负载能力。"
  },
  "cordic": {
    "summary": "加速三角、双曲等数学函数运算。",
    "uses": "电机控制、坐标变换",
    "signals": "内部功能，无专属外部引脚",
    "caution": "检查支持函数、数值格式和精度。"
  },
  "fmac": {
    "summary": "加速滤波所需的乘加运算。",
    "uses": "FIR/IIR滤波、控制算法",
    "signals": "内部功能，无专属外部引脚",
    "caution": "检查数据格式、缓冲和滤波资源限制。"
  },
  "aes": {
    "summary": "硬件加速对称加密算法。",
    "uses": "数据加密、认证协议",
    "signals": "内部功能，无专属外部引脚",
    "caution": "CRYP支持的算法依型号而定；密钥管理仍需设计。"
  },
  "saes": {
    "summary": "具备额外安全保护的AES加速功能。",
    "uses": "安全数据处理",
    "signals": "内部功能，无专属外部引脚",
    "caution": "保护能力依器件而定，不能保证整个系统安全。"
  },
  "hash": {
    "summary": "硬件计算数据摘要。",
    "uses": "完整性检查、认证协议",
    "signals": "内部功能，无专属外部引脚",
    "caution": "摘要不是加密；支持的算法依器件确定。"
  },
  "pka": {
    "summary": "加速公钥密码运算。",
    "uses": "签名验证、密钥协商",
    "signals": "内部功能，无专属外部引脚",
    "caution": "核对支持算法和参数范围。"
  },
  "rng": {
    "summary": "生成硬件随机数。",
    "uses": "密钥、随机挑战值",
    "signals": "内部功能，无专属外部引脚",
    "caution": "检查时钟、错误状态和安全用途要求。"
  },
  "npu": {
    "summary": "加速神经网络推理。",
    "uses": "图像识别、边缘AI",
    "signals": "内部功能，无专属外部引脚",
    "caution": "模型算子、量化格式和内存容量必须与工具链兼容。"
  }
};
const sources = {"memory": "https://wiki.st.com/stm32mcu/wiki/Introduction_to_external_serial_memories_XSPI_interoperability_for_STM32", "graphics": "https://www.st.com/resource/en/datasheet/stm32n657i0.pdf", "comms": "https://www.st.com/resource/en/datasheet/stm32h573li.pdf", "control": "https://www.st.com/en/microcontrollers-microprocessors/stm32g474mc.html", "security": "https://www.st.com/resource/en/datasheet/stm32h573li.pdf"};
export const PERIPHERAL_GUIDES = CAPABILITIES.map((capability) => ({ ...capability, ...content[capability.id], source: capability.id === "npu" ? "https://www.st.com/resource/en/datasheet/stm32n657i0.pdf" : ["fmc", "fsmc", "sdmmc", "sdio"].includes(capability.id) ? "https://www.st.com/resource/en/datasheet/stm32h743vi.pdf" : sources[capability.category] }));
export function guideForPeripheral(item) {
  if (!item) return null;
  const names = [item.instance, item.type, item.label, item.id].filter(Boolean).map((x) => String(x).toUpperCase());
  const instance = String(item.instance || item.label || "").toUpperCase();
  if (/^ADF[0-9]*$/.test(instance)) return PERIPHERAL_GUIDES.find((g) => g.id === "adf");
  return PERIPHERAL_GUIDES.find((g) => names.includes(g.id.toUpperCase()) || [g.label, ...(g.st?.types || [])].some((type) => names.some((name) => name === type.toUpperCase() || new RegExp("^" + type.toUpperCase() + "[0-9]+$").test(name)))) || null;
}
