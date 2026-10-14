# STM32CubeMX2 C5 数据

来源：STMicroelectronics 官方 stm32c5xx-dfp，DFP 2.1.0。
本机 CubeMX2 1.1.1 的 pack-manager snapshot 同样引用该版本。
https://github.com/STMicroelectronics/stm32c5xx-dfp

包含 157 个明确订货型号与封装组合。保留官方引脚、AF、电气结构、Flash、SRAM 和主频字段；没有提供的供电范围保持未知。
每个型号应用 limitations 的 removed_peripherals，避免把共用芯片描述中的裁剪外设加入选型或引脚规划。组合外设拆成官方的子实例。

重新生成：

```powershell
git clone --depth 1 https://github.com/STMicroelectronics/stm32c5xx-dfp.git tools/vendor/stm32c5xx-dfp
python tools/import-cubemx2.py
npm run mcu:catalog
```

导入器需 Python 3。已生成的数据不依赖原始安装路径或下载目录；本地 /api/mcu 直接读取 mcus 中的对应文件。
数据受原始 ST 器件包的许可约束，见 LICENSE.md。
