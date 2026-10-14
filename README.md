# STM32H743VIT6 引脚规划器

本地运行的 STM32H743VIT6 LQFP100 引脚查询与外设分配工具。

## 功能

- **器件选择器可选约 3400 个型号**（STM32 约 2300、TI 约 1100 个「型号 × 封装」
  组合）。下拉里是固化进仓库的那几颗；点「选择其他型号…」可以搜索本机
  CubeMX / SysConfig 库里的任意一颗，选中后由本地服务器现场转换成引脚数据，
  直接进入引脚分配。详见下面的「按需选择任意型号」
- 封装图支持四边（LQFP/QFN）、两边（SOIC/TSSOP）和栅格（BGA/WLCSP）三种形态
- 完整复用功能查询
- CubeMX 风格外设分类侧边栏，可展开 Connectivity、Timers、Analog 等类别
- 点击 SPI1、SPI2、I2C1、USART1 等实例，查看每个信号的候选 GPIO、物理脚和 AF 编号
- 保护 SWD/JTAG 与外部晶振引脚
- **逐路标记 5V 电平**：只从耐 5V 的 I/O 结构里选脚，硬约束
- **ADC / DAC 通道参与分配**：一行需求 = N 路模拟通道，由求解器挑具体通道
- **普通 GPIO 参与分配**：可添加 1/2/4/8/16 路普通 GPIO，自动从可用 GPIO 中挑选
- **已使用引脚锁定**：在引脚详情中锁定已占用 GPIO，后续生成方案会把这些脚作为硬排除条件
- **方案引脚锁定**：生成方案后可一键锁定当前方案的全部引脚，后续重生成仍保持这些分配
- 排除物理引脚、锁定单组分配、生成多套方案
- **工程持久化**：自动保存到浏览器，另可导出/载入 git 友好的 `.pinplan.json`
- **方案对比**：方案 A/B 互比，或与载入的基线工程逐信号比对
- 导出方案 CSV / **全部引脚定义 CSV** / CubeMX `.ioc` 片段 / HAL 引脚头文件 / Markdown 评审表
- **嘉立创EDA 扩展**：导出一份 JSON，在 EDA 里选中 MCU 点一下，所有网络标签一次打完（先核对符号，不过不写；打完可一键撤销）
- AI 工作流面板：输入模块化自然语言需求，生成可审查的接口草案，再一键应用并启动引脚求解
- 常用模块目录：六轴 IMU、OLED、SD 卡、以太网 PHY、CAN、调试串口、USB、三相电机

## 从外设配置直接选外设

左侧「外设配置」里每个可分配的实例后面有个 **+**，点一下就把这一路加进接口需求，
并把实例锁定到它（点的是 SPI3 就不该被换成 SPI1）。已加入的显示 **✓**，再点移除。

条目名称本身仍然是**检视**——右侧列出它能落到哪些物理引脚。没有把整行做成
"点一下就加进需求"：先看清楚 SPI3 到底有没有可用的脚、会不会和调试口撞上，
再决定要不要，这个顺序对密集封装很重要，合并成一个动作等于逼人先加再回头删。

变体取该类型的默认值（SPI 三线、UART 收发、ADC 一路…）。侧栏不猜"要几路 ADC"
或"要不要硬件流控"——那些在接口需求行里一眼可改，塞进侧栏反而挡住了
"快速勾几个外设"这件事本身。

注意与检视面板那个「固定 / 取消固定」的区别：那个只改某一路需求锁不锁实例，
需求本身留着；侧栏的 +/✓ 管的是这一路要不要。两者共用同一个指示状态，所以
加入时会先认领已有的同类型未锁定需求——否则用检视面板取消固定后，侧栏会显示成
"未加入"，再点一下就多出重复的一路。

`npm test` 会遍历两个厂商的全部可勾选条目，校验目录里的实例名正是求解器认得的
那个，并真的排一遍——两边对"实例叫什么"的理解一旦不一致，勾选后会得到一路
永远无解的需求，而界面上什么都不会提示。

## 新手教程与个人中心

顶栏右上角两个入口。

**新手教程**：分步高亮，按真实工作流走一遍——选器件 → 描述接口需求 → 求解 →
读封装图 → 逐脚核对 → 导出。首次打开自动弹一次，之后随时可以重看。步骤定义在
`src/lib/tour.js`，与渲染分开。

改 UI 时最容易坏的是**高亮目标的选择器失配**：换掉一个 class，教程不会报错，
只会指着空白讲"点这里"。所以 `tests/render.mjs` 会拿真实渲染的 HTML 逐条校验每个
`target` 都存在。组件里另有运行时兜底（找不到就跳过该步），但那是降级不是正确。

**个人中心**：这个工具没有后端也没有账号，所以它不是"用户资料"，而是把散落各处
的本地状态收到一处——主题、启动器件、新工程的求解器开关、最近用过的器件、
以及各项占了多少浏览器存储。

清除是**分类**的，不给一个笼统的"清空全部"：工程存档和 AI 配置里的 API Key
性质完全不同，混在一个按钮里会让人不敢点、或者点了才发现删多了。

`src/lib/preferences.js` 的 `STORAGE_KEYS` 是本工具写入 localStorage 的**全部**
键的唯一登记处。漏登记一个键，它就永远删不掉、用量统计也是错的，而且不会报错——
所以 `npm test` 会从源码反查所有 `localStorage.*Item()` 的键名，逐个核对是否登记。
**新增任何持久化状态都要加进那张表。**

## 按需选择任意型号

界面顶栏的「选择其他型号…」可以搜索本机厂商库里的全部器件，选中即用，不需要
事先导入。

```sh
npm run mcu:catalog   # 扫描本机 CubeMX / SysConfig，生成器件索引
npm run dev           # 或直接点桌面快捷方式
```

**为什么要分成索引 + 按需转换**：CubeMX 库里约 2300 个 STM32 型号，SysConfig 里
约 1100 个「型号 × 封装」组合，单颗器件的引脚数据平均 60 KB，全打包约 200 MB，
仓库和首屏都受不了。所以：

| | 内容 | 体积 |
| --- | --- | --- |
| `src/data/deviceIndex.json` | 型号、系列、封装、脚数、内核 + 外设摘要（见下节） | 约 1.2 MB，gzip 86 KB，独立 chunk，点开搜索框才加载 |
| `/api/mcu` | 选中时现场转换引脚数据 | 单颗 20–110 KB，转换约 200–400 ms |
| `.cache/mcus/` | 转换结果缓存，不进版本库 | 第二次选中直接命中 |

**限制要讲清楚**：`/api/mcu` 由 `tools/vite-mcu-server.mjs` 提供，只存在于本机的
开发/预览服务器上，读的是本机装的厂商库。把 `dist/` 静态部署到别的机器时这个
接口不存在，界面只能用已固化进 `src/data/mcus/` 的那几颗——这时选择器会明确报
「当前部署没有器件转换接口」，而不是一直转圈。

**按需 ≠ 固化**。按需取回的器件只在本次会话里可用，不进版本库、不受 `npm test`
的不变量覆盖，界面会标注「未固化进目录」。某颗片子要长期用（进静态构建、被测试
覆盖、补 5V 白名单），走 CLI 固化：

```sh
npm run mcu:import -- --part STM32F407VGT6     # 或 mcu:import:ti
npm run mcu:index
```

## 按外设筛选型号

「选择其他型号…」里有两个输入框：上面是型号 / 系列 / 封装文本，下面是**所需外设**。
两者和一行叠加筛选（厂商、封装形态、脚数范围）同时生效。

### 刷新索引

```sh
npm run mcu:catalog
```

扫描本机的 CubeMX（`CUBEMX_DB` 或常见安装路径，与 `mcu:import` 同一套查找逻辑）和
SysConfig（`SYSCONFIG_HOME` 或 `C:/ti/sysconfig_*` 里版本最高的），写出
`src/data/deviceIndex.json`。不会下载任何厂商库：哪一家没找到，就在输出和索引的
`gaps` 字段里写明，界面的说明文字也会列出来。索引里记录了每家的库版本
（`sources[].release`）和生成时间（`peripherals.generatedAt`）；换了 CubeMX /
SysConfig 版本后重跑一次。

旧版索引（没有 `peripherals` 字段）仍能按型号搜索，外设框会提示重新生成。

### 外设条件怎么写

| 写法 | 含义 |
| --- | --- |
| `SDMMC` | 类型，严格按厂商名称：至少一个 SDMMC 实例（不含 SDIO） |
| `SDMMC FMC` | 多个条件，默认**全部满足**，可切换为「任意一个」 |
| `SDMMC1` | 指定实例 |
| `SDMMC ≥ 2`、`SDMMC×2` | 至少两个实例；标签上的 −/+ 也能调 |
| `SD卡`、`外部存储`、`CAN总线` | 分组：跨名称的同类外设（SDMMC 或 SDIO；FMC 或 FSMC），结果里保留实际名称 |
| `USB HS`、`内置PHY`、`USB主机`、`Chrom-ART`、`MIPI CSI-2` | 能力目录里的条目，点「按能力浏览…」可以看全表 |
| `SD 4位`、`SDRAM 32位`、`NAND`、`8080`、`RMII`、`RGB565` | 用途：检查本封装是否引出了这种接法需要的全部信号 |

不区分大小写，支持中文。拼错的名字不会被悄悄当成别的，界面会给出候选（`SDMCC` →
SDMMC）。

### 规格筛选与详情

左侧可以叠加 `Flash ≥ KB`、`RAM ≥ KB` 和 `主频 ≥ MHz` 下限；选中型号后，详情还会
显示 CubeMX 数据库记录的供电范围。规格按对应的 CubeMX RefName XML 生成；一个文件
包含多个容量变体时，会按 RefName 展开顺序逐个映射（例如 H743 的 G/I 容量档），不把
第一个容量套给整组型号。RAM 阈值只使用 CubeMX 的 `Ram` 字段，单列的 `CCMRam` 在
详情中单独显示，不并入阈值。

当前 TI SysConfig 1.28.0 器件目录没有 Flash、RAM 和 MCU 主频数值字段，因此 TI 在这些
规格筛选下会作为“规格未知”排除，并在结果说明中计数；这不表示 TI 型号不具备这些资源。
STM32 的个别记录也可能缺主频或电压字段。详情里的“未收录”表示本机数据源没有该值，
不是 0。规格值可从详情中的工具版本和 RefName 文件名追溯。

### 结果怎么读

每条结果是厂商库里的一条（型号, 封装）记录。型号里的 `x` 是厂商库的等级占位符，
原样保留，不是完整订货型号。匹配到的外设写成 `SDMMC ×2：SDMMC1(14) SDMMC2(10)`，
括号里是**该封装引出的信号数**；CORDIC、HASH、RNG 这类内部功能本来就没有外部
引脚，显示 0 是正常的。点击条目即「用于引脚规划」，走与下拉切换相同的加载流程。

结论分四层，越往下越强，界面上分开表述：

1. **记录包含该外设**：类型、实例、分组、能力条件。
2. **封装引出了哪些信号**：括号里的信号数，悬停能力条目可看依据。
3. **具体用途信号齐全**：用途条件。有 FMC 不等于能接 SDRAM（H743 的 LQFP100 就
   没有 SDCLK / BA0 / A0–A15）；有 SDMMC 不等于支持 8 位总线。缺信号的型号可以
   单独查看缺哪些。
4. **多个接口能同时无冲突分配**：结果行的「检查组合」把条件交给引脚求解器，在完整
   引脚表上一起求解（默认保留调试脚和晶振脚，可叠加当前工程的接口需求）。只有穷举
   完毕才说「确认无法」；没跑完的如实说「未找到」。

每颗器件对每个条件只有三种结论：**确定满足、确定不满足、数据未知**。数据未知的
型号不会混进「不满足」，结果说明里会单独计数，并能单独列出来看是哪个条件未知。

### 覆盖范围与已知缺口

- **STM32**：外设来自 CubeMX `db/mcu/<RefName>.xml` 的 `<IP>` 记录（按封装分文件），
  信号来自同一文件的 `<Pin><Signal>`。FatFS、FreeRTOS、USB_DEVICE 这类软件组件和
  RCC、GPIO、NVIC 等系统模块不算外设。
- **TI**：来自 SysConfig 器件族数据的外设与接口类型；族数据按型号列了外设时按型号
  区分（TM4C1231 没有 USB）。外设只在本封装至少引出一个脚时收录。用途检查（SD 4 位、
  SDRAM…）目前只覆盖 STM32，TI 器件对这类条件是「数据未知」。
- **能力目录**（`src/lib/capabilities.js`）按厂商分别映射，只收数据里核实过的名称：
  - USB 拆成四项：FS 控制器、HS 控制器、OTG、主机模式，外加**内置 HS PHY**。
    片上 PHY 的依据是 CubeMX 里 OTG_HS 时钟使能带 `USBPHYC`（U59x/U5Ax/U5Fx/U5Gx、
    H7R/S）或封装有 `REXTPHYHS` 脚（F723/F733）；有 HS 控制器但没有这两种痕迹的
    记为数据未知。主机模式：OTG、DRD 可以，`usb1_*` 版本的 USB 仅设备，H5/U0 的 USB
    数据里看不出来。
  - 市场名称只收官方与 IP 名并列写出的：Chrom-ART = DMA2D，NeoChrom = GPU2D。
  - **未收录**：MIPI CSI-2、ISP、H.264 编码器、Neural-ART NPU 在 ST 侧只有
    STM32N6 有，而本机 CubeMX 库没有 N6 系列；ISP、H.264 在 TI 数据里也没有可核实
    的对应。这些条件对相应厂商的器件一律是「数据未知」，不是「不支持」。
  - TI 的 `CAN` 接口类型没区分经典 CAN 与 CAN FD；TI 的 USB 没写速率与角色，
    USB FS/HS/OTG/主机对 TI 均为数据未知。

相关代码：索引生成 `tools/build-device-index.mjs`，筛选 `src/lib/deviceSearch.js`
（与界面无关，可单测），用途 `src/lib/peripheralUsage.js`，能力 `src/lib/capabilities.js`，
组合可行性 `src/lib/feasibility.js`。对应测试 `tests/deviceSearch.mjs`、
`usageSearch.mjs`、`tiPeripherals.mjs`、`capabilities.mjs`、`feasibility.mjs`、
`searchSpec.mjs`，都用仓库里提交的索引，对照本机厂商库核对过的已知型号。

## 扩展边界

### 加一颗新片子

1. 把符合 `src/data/mcu.schema.json` 的数据文件（`.json` 或导出默认对象的 `.js`）
   丢进 `src/data/mcus/`；**STM32 不用手写**，见下面的「从 CubeMX 库导入」；
2. 跑一次 `npm run mcu:index`——器件清单是从这个目录扫出来的，元数据取自数据文件
   自身的 `id` / `vendor` / `uiProfile` / `status` 等字段，不用再去别处登记；
3. 在 `tests/fixtures/<id>.json` 写下几条对着 datasheet 人工核对过的锚点。

### 从 CubeMX 库导入 STM32

```sh
npm run mcu:import -- --part STM32F103C8T6 --db D:/CubeMX/db
npm run mcu:index
```

`--db` 省略时会依次尝试常见安装路径，也认环境变量 `CUBEMX_DB`。同一份数据 ST
也发布在 [STM32_open_pin_data](https://github.com/STMicroelectronics/STM32_open_pin_data)
（BSD-3-Clause，约 11.5 MB），目录层级一致，`--db` 指向仓库里同名的那一层即可。

数据来自**两个**文件：`mcu/<RefName>.xml` 给脚号、脚名和信号清单，
`mcu/IP/GPIO-<ver>_Modes.xml` 给 AF 编号或重映射组。后者的文件名不用猜，前者里
的 `<IP Name="GPIO" Version="…"/>` 写着。脚本处理掉了几处不能想当然的地方：

- **`REMAP<n>` 的 n 不是可靠的逻辑序号。** ST 后来把 TIM3 改成了寄存器位值
  （`REMAP0/2/3`，中间空一档），却没动同样是 `00/10/11` 编码的 CAN。脚本一律
  重新编号成连续的 `0..n-1`，寄存器真值由 `remapMacros` 里的 HAL 宏承载——所以
  新旧两版数据库产出相同结果。
- **GPIO IP 文件按 die 分，不按封装。** F103x8 里 TIM3 完全重映射指向 PC6-PC9，
  LQFP48 没这几个脚，整档要丢弃后再重新编号。
- **库只登记「会挪窝」的 (脚, 档) 组合。** `USART1_CK/CTS/RTS`、`I2C1_SMBA` 在
  重映射档下不动，库里就只写默认档一条。照抄会让求解器认为选了那一档就没有这些
  信号，把「带硬件流控的 USART1 + 重映射」判成无解。脚本按**整个 die** 判断某档
  是否登记过该信号来补全——只看本封装会把「挪到了封装外的脚」误判成「没挪窝」。
- **F1 的 GPIO IP 只列可重映射的外设。** SPI2 / I2C2 这类固定脚外设不在里面，
  但它们是实打实的复用功能，要补进组 0。

**唯一导不出来的是 5V 耐压**：CubeMX 库里没有 FT / TTa / TC 信息，`ioStructure`
和 `electrical.fiveVoltTolerantIoStructures` 要查 datasheet 手工补。补之前界面会
隐藏 5V 开关（安全降级，不会把所有脚误判成不耐压）；补好之后重跑导入会自动沿用，
不会被覆盖。

导入完会自动跑一遍冒烟求解（与 `npm test` 同一套判据）：某个外设解析出了实例却
一路都排不出来，就说明厂商的信号命名与 `allocator.js` 的变体表对不上，需要去
`dialect.js` 补别名。以太网就是这样发现并补上的——不加这道自检，导入的 H7 器件
会界面照常打开、每一路 ETH 需求却都无解。自检会把"命名没对上"和"脚不够用"分开
报：小封装上唯一的落点常常正好是 SWD 脚，被默认保护排除掉，那是求解器判断正确
而不是数据有错。

### 从 SysConfig 导入 TI

```sh
npm run mcu:import:ti -- --part MSPM0G3519            # 列出可选封装
npm run mcu:import:ti -- --part MSPM0G3519 --package "LQFP-64(PM)"
npm run mcu:index
```

**不是 CCS 里的器件文件**。CCS 的 `ccs_base/common/targetdb/devices/<型号>.xml`
是调试器的目标描述（内存映射、CS_DAP 路由、GEL 脚本），没有引脚复用——pinmux
一直是 SysConfig 的活。数据在 `<sysconfig>/dist/deviceData/`（`--sysconfig` 省略
时自动找 `C:/ti/sysconfig_*` 里版本最高的一个，也认 `SYSCONFIG_HOME`）：

- `gpns.json` —— 型号 → 器件族 + 封装列表（一颗 MSPM0G3519 有 9 种封装）
- `<族>/<族>.json` —— 引脚、封装、mux 表

整个转换的支点是 `muxes[].muxSetting[].mode`：

| mode | 含义 | 去向 |
| --- | --- | --- |
| 0 | 模拟/特殊：ADC 通道、比较器输入、LFXIN/HFXIN/ROSC、VREF | `additionalFunctions` |
| 1 | GPIO 本身 | 丢弃 |
| ≥2 | 数字复用功能 | `functions`，`af` = mode |

这解释了既有手工 MSPM0 数据里 `af` 为什么从 2 起编号。

SysConfig 的写法与 datasheet 不一致（`TIMA0.CCP0` → `TIMA0_C0`、`CANFD0.CANTX`
→ `CAN0_TX`、`ADC0.13` → `A0_13`、`SPI0.SCLK` → `SPI0_SCK`…），**全部在导入器里
翻译成 datasheet 写法**，不放 `dialect.js`——ADC 通道、`SWDIO`、`LFXIN` 这些是
`additionalFunctions` 和保护标记，方言层根本碰不到它们，映射拆两处必然走样。

两处 SysConfig 独有的好东西：`attributes.io_wakeup` 给出唤醒能力（对应 datasheet
的 `WAKE`，核对过与手工数据完全一致），`attributes.io_type` 给出真实焊盘类型
（SD/SDW/HD/HS/OD），比手工数据一律 `STD` 精细。但**不据此声明 5V 白名单**——
MSPM0 耐 5V 的确实是开漏脚，可"OD 就等于耐 5V"是推断而非这份数据的结论。

已知缺口：datasheet 里的 `BSLSDA` / `BSLSCL` / `BSLTX` / `BSLRX`（bootloader 默认
脚）SysConfig 里没有，导入的数据会少这 4 条标记。它们不参与分配，只是信息。

`npm test` 会对目录里的**每一颗**片子跑同一套不变量（脚号连续、几何自洽、
方言解析出的是规范信号名、每种外设都排得出一路），所以第 3 步之外不需要新写测试。
只有当这颗片子用了新的信号命名或新的封装形态时，才需要动下面这些边界。

| 差异点 | 声明字段 | 实现 |
| --- | --- | --- |
| 数字信号命名 | `signalDialect` | `src/lib/dialect.js` |
| 模拟通道命名 | `analogConvention` | `src/lib/analog.js` |
| 封装形态 | `packageGeometry.shape` | `src/lib/package.js` |
| 侧边栏形态 | `uiProfile` | `src/lib/peripherals.js` |
| 5V 耐压 | `electrical.fiveVoltTolerantIoStructures` | `src/lib/allocator.js` |
| 复用功能的选择粒度 | `afGrouping` | `src/lib/allocator.js` |

**声明缺失时一律降级，不臆造结论**：没有耐压白名单就隐藏 5V 开关（而不是把所有脚
判成不耐压），`uiProfile` 认不出来就用 `generic`（完全从引脚数据现推，而不是套上
CubeMX 那些别家片子没有的静态条目）。

### 各层职责

- `src/lib/mcuCatalog.js` 是 MCU 目录边界。引脚表**懒加载**——H743 一颗就 5000 多行，
  静态 import 意味着首屏要下载目录里所有片子的引脚表。`record.data` 只对已加载的片子
  有效，调用方要先 `await ensureMcuLoaded(id)`。
- `src/lib/dialect.js` 把厂商信号名翻译成规范名（TI 的 `SPI0_PICO` → `MOSI`、
  `TIMG0_C0` → `CH1`、`CAN0` → 归入 `FDCAN` 类；F1 的 `CAN1` 同样归入 `FDCAN`）。
  求解器和变体表只认规范名，所以同一份接线变体对所有厂商通用。翻译**可以一对多**：
  datasheet 把以太网的模式写进信号名（`ETH_MII_TXD0` / `ETH_RMII_TXD0`），CubeMX
  库却用中立写法（`ETH_TXD0`）——因为它在外设层选模式。TXD0/TXD1/TX_EN/RXD0/RXD1
  这几根线两种模式共用同一个脚，一个厂商名要同时落到两个规范名上，所以
  `normalizeAll()` 返回数组。这不会让一个脚被算作两路：一次求解只会选中 rmii 或
  mii 其中一套信号，组合枚举里的 `usedPins` 又保证同一个脚不会在一组内被用两次。
- `afGrouping` 决定求解器能不能逐个信号独立挑脚。默认 `"pin"`：每个脚自带 AF
  选择器（H7 的 `GPIOx_AFRL/AFRH`、TI 的 PINCM），给 TX 挑了 PA9 不限制 RX。
  STM32F1 是 `"instance"`：换脚靠 `AFIO_MAPR` 的重映射位，而那是按外设整体
  切换的——USART1 只有 `PA9/PA10` 和 `PB6/PB7` 两种合法接法，`PA9` 配 `PB7`
  在硬件上根本不存在。这类器件的 `af` 字段承载的是**重映射组号**而不是 AF
  编号，组合枚举时会就地剪掉混组的分支，导出层也据此改写措辞和 HAL 宏。
- `src/lib/package.js` 是"脚号 → 落在哪条边 / 归一化坐标 / 渲染顺序"的唯一换算入口，
  求解器打分和封装图共用。支持四边（LQFP/QFN…）、两边（SOIC/TSSOP…）和栅格
  （BGA/WLCSP，球位取 `pin.location`）三种布局。
- `src/lib/analog.js` 按厂商约定解析模拟通道；器件数据用 `analogConvention` 字段选择
  （`st` = `ADC123_INP10` 逐位展开成实例集合，`ti` = `A0_8`）。
- `src/lib/project.js` 是工程文件边界，`src/lib/diff.js` 是方案对比引擎。
- `src/data/module.schema.json` 定义外设模块的结构化资源需求。
- `src/lib/ai/requirements.js` 定义 AI 助手的需求信封和受控工具名。AI 只负责解析需求，最终引脚仍由本地求解器校验。
- `src/data/moduleCatalog.js` 是常用模块库；同一个模块可以通过 variant 切换 SPI / I²C、RMII / MII 等接口方案。
- `src/lib/ai/assistant.js` 提供离线可复现的自然语言 fallback：识别模块、接口数量、实例（如 `I2C4` / `USART3`）、方位和 SWD/晶振保护约束。

### AI 接入边界

当前页面默认使用本地规则解析，不需要 API Key，也不会上传工程描述。打开助手的“配置云端 AI（可选）”后，可以填写兼容 Chat Completions 的接口地址、模型名和 API Key；只有开启“优先使用云端 AI”后才会发起请求。远程模型必须输出同一份 `createRequirementsEnvelope()` 结构，结果会先经过 `validateRequirementsEnvelope()`，再交给本地引脚求解器；模型不能直接写入最终 pin assignment。云端请求失败时会自动回退离线解析。

## 可分配的外设

不只是 SPI/I2C/UART——真正吃掉 LQFP100 那 82 个 GPIO 的是 ETH、SDMMC、FMC 这类大户，
它们必须能参与求解，否则冲突根本暴露不出来。

| 类型 | 接线变体 |
| --- | --- |
| SPI | 全双工 3 线 / 全双工 + 硬件 NSS / 单向发送 2 线 |
| I²C | SCL + SDA |
| UART / USART | TX+RX / TX+RX+硬件流控 / 仅 TX |
| FDCAN | TX + RX |
| SDMMC | 1-bit / 4-bit / 8-bit（eMMC） |
| QUADSPI | 单 Bank 四线 / 双 Bank 四线 |
| USB OTG | 内置 PHY（DM/DP）/ OTG（+ID）/ 外部 ULPI PHY |
| Ethernet | RMII + MDIO / MII + MDIO |
| 定时器 PWM | 1-4 路 PWM / 三相互补 + 刹车 |
| ADC | 1 / 2 / 4 / 8 路单端输入 |
| DAC | 1 / 2 路输出 |

实例列表从引脚数据里现推，不写死——换一份 MCU JSON 就自动跟着变。

模拟通道的候选来自 `additionalFunctions` 而非 AF 复用表，且 ST 的实例前缀是**逐位展开**的：
`ADC123_INP10` 表示这条通道同时挂在 ADC1/ADC2/ADC3 上，不是一个叫 `ADC123` 的实例。
LQFP100 上按实例算 ADC1 有 14 个脚、ADC2 有 12 个、ADC3 只有 4 个。只收单端正输入（INP）——
INN 是差分负端，必须与 INP 配对使用，不能独立当一路模拟输入。

## 需求模型

需求是**一行一路接口**，每行独立设置三件事：

- **接线变体**——决定这一路占哪几个信号。同类型不同变体可以共存：
  UART1 接蓝牙要硬件流控、UART2 是调试口只要 TX/RX，两者互不影响。
- **外设实例**——留"自动选择"交给求解器，或硬指定 `SPI2`（板子已经画死了）。
- **方位偏好**——指定这一路尽量从封装的哪条边出线。SD 卡在板子右边、
  屏幕在左边，这个信息只有工程师知道，得能说出来。
- **5V 电平**——这一路接 5V 传感器或收发器，只能落在耐 5V 的脚上。

方位偏好是**软约束**：先按引脚是否落在目标边给固定罚分，再叠加几何距离。
所以目标边排满时会退到相邻的角，而不是跳到对面，也不会因此判成无解。

5V 是**硬约束**：落到不耐压的脚上就是烧片，不能降级成罚分。判定依据是器件数据里
显式枚举的 `electrical.fiveVoltTolerantIoStructures` 白名单（H743 是 `FT*` 耐 5V、
`TT*` 只到 3.3V，LQFP100 上正好 11 个 GPIO 不耐压）。器件数据分不出耐压等级时
（MSPM0 全是 `STD`）界面不给这个开关——没有依据就不该让人以为约束生效了。

## 求解器行为

- 求解跑在 Web Worker（`src/lib/solver.worker.js`）里，界面不会被搜索阻塞。
- 组合枚举按**引脚代价 best-first**。不这么做的话每个实例保留的 `COMBO_LIMIT`
  个名额会被引脚编号靠前的分支灌满——`TIM1_CH1N` 会锁死在 PA7（占用 ADC 通道），
  永远轮不到紧邻 CH1 的 PE8。信号越多（RMII 9 个、三相互补 7 个）偏差越大。
- 布线代价用归一化包围盒的半周长表示，比"各脚到第一个脚的距离和"更贴近
  实际布线难度，对 ETH、SDMMC 这种大组尤其明显。
- 无解时区分两种结论：`proven: true` 表示**已穷举确认无解**；`exhausted`/`truncated`
  为真则表示搜索没跑完，界面只报"无法判定"，不会谎称无解。
- 多套方案保证使用**互不相同的外设实例组合**（先按分数排序，再按实例差异筛选），
  方案 A 始终是分数最优解，A→E 分数递增。
- 锁定组认领不到对应需求行时自动释放，并通过 `droppedLocks` 回报。
- 组合截断（`truncated`）**逐实例记账**。指定了 `SPI2` 或 `ADC3` 时，`SPI1` / `ADC1`
  的截断与这一路无关；混为一谈会把本可证明的无解降级成"无法判定"。

### 模拟通道为什么不预先枚举组合

数字外设的组合受"每个信号只有几个候选脚"约束，穷举得起。模拟通道彼此**完全可互换**，
一个 14 脚的 ADC 取 8 路就是 C(14,8) = 3003 种，而这些组合之间只是换了几个等价的脚，
对方案多样性毫无贡献。预枚举必然要截断，一截断就再也证明不了无解。

具体地：RMII 恰好吃掉 ADC1 那 14 个脚里的 6 个，剩下 8 个脚只有唯一一种 8 通道取法，
截断后的候选表几乎不可能命中——于是明明有解却报"无法判定"。

所以模拟组改在**搜索时按"当前还空着哪些脚"现挑**：取代价最低的 k 个可用脚。这对可行性
是精确的（只要还剩 k 个空脚就一定挑得出来），代价是 O(池大小) 而不是 O(C(n,k))。方位
偏好并进单脚代价一起排序，所以"ADC 尽量靠左"依然生效。

模拟组之间还要按**余量**（通道池大小 − 所需通道数）升序排。DAC1 只有 PA4/PA5 两个脚，
而它们同时是 `ADC12_INP18/INP19`——让余量大的 ADC 先挑就会把 DAC 饿死。

### 什么时候会自动重跑

- **改需求行**（增删、换变体、换实例、换方位）→ 不自动重跑。用户往往要连改几行，
  每改一次都跑一遍既慢又干扰。改完点"生成方案"，期间按钮和封装图标记为已过期。
- **对已有结果的单击微调**（锁定已使用引脚、锁定/解锁单组或当前方案全部引脚）→ 立即重跑，即时反馈。

## 导出

| 格式 | 用途 |
| --- | --- |
| 方案 CSV | 当前生成方案的信号、物理脚、实例和 AF |
| 全部引脚定义 CSV | 当前 MCU 每一颗引脚的完整定义、复用功能、电气属性和保护信息 |
| CubeMX `.ioc` 片段 | 合并进已有 `.ioc` 后用 CubeMX 打开，接着配时钟树 / DMA / NVIC |
| HAL 引脚头文件 | `#define SPI1_SCK_Pin` / `_GPIO_Port` / `_AF`，直接进工程 |
| Markdown | 贴进硬件评审文档 |
| EDA 网络标签 (JSON) | **推荐**：装上 `tools/lceda-extension`，在 EDA 里一步打完所有网络标签 |
| 嘉立创 扇出网络标签 (CSV) | 备用：不装扩展时，填 EDA 的扇出表格再导回去 |

### 把方案打进嘉立创EDA

**推荐走扩展**（`tools/lceda-extension`，装一次即可）：

1. 规划器「导出 → EDA 网络标签 (JSON)」
2. EDA 里选中 MCU → 菜单 **引脚规划器 → 应用引脚方案...** → 选那个 JSON

就这两步，没有 CSV。扩展会先核对符号和方案是不是同一颗片子，核对不过拒绝写入；
通过了直接打完所有标签，不满意用「撤销上次应用」一次清干净。

CSV 那条路之所以存在，是因为规划器在浏览器里**拿不到符号上的引脚名**（库里写作
`VSS_1`、`PC13-TAMPER-RTC`，和数据手册对不上），只能让 EDA 先导出一份模板。而扩展
跑在 EDA 里，`getState_PinName()` 直接就能读到——那份模板从一开始就是多余的。

下面是不装扩展时的备用路径。

### 嘉立创 扇出网络标签（备用路径）

嘉立创EDA 专业版有个「扇出网络标签/非连接标识」：选中器件 → 右键 → 扇出网络标签，
弹出的表格每个引脚一行，可以导出、改完再导入，导入后标签和导线一次生成。

这一项和其它导出不一样，它**不生成文件，而是往 EDA 导出的表格里填一列**：

1. EDA 里选中 MCU → 右键 → 扇出网络标签/非连接标识 → 导出
2. 规划器「导出 → 嘉立创 扇出网络标签 (CSV)」→ 选刚导出的那份
3. 拿回填好的文件，在同一个对话框里导入

为什么是填表而不是造表：表格里的 `pinName` 是**符号自己的**写法（`VSS_1`、
`PC13-TAMPER-RTC`），从零造一份就得赌 EDA 认哪种写法。在它给的模板上只改
`netname`，引脚由 EDA 自己认。对应关系走 `pinNumber`，不比名字。

填的规则：

- 方案分配到的脚 → 方案的网络名（和 netlabels JSON 同源，两边不会分叉）
- 电源脚 → `VSS*`/`VSSA` 填 `GND`，`VDD*`/`VDDA`/`VBAT` 填 `+3V3`；
  `VREF+` 这类没有通用叫法的留空并点名
- 其余（未用 GPIO、`NRST`、`BOOT0`）→ **清空** `netname`。
  不清不行：模板里 `netname` 预填的就是 `pinName`，原样导回去会凭空生出
  几十个叫 `PB9` 的网络，每个还带一根导线
- `noConnect` / `wireOrBusLength` 等列原样不动

写回的文件格式照抄 EDA 自己的导出：**UTF-16 LE + BOM、制表符分隔、LF 行尾**。
它后缀叫 `.csv` 但不是逗号分隔——这就是拿 WPS 另存成 csv 会报"导入CSV文件格式
异常"的原因。`tests/fanout.mjs` 拿真实导出的文件把这套约定钉住了。

选错器件是这里最危险的输入：另一颗芯片的脚号照样落在方案范围内，光看脚号发现
不了。所以填之前会比一遍引脚名，整片对不上直接拒绝；零星几个不同（库里常态）
放行但点名。

`.ioc` 只写引脚归属相关的键（`Signal` / `GPIO_Label` / `Locked` 加 `Mcu.PinN` 索引），
不含时钟树和外设参数——所以是**片段**，用来合并而不是替代已有工程。

头文件里的 AF 宏按 `GPIO_AF<n>_<外设>` 拼，与 `stm32h7xx_hal_gpio_ex.h` 一致；
OTG 等少数外设的实际宏名带实例序号，所以每行都附上原始 AF 编号作为核对依据。

模拟通道没有 AF 编号：CSV / Markdown 的 AF 列写"模拟"，头文件只出 `_Pin` / `_GPIO_Port`
并附 `GPIO_MODE_ANALOG` 注释，`.ioc` 照写 `Signal=ADC1_INP16`（CubeMX 对模拟脚正是这么记的）。

## 工程文件与方案对比

工作状态自动存进浏览器，刷新不丢。另可另存为 `.pinplan.json`：

```json
{
  "format": "mcu-pin-planner.project",
  "version": 1,
  "mcu": { "id": "...", "partNumber": "STM32H743VIT6", "source": { "document": "DS12110", "revision": "11" } },
  "options": { "protectDebug": true, "protectOscillator": true },
  "excludedPins": [12, 44],
  "requests": [{ "id": "r1", "type": "SPI", "variant": "full3", "instance": null, "side": null, "fiveVolt": true }],
  "lockedGroups": [{ "type": "SPI", "instance": "SPI1", "assignments": [{ "signal": "SCK", "pin": 30, "af": 5 }] }],
  "plan": { "activeIndex": 0, "groups": [] },
  "savedAt": "2026-08-08T00:00:00.000Z"
}
```

**引脚只存物理脚号**（附脚名供校验）。内存里 `assignment.pin` 带着整条 pin 记录（几十个
AF 条目），直接 JSON 化会让文件膨胀十几倍，且 diff 全是与设计无关的噪声。载入时按脚号从
`mcu.pins` 反查还原。

键序固定、数组排序、`savedAt` 放最后一个键——同一份工程无论怎么操作出来，序列化结果都
逐字节相同，所以能跟着原理图进 git 评审，每次保存只有一行时间戳噪声。

载入**容错而非崩溃**：版本或 MCU 对不上直接拒绝；型号/数据源修订不同只警告；脚号越界、
脚名与当前数据不符、类型或变体未知的条目逐条丢弃并回报 warning。

功能名和 AF 编号还要在那个脚上**真实存在**才收——这些值会原样进 `.ioc` 和 HAL 头文件，
不校验就等于把文件里的任意字符串直接写进用户的工程。

方案对比共用一套 `diffPlans`：既能比同一次求解的方案 A/B，也能与载入的基线工程比。
按 `类型:实例` 配对分组、组内按信号配对。**换了外设实例（SPI1 → SPI2）表现为一组移除 +
一组新增**，而不是被抹平成"同一组换了脚"——换实例是真实的设计变更，评审必须看得见。

## 数据来源

STM32H743VIT6 —— STMicroelectronics `DS12110 Rev 11`（`status: verified`）：

- Table 9: LQFP100 物理引脚定义
- Table 10: AF0-AF15 复用功能

MSPM0G3519 —— Texas Instruments `SLASFA2B Rev B`（`status: verified`）：

- p.18-35: PM(64) 引脚复用表

STM32F103C8T6 —— STM32CubeMX 器件库 `DB.6.0.111` 机器导入（**`status: generated`**）：

- `mcu/STM32F103C(8-B)Tx.xml`: 封装、脚号、脚名、信号清单
- `mcu/IP/GPIO-STM32F103x8_gpio_v1_0_Modes.xml`: 重映射组与 HAL 宏
- 5V 耐压部分手工取自 `DS5319 Table 5`（库里没有这类信息）

⚠ 引脚和重映射数据来自 ST 官方库，并与一份独立手工整理的数据交叉比对过（37 个
GPIO 里 35 个逐条一致，2 处差异经查库确认是手工版漏了），但**电气部分仍未核实**：
`ioStructure` 和 5V 白名单是手填的，其中 PB5 究竟是 FT 还是 TC 尚未确认。细节见
`tests/fixtures/st-stm32f103c8t6-lqfp48.json` 的 `note`。核实后可把 `status`
改成 `verified`。

## 运行

### 桌面版（推荐）

到 [Releases](https://github.com/Polarislos/MCU-Pin-allocation/releases) 下载
`MCU-Pin-Planner-Setup-<版本>.exe` 安装即可，不需要装 Node.js。

- 按需器件仍然读本机装的 CubeMX / SysConfig 库（查找规则同下文"从 CubeMX 库导入"，
  也认 `CUBEMX_DB` / `SYSCONFIG_HOME` 环境变量）。厂商库有自己的许可，不随安装包分发。
- 转换缓存在 `%APPDATA%\MCU Pin Planner\mcu-cache\`。
- **更新**：启动后会检查 GitHub 上的最新 Release，有新版本时弹窗询问；
  个人中心 → 软件更新 也能手动检查、看进度、重启安装。不点"立即重启"的话，
  下次退出应用时自动安装。
- 安装包没有代码签名，首次运行 Windows SmartScreen 会提示"未知发布者"，点"仍要运行"。

桌面版的结构：`electron/main.mjs` 在 127.0.0.1 的随机端口起一个 http 服务
（`dist/` 静态文件 + `tools/vite-mcu-server.mjs` 的同一个 `/api/mcu` 中间件），窗口加载它；
`electron/preload.cjs` 只向页面暴露 `window.appUpdater`。

本地调试与打包：

```powershell
npm.cmd run app:start   # 构建页面后用 Electron 打开（不检查更新）
npm.cmd run app:dist    # 生成 release\MCU-Pin-Planner-Setup-<版本>.exe，不上传
```

### 发布新版本

```powershell
npm.cmd version patch          # 或 minor / major：改 package.json 并打 v<版本> 标签
git push origin main --follow-tags
```

推送标签后 `.github/workflows/release.yml` 在 Windows 上跑 `npm test`、打包，
把安装包、`.blockmap` 和 `latest.yml` 传到同名 Release。已安装的客户端就是读这个
`latest.yml` 判断有没有新版本的，所以 Release 不要设成草稿，文件也不要改名。

### 浏览器版

日常使用点桌面上的 **MCU 引脚规划器** 快捷方式即可：它会起本地服务器（已经在跑就直接复用），
再用默认浏览器打开 <http://127.0.0.1:4173/>。服务器窗口最小化在任务栏，关掉它就停。

快捷方式指向 `scripts/start-pin-planner.ps1`。重新生成快捷方式（换了机器或移动了工程目录）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1
```

> 页面用了 ES 模块和 `type=module` 的 Web Worker，`file://` 下会被浏览器的 CORS 规则挡住，
> 所以必须走本地 http，不能直接双击 `index.html`。
>
> `scripts/*.ps1` 必须存成**带 BOM 的 UTF-8**。快捷方式调的是 `powershell.exe` (5.1)，
> 它把无 BOM 的文件按 ANSI 代码页读，中文会变成乱码字节并直接把语法拆坏。

手动启动：

```powershell
npm.cmd install
npm.cmd run dev
```

构建与校验：

```powershell
npm.cmd test
npm.cmd run build
```

`npm test` 跑四组：

- `tests/verify.mjs`——数据完整性、求解正确性、无解判定、多样性、锁定溢出、延迟；
  5V 白名单与真实数据自洽（正好 11 个不耐压 GPIO）、候选缓存键隔离、
  两家厂商的模拟命名解析、ADC/DAC 抢脚与 RMII 冲突场景
- `tests/fanout.mjs`——扇出网络标签表格：拿 EDA 真实导出的文件钉住编码/分隔符/
  行尾，验证只改 `netname` 一列、选错器件会被拒绝
- `tests/export.mjs`——四种导出格式的语法骨架，以及模拟通道（`af === null`）
  在四种格式里都不会印出 `AFnull`
- `tests/project.mjs`——工程文件往返恒等、键序稳定、坏文件降级恢复；
  方案 diff 的实例互换、信号改脚、引脚占用/释放记账
- `tests/render.mjs`——用 Vite 的 SSR 加载器真正渲染 React 组件树。
  props 改名、少传一个 Set 这类问题只会在运行时炸成白屏，`build` 是发现不了的。
  另含"保存 → 刷新 → 恢复"的签名一致性检查——漏掉一个会改变求解输入的字段
  （比如 5V），用户改了它却看不到"已过期"，就会照着一份不再成立的方案画板子。

## 已知欠缺

- **差分 ADC 输入未建模**。只收单端正输入（INP）；INN 必须与 INP 配对使用，
  需要一套"这两条通道绑成一路"的语义。
- **COMP / OPAMP 不参与分配**。它们是"一路要 INP + INM(+VOUT)"的固定信号集，
  语义与现有 variant 模型接近，但 LQFP100 上各只有 2 个实例，优先级不高。
- **外设实例被当成同质的**。求解器不知道 SPI1/2/3 支持 I2S 而 SPI4/5/6 不支持，
  也不知道 SPI6 / I2C4 / LPUART1 在 D3(SRD) 域、只能走 BDMA 但能在 Stop 模式下工作。
  低功耗和高速设计里这才是选型的第一依据。
- **5V 只约束了引脚耐压本身**。同一 VDD 域的总 I/O 电流上限、上电默认态
  （BOOT0 / NRST）这些电气约束仍未参与求解。
- **工程文件只存单套方案**。存的是当前选中的那一套；换到方案 C 再保存会覆盖，
  不能在一份文件里并存多个候选方案。
- **单型号硬编码**。数据 schema 是通用的，但封装图的四边 ×25 和 `pinPosition()`
  里的 25 是写死的，换 LQFP64/144 需要从 `pinCount` 推导；BGA/QFN 要另做渲染。
- **`alternateSummary` 与 `functions` 有 52 处不一致**，其中 PC2/PC3 等的
  `alternateSummary` 是空数组，说明 PDF 提取有缺口。`functions` 才是实际被使用的
  字段所以不影响功能，但缺一条自校验把提取错误暴露出来。

## 外设介绍

在「选择其他型号… → 按能力浏览…」的能力旁点击 ⓘ，或在左侧外设列表点击 ⓘ、右侧检视面板点击「了解这个外设」，打开统一介绍面板。介绍覆盖能力目录中的特殊外设，包括内部计算与安全功能。

面板包含通用用途、连接与信号类别、选型注意事项、当前规划器件的引脚数据线索及 ST 官方参考资料。当前引脚表没有对应信号不代表外设不存在，尤其内部功能没有外部引脚。通用介绍不证明目标型号具备全部能力。

点击「查找带此外设的 MCU」会加入能力筛选并展开搜索，不切换器件或修改工程需求。内容离线保存于 `src/data/peripheralGuides/index.js`，通过能力 ID 关联。新增能力需补齐介绍；内部功能必须明确无专属外部引脚。

### 外设对比、接法图和封装用途检查

第二阶段在介绍面板中加入常见外设对比、数据/控制关系示意图，以及复用 `src/lib/peripheralUsage.js` 的当前封装检查。已有规则覆盖 SD 总线、FMC SDRAM/SRAM/NOR/NAND、8080 屏、QSPI Flash、以太网 RMII/MII、DCMI 摄像头和 LTDC RGB 屏。介绍页可以从具体接法直接进入对应用途筛选。

用途检查只验证同一外设实例是否具有规则要求的信号候选；它不分配具体引脚，也不检查这些信号与其他接口的冲突。当前用途规则仅覆盖 STM32 CubeMX 信号命名；TI 或规则未覆盖的能力应显示未知，不能推断为不支持。连接图是概念关系示意，不是原理图或引脚图。
