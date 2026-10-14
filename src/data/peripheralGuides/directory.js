import { PERIPHERAL_GUIDES } from "./index.js";

export const DIRECTORY_CATEGORIES = [
  { id: "all", label: "全部外设" },
  { id: "communications", label: "通信接口" },
  { id: "storage", label: "存储接口" },
  { id: "analog", label: "模拟与采样" },
  { id: "control", label: "定时与控制" },
  { id: "graphics", label: "显示与图像" },
  { id: "audio", label: "音频处理" },
  { id: "data", label: "数据搬运" },
  { id: "security", label: "安全与 AI" },
];

const CAPABILITY_CATEGORY = {
  memory: "storage",
  graphics: "graphics",
  comms: "communications",
  control: "control",
  security: "security",
};
const DIRECTORY_CATEGORY_OVERRIDE = {
  adf: "audio", dfsdm: "audio", i2s: "audio", mdf: "audio", sai: "audio", spdifrx: "audio",
  comp: "analog", dac: "analog", opamp: "analog",
};

const COMMON_PERIPHERALS = [
  {
    id: "gpio", category: "control", label: "GPIO", keywords: ["通用输入输出", "数字输入", "数字输出", "按键", "指示灯"],
    summary: "可由软件配置为数字输入或输出的通用引脚。",
    uses: "读取按键和数字传感器状态，控制指示灯、使能端或简单逻辑信号。",
    signals: "单个或多个可配置的数字引脚；具体电平、电流和复用能力取决于引脚规格。",
    caution: "核对引脚电压容限、输出驱动能力、上下拉配置及是否与调试或启动功能复用。GPIO 高电平不一定等于 MCU 供电电压。",
    source: "https://wiki.st.com/stm32mcu/wiki/Getting_started_with_GPIO",
  },
  {
    id: "spi", category: "communications", label: "SPI", keywords: ["串行外设接口", "传感器", "Flash", "屏幕"],
    summary: "使用时钟和数据线在控制器与外部器件之间传输数据的同步串行接口。",
    uses: "连接传感器、外部 Flash、显示控制器和 ADC 等；适合需要较高吞吐量且器件支持 SPI 的场合。",
    signals: "常见信号为 SCK、MOSI、MISO 和每个从设备的片选；实际信号名可能因厂商而异。",
    caution: "确认主从关系、时钟极性与相位、数据位宽、最高时钟、片选时序和电平兼容性。不同 SPI 外设版本支持的传输方式可能不同。",
    searchCondition: { kind: "group", value: "spi-bus", min: 1 },
    source: "https://wiki.st.com/stm32mcu/wiki/Getting_started_with_SPI",
  },
  {
    id: "i2c", category: "communications", label: "I²C", keywords: ["I2C", "两线总线", "传感器", "EEPROM"],
    summary: "使用时钟线和数据线连接多个器件的同步串行总线。",
    uses: "连接板级传感器、RTC、EEPROM 和配置芯片，适合共享总线、引脚数量有限的场景。",
    signals: "SCL 时钟线和 SDA 数据线；总线通常需要上拉，具体阻值要结合电容、速率和器件电气规格确定。",
    caution: "核对总线速率、器件地址、上拉电压、总线电容以及多主机需求。总线上的所有器件必须满足电气和时序要求。",
    searchCondition: { kind: "type", value: "I2C", min: 1 },
    source: "https://wiki.st.com/stm32mcu/wiki/Getting_started_with_I2C",
  },
  {
    id: "uart", category: "communications", label: "UART / USART", keywords: ["串口", "异步串口", "调试", "RS-232", "RS-485"],
    summary: "以约定波特率和帧格式收发串行数据的接口；UART 通信本身不提供时钟线。",
    uses: "调试日志、模块控制、与 GPS、蓝牙、RS-232 或 RS-485 收发器通信。RS-232/RS-485 的电气接口需要外部收发器。",
    signals: "常见连接使用 TX、RX 和公共地；部分配置还会使用 RTS、CTS 等流控信号。",
    caution: "两端需匹配波特率、数据位、校验位和停止位，并检查电平标准。USART 还可能支持同步等额外功能，须按型号确认。",
    searchCondition: { kind: "group", value: "serial", min: 1 },
    source: "https://wiki.st.com/stm32mcu/wiki/Getting_started_with_UART",
  },
  {
    id: "adc", category: "analog", label: "ADC", keywords: ["模数转换", "模拟采样", "传感器", "电压测量"],
    summary: "把模拟输入电压转换为数字采样值的片上转换器。",
    uses: "读取模拟传感器、电压和电流检测信号；可按器件能力配合定时器触发、DMA 或多通道扫描。",
    signals: "一个或多个模拟输入通道，部分型号还支持差分输入或内部参考通道。",
    caution: "确认输入范围、分辨率、采样时间、参考电压、输入阻抗和总采样速率。通道数量、触发方式和过采样能力因型号而异。",
    searchCondition: { kind: "type", value: "ADC", min: 1 },
    source: "https://wiki.st.com/stm32mcu/wiki/Getting_started_with_ADC",
  },
  {
    id: "dma", category: "data", label: "DMA", keywords: ["直接存储器访问", "数据搬运", "减轻CPU", "循环缓冲"],
    summary: "在外设与内存之间搬运数据的硬件控制器，可减少 CPU 逐字节处理的负担。",
    uses: "连续 ADC 采样、串口收发、音频流和存储传输；是否能与某个外设配合取决于请求映射和 DMA 能力。",
    signals: "片内数据通路，没有专属外部引脚。",
    caution: "检查 DMA 控制器数量、请求映射、通道或队列、内存可访问性、缓存一致性和数据宽度。DMA 存在不代表所有外设请求都能任意映射。",
    searchCondition: { kind: "type", value: "DMA", min: 1 },
    source: "https://wiki.st.com/stm32mcu/wiki/Category:Getting_started_with_STM32_system_peripherals",
  },
  {
    id: "tim", category: "control", label: "TIM 定时器", keywords: ["计时", "PWM", "输入捕获", "输出比较", "编码器"],
    summary: "通过计数器、预分频器和比较单元完成计时、波形生成或外部事件测量的硬件模块。",
    uses: "生成 PWM、测量脉冲宽度和频率、周期性触发采样、统计增量编码器位置。",
    signals: "依功能使用定时器通道输入/输出、外部触发或内部事件；基础计时功能可以没有专属引脚。",
    caution: "通用、高级和低功耗定时器的通道数、互补输出、死区、编码器接口及触发连接并不相同；按目标实例的参考手册确认。",
    searchCondition: { kind: "group", value: "timer", min: 1 },
    source: "https://www.st.com/resource/en/application_note/DM00042534-.pdf",
  },
  {
    id: "rtc", category: "control", label: "RTC", keywords: ["实时时钟", "日历", "闹钟", "低功耗唤醒"],
    summary: "在主程序休眠或复位后仍可维护日历时间和定时事件的片上模块。",
    uses: "时间戳、闹钟、周期唤醒和低功耗设备的时间维护。",
    signals: "通常是片内功能；一些型号提供外部低速时钟引脚或备份电源域。",
    caution: "确认备份电源、时钟源、校准方式、日历范围和低功耗唤醒能力；外部晶振和电池并非每个设计都必需。",
    searchCondition: { kind: "type", value: "RTC", min: 1 },
    source: "https://wiki.st.com/stm32mcu/wiki/Category:Getting_started_with_STM32_system_peripherals",
  },
  {
    id: "watchdog", category: "control", label: "看门狗 IWDG / WWDG", keywords: ["独立看门狗", "窗口看门狗", "故障恢复", "超时复位"],
    summary: "在软件未按预期刷新计数器时触发告警或复位的监控模块。",
    uses: "在固件失控或主循环停止时，让系统进入可恢复状态。",
    signals: "片内功能，没有专属外部引脚。",
    caution: "IWDG 与 WWDG 的时钟来源、刷新窗口和低功耗行为不同；看门狗能检测部分故障，不能替代任务监控和安全设计。",
    searchCondition: { kind: "group", value: "watchdog", min: 1 },
    source: "https://wiki.st.com/stm32mcu/wiki/Category:Getting_started_with_STM32_system_peripherals",
  },
];

const CATEGORY_ORDER = new Map(DIRECTORY_CATEGORIES.map((category, index) => [category.id, index]));

export const PERIPHERAL_DIRECTORY = [
  ...PERIPHERAL_GUIDES.map((guide) => ({
    ...guide,
    directoryCategory: DIRECTORY_CATEGORY_OVERRIDE[guide.id] || CAPABILITY_CATEGORY[guide.category] || "control",
    keywords: guide.keywords || [],
    searchCondition: guide.searchCondition || { kind: "capability", value: guide.id, min: 1 },
  })),
  ...COMMON_PERIPHERALS.map((guide) => ({ ...guide, directoryCategory: guide.category })),
].sort((left, right) => (
  (CATEGORY_ORDER.get(left.directoryCategory) ?? 99) - (CATEGORY_ORDER.get(right.directoryCategory) ?? 99)
  || left.label.localeCompare(right.label, "zh-CN")
));

export function peripheralDirectoryCategory(id) {
  return DIRECTORY_CATEGORIES.find((category) => category.id === id)?.label || "其他";
}
