/*
  Peripheral-to-planner templates. Only expose requests the pin allocator can
  actually create. A template describes a starter request, not a complete
  peripheral configuration or a conflict-free solution.
*/
export const GUIDE_PLANNER_TEMPLATES = Object.freeze({
  spi: { type: "SPI", variant: "full3", label: "SPI 全双工 3 线" },
  i2c: { type: "I2C", variant: "std", label: "I²C SCL / SDA" },
  uart: { type: "UART", variant: "duplex", label: "UART TX / RX" },
  "fdcan": { type: "FDCAN", variant: "std", label: "FDCAN TX / RX" },
  "usb-fs": { type: "USB", variant: "device", label: "USB 设备 D+ / D−" },
  "usb-otg": { type: "USB", variant: "otg", label: "USB OTG" },
  sdmmc: { type: "SDMMC", variant: "bit4", label: "SDMMC 4 位总线" },
  quadspi: { type: "QUADSPI", variant: "bank1", label: "QUADSPI 单 Bank" },
  eth: { type: "ETH", variant: "rmii", label: "ETH RMII" },
  tim: { type: "TIM", variant: "pwm1", label: "定时器 1 路 PWM" },
  adc: { type: "ADC", variant: "ch1", label: "ADC 1 路输入" },
  dac: { type: "DAC", variant: "out1", label: "DAC 1 路输出" },
  gpio: { type: "GPIO", variant: "io1", label: "GPIO 1 路" },
});

/* These usage IDs have an unambiguous counterpart in the allocator today. */
export const USAGE_PLANNER_TEMPLATES = Object.freeze({
  sd: { type: "SDMMC", variant: "bit4", label: "SDMMC 4 位总线" },
  qspi: { type: "QUADSPI", variant: "bank1", label: "QUADSPI 单 Bank" },
  eth: { type: "ETH", variant: "rmii", label: "ETH RMII" },
});

export function guidePlannerTemplate(guideId) {
  return GUIDE_PLANNER_TEMPLATES[guideId] || null;
}

export function usagePlannerTemplate(usageId) {
  return USAGE_PLANNER_TEMPLATES[usageId] || null;
}
