/*
  常用嵌入式模块的“板级需求”目录。

  这里描述的是模块需要什么总线，而不是某一颗传感器的寄存器配置。
  这样同一个模块需求可以复用到不同 MCU，最终的物理引脚仍交给本地求解器确认。
*/
export const MODULE_CATALOG = [
  {
    id: "imu",
    name: "六轴 IMU",
    category: "传感器",
    aliases: ["imu", "六轴", "陀螺仪", "加速度计"],
    defaultVariant: "spi",
    variants: {
      spi: {
        label: "SPI 传感器总线",
        keywords: ["spi", "高速"],
        requirements: [{ type: "SPI", variant: "full3", count: 1, role: "IMU 数据总线" }],
      },
      i2c: {
        label: "I²C 传感器总线",
        keywords: ["i2c", "i²c", "iic", "低速"],
        requirements: [{ type: "I2C", variant: "std", count: 1, role: "IMU 数据总线" }],
      },
    },
    notes: "通常还需要 1–2 个 GPIO 中断脚；本阶段先将总线脚送入求解器。",
  },
  {
    id: "oled",
    name: "OLED / 小尺寸显示屏",
    category: "显示",
    aliases: ["oled", "显示屏", "屏幕", "液晶", "lcd"],
    defaultVariant: "i2c",
    variants: {
      i2c: {
        label: "I²C 显示接口",
        keywords: ["i2c", "i²c", "iic"],
        requirements: [{ type: "I2C", variant: "std", count: 1, role: "显示数据总线" }],
      },
      spi: {
        label: "SPI 显示接口",
        keywords: ["spi"],
        requirements: [{ type: "SPI", variant: "full3", count: 1, role: "显示数据总线" }],
      },
    },
    notes: "通常还需要 CS、DC、RESET 等 GPIO 控制脚。",
  },
  {
    id: "sd-card",
    name: "SD 卡",
    category: "存储",
    aliases: ["sd", "sd卡", "sd 卡", "存储卡", "tf卡", "tf 卡"],
    defaultVariant: "bit4",
    variants: {
      bit1: {
        label: "SDMMC 1-bit",
        keywords: ["1bit", "1-bit", "1 位"],
        requirements: [{ type: "SDMMC", variant: "bit1", count: 1, role: "SD 卡数据总线" }],
      },
      bit4: {
        label: "SDMMC 4-bit",
        keywords: ["4bit", "4-bit", "4 位", "高速"],
        requirements: [{ type: "SDMMC", variant: "bit4", count: 1, role: "SD 卡数据总线" }],
      },
    },
    notes: "4-bit 模式需要 6 个信号脚；还需根据硬件确认卡检测和供电控制 GPIO。",
  },
  {
    id: "ethernet",
    name: "以太网 PHY",
    category: "网络",
    aliases: ["以太网", "ethernet", "phy", "网口"],
    defaultVariant: "rmii",
    variants: {
      rmii: {
        label: "RMII + MDIO",
        keywords: ["rmii"],
        requirements: [{ type: "ETH", variant: "rmii", count: 1, role: "以太网数据总线" }],
      },
      mii: {
        label: "MII + MDIO",
        keywords: ["mii"],
        requirements: [{ type: "ETH", variant: "mii", count: 1, role: "以太网数据总线" }],
      },
    },
    notes: "RMII 需要 9 个信号脚，时钟方向和 PHY 地址仍需在硬件方案中确认。",
  },
  {
    id: "can-node",
    name: "CAN 总线节点",
    category: "通信",
    aliases: ["can", "fdcan", "汽车总线", "车载总线"],
    defaultVariant: "fdcan",
    variants: {
      fdcan: {
        label: "FDCAN 收发器接口",
        keywords: ["can", "fdcan"],
        requirements: [{ type: "FDCAN", variant: "std", count: 1, role: "CAN 收发器" }],
      },
    },
    notes: "MCU 引脚只覆盖 TX/RX，外部 CAN 收发器和终端电阻属于原理图约束。",
  },
  {
    id: "debug-uart",
    name: "调试串口",
    category: "通信",
    aliases: ["调试串口", "日志串口", "串口日志", "console", "debug uart"],
    defaultVariant: "duplex",
    variants: {
      duplex: {
        label: "USART TX / RX",
        keywords: ["uart", "usart", "串口", "收发"],
        requirements: [{ type: "UART", variant: "duplex", count: 1, role: "调试日志" }],
      },
      txonly: {
        label: "仅 TX 日志",
        keywords: ["仅发送", "只发", "tx only", "tx-only"],
        requirements: [{ type: "UART", variant: "txonly", count: 1, role: "调试日志" }],
      },
    },
    notes: "如果需要下载器或串口助手回传，再把 RX 纳入需求。",
  },
  {
    id: "usb-device",
    name: "USB 设备",
    category: "通信",
    aliases: ["usb", "usb设备", "usb 设备", "usb device"],
    defaultVariant: "device",
    variants: {
      device: {
        label: "USB FS / HS DM + DP",
        keywords: ["usb", "device", "设备"],
        requirements: [{ type: "USB", variant: "device", count: 1, role: "USB 设备接口" }],
      },
      otg: {
        label: "USB OTG DM + DP + ID",
        keywords: ["otg"],
        requirements: [{ type: "USB", variant: "otg", count: 1, role: "USB OTG 接口" }],
      },
    },
    notes: "USB 供电、ESD、VBUS 检测和连接器保护不在引脚求解范围内。",
  },
  {
    id: "bldc-drive",
    name: "三相电机驱动",
    category: "执行器",
    aliases: ["三相电机", "无刷电机", "bldc", "电机驱动", "pwm"],
    defaultVariant: "bldc",
    variants: {
      bldc: {
        label: "三相互补 PWM + 刹车",
        keywords: ["三相", "无刷", "bldc", "互补", "pwm"],
        requirements: [{ type: "TIM", variant: "bldc", count: 1, role: "三相逆变 PWM" }],
      },
      pwm1: {
        label: "单路 PWM",
        keywords: ["单路", "单相"],
        requirements: [{ type: "TIM", variant: "pwm1", count: 1, role: "执行器 PWM" }],
      },
    },
    notes: "死区、刹车输入、栅极驱动和电流采样仍需结合定时器与 ADC 方案确认。",
  },
];

export function moduleVariant(module, text = "") {
  const normalized = String(text).toLowerCase();
  const variants = Object.entries(module.variants || {});
  return variants.find(([, variant]) => variant.keywords?.some((keyword) => normalized.includes(keyword.toLowerCase())))
    || variants.find(([id]) => id === module.defaultVariant)
    || variants[0]
    || [null, { label: "", requirements: [] }];
}

export function moduleMatchesText(module, text) {
  const normalized = String(text).toLowerCase();
  return module.aliases.some((alias) => normalized.includes(alias.toLowerCase()));
}

export function resolveModule(module, text = "") {
  const [variantId, variant] = moduleVariant(module, text);
  return {
    id: module.id,
    name: module.name,
    category: module.category,
    variantId,
    variantLabel: variant.label,
    requirements: variant.requirements || [],
    notes: module.notes,
  };
}
