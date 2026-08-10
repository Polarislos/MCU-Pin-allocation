/*
  由 `npm run mcu:index` 从 src/data/mcus/ 生成，请勿手改。

  清单只放选择器需要的元数据；引脚表通过 load() 按需加载，所以首屏包里
  一颗器件的数据都没有。加片子的流程见 tools/build-mcu-index.mjs。
*/
export const MCU_MANIFEST = [
  {
    id: "st-stm32f103c8t6-lqfp48",
    partNumber: "STM32F103C8T6",
    vendor: "STMicroelectronics",
    family: "STM32F103",
    core: "ARM Cortex-M3",
    package: "LQFP48",
    pinCount: 48,
    uiProfile: "generic",
    signalDialect: "st-f1",
    analogConvention: "st",
    status: "generated",
    file: "stm32f103c8t6.json",
    load: () => import("./stm32f103c8t6.json", { with: { type: "json" } }).then((module) => module.default),
  },
  {
    id: "st-stm32h743vit6-lqfp100",
    partNumber: "STM32H743VIT6",
    vendor: "STMicroelectronics",
    family: "STM32H743VI",
    core: "ARM Cortex-M7",
    package: "LQFP100",
    packageSize: "14x14 mm",
    pinCount: 100,
    uiProfile: "stm32-cube",
    signalDialect: "st",
    analogConvention: "st",
    status: "verified",
    file: "stm32h743vit6.json",
    load: () => import("./stm32h743vit6.json", { with: { type: "json" } }).then((module) => module.default),
  },
  {
    id: "ti-mspm0g3519-lqfp64-pm",
    partNumber: "MSPM0G3519",
    vendor: "Texas Instruments",
    family: "MSPM0G35",
    core: "ARM Cortex-M0+",
    package: "LQFP64 (PM)",
    packageSize: "12x12 mm",
    pinCount: 64,
    uiProfile: "ti-mspm0",
    signalDialect: "ti-mspm0",
    analogConvention: "ti",
    status: "verified",
    file: "mspm0g3519.js",
    load: () => import("./mspm0g3519.js").then((module) => module.default),
  },
];
