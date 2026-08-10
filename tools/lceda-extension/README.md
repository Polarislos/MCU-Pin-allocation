# 嘉立创EDA 专业版扩展：引脚规划器

把规划器导出的 `.netlabels.json` 直接打到原理图上的 MCU 符号上。

**这个扩展取代了原来的 CSV 往返。** 以前要「EDA 导出扇出表格 → 规划器填一列 →
EDA 导入表格」三步，现在是：导出一份 JSON，在 EDA 里点一下。

这个目录是一个完整的扩展工程——嘉立创官方脚手架 `pro-api-sdk` 加上本项目的
`extension.json` 和 `src/`。

## 构建

```shell
npm install        # 首次或换机器时
npm run build      # 产物：build/dist/pinplan-netlabels_v0.3.0.eext
```

装进 EDA：**高级 → 扩展管理器 → 导入**（V2 是 设置 → 扩展 → 扩展管理器 → 导入扩展）

## 用法

1. 规划器求解出方案 → **右侧结果面板**的「导出」下拉 → **EDA 网络标签 (JSON)**
2. 原理图里**选中 MCU 器件**（点在器件图形上，不是导线或文字）
3. 菜单 **引脚规划器 → 应用引脚方案...** → 选那个 JSON

第一次会先画一根线让你确认位置（见下文「坐标校准」），确认后一次打完剩下的。

菜单里另外四项：

| 菜单 | 用途 |
| --- | --- |
| 核对引脚方案... | 只核对不写入。想先确认符号对不对的时候用 |
| 撤销上次应用 | 把上一次打的标签导线一次删掉 |
| 设置标签长度... | 嫌网络名挤在符号边上、或者嫌太占版面时改，见下 |
| 重置坐标校准 | 正常用不到，见「坐标校准」 |

### 标签长度

导线长度按**引脚长度的整数倍**设置，默认 3 倍。不用绝对尺寸是因为栅格设置问不到
（见「坐标校准」），而 `pinLength` 的整数倍必然还落在栅格上。

**必须是整数。** 1.5 倍这种会让导线端点掉出栅格，结果是画上了但没连上——不报错，
最难发现。所以输入框 `step=1`，取值时还会再取整并夹到 1～20 一次。

改完不影响已经画好的线。重新「应用引脚方案」会先清掉旧的再按新长度重画。

### ⚠ 别选错文件

规划器有两种 `.json` 产物：

| 文件 | 来自 | 用途 |
| --- | --- | --- |
| `xxx.pinplan.json` | 顶栏「工程 → 保存」 | 工程存档，给规划器自己读 |
| `xxx-pin-plan.netlabels.json` | 结果面板「导出」 | **本扩展要的就是这个** |

选错了扩展会明确告诉你选的是哪一种、正确的在哪个菜单里。

## 写入之前一定先核对

自动打网络标签最危险的失败不是"打不上"，而是**打上了但错位一格**——画完板子、
打完样才发现。所以「应用」里核对是强制前置的，分三档处理：

| 情况 | 处理 |
| --- | --- |
| 脚数对不上 / 有缺脚 | **拒绝写入**。多半是符号被拆成多个 part，或者选错了器件 |
| 脚数一样但超过 20% 的名字对不上 | **拒绝写入**。封装相同不代表是同一颗片子 |
| 零星几个名字对不上 | 列出来让你确认。标签按脚号打，不受名字影响 |

第二档的阈值和 `src/lib/fanout.js` 的 `IDENTITY_MISMATCH_LIMIT` 是同一个，理由也
一样：库里零星几个脚写法不同是常态，整片对不上才是选错了器件。

## 坐标校准（第一次使用时问一次）

文档给了引脚的 `x / y / rotation / pinLength`，但**没说 `(x, y)` 是引脚的连接点
还是根部**——两者相差一个 `pinLength`。猜错的后果不是画不出来，而是线画在离引脚
一格远的地方，看着像连上了实际没有电气连接。

所以扩展不猜：第一次应用方案时先画一根，让你看一眼确认，答案存进 `sys_Storage`，
之后不再问。如果两种画法你都否了，扩展会把该引脚的原始数字报出来，并且**一根线
都不留**。

引脚的朝向（rotation=0 是朝 +x 还是 -x）不用问：引脚一定朝符号外面长，方向取
"从所有引脚的重心指向该引脚"在引脚轴上的投影。这对任何形状的符号都成立。

导线段长取 `pinLength` 的整数倍，不用绝对尺寸——栅格是文档里同样没写清的东西，而
`pinLength` 本身就是照栅格画的，拿它当步长就不必去问当前图页的栅格设置。倍数见
上面的「标签长度」。

## 重放和撤销

改方案是常态，第二次应用必须是替换而不是叠加。

**按图元 ID 清，不按网络名清。** 按网络名清（`SCH_PrimitiveWire.getAll(net)`）只能
清掉"新方案里还存在的名字"，上一版有、这一版没有的会变成孤儿留在图上。所以每次
应用都把创建出来的导线 ID 记进 `sys_Storage`，下次先按 ID 删。

**坐标只用来发现，不用来删。** 按坐标清也能清干净，但会连用户自己手画的线一起
删掉。所以扫到"这个脚上已经有线了"的处理是**跳过并在报告里列出来**，绝不覆盖。

「撤销上次应用」存在是因为**类型定义里没有任何事务 / 批量接口**——100 个脚就是
100 次 `create`，各自独立进撤销栈，指望用户按 100 次 Ctrl+Z 不现实。按记下来的
ID 一次 `delete` 掉，比 Ctrl+Z 干净也可控。

## 为什么用导线而不是 `createNetLabel`

`eda.sch_PrimitiveAttribute.createNetLabel(x, y, net)` 是**存在的**。

（早期版本的这份文档写着"专业版没有网络标签图元"——那个结论是错的。网络标签是
**属性图元**，不在 API 参考的「原理图 & 符号」图元分类下，按图元类去找会漏掉。）

但没用它，两个原因：

- `SCH_PrimitiveAttribute.delete()` 标着 `@internal`，注释写明"属性图元不支持删除，
  本接口调用将不会有任何效果"。**建了就删不掉的东西不能拿来做可重放的导入。**
- 它标着 `ADD since EDA v4`，而本扩展声明支持 `^3.2.0`。

`SCH_PrimitiveWire` 建、删、查都齐全，导线带显式 `net` 就是专业版意义上的网络标签，
扇出功能本身产出的也是这个。注意 **`net` 必须显式传**——不传的话 API 会按坐标自己
推断网络。

另外 `createNetFlag` 只支持 `Power / Ground / AnalogGround / ProtectGround` 四种，
不能打任意网络名；`createNetPort` 能带任意网络名，但它是网络端口，语义和外观都不是
网络标签。

## 引脚名怎么比的

符号上的引脚名和数据手册很少逐字相同，库里常写成 `PA5/SPI1_SCK`、`PA5-CK`，或者给
重复的电源脚编号（`VSS_1` / `VSS_2`）。所以先归一化（转大写、把非字母数字压成一个
`/`），再判断"是否是另一边加了后缀"。

归一化把分隔符压成 `/` 而不是**删掉**：删掉就丢了词的边界，`VSS_1` 会变成 `VSS1`，
和 `PA15` 这种"编号是名字本身一部分"的写法再也分不开。已验证的用例：

| 符号引脚名 | 方案引脚名 | 结果 |
| --- | --- | --- |
| `PA5` | `PA5` | ✓ |
| `PA5/SPI1_SCK` | `PA5` | ✓ |
| `PC14-OSC32_IN` | `PC14` | ✓ |
| `PA13/JTMS-SWDIO` | `PA13` | ✓ |
| `VSS_1` | `VSS` | ✓ |
| `VDD2` | `VDD` | ✓ |
| `PA15` | `PA1` | **✗** |
| `PA10` | `PA1` | **✗** |
| `VSSA` | `VSS` | **✗** |
| `VDD` | `VSS` | ✗ |

这套规则和 `src/lib/fanout.js` 的 `pinNameMatches` 是同一份，**两处要一起改**。

## 电源脚

电源脚不在求解结果里（不参与分配），但打标签时一样要打，否则整片电源引脚是空的。
按**数据手册的引脚名**判断（`VSS*`/`GND` → `GND`，`VDD*`/`VBAT` → `+3V3`），不按
符号名——符号名可能是 `VSS_1` 这种带序号的写法。`VREF+`/`VCAP` 这类没有通用叫法的
不猜，跳过并在报告里点名。判断逻辑和 `fanout.js` 的 `powerNetOf` 保持一致。

## 源码

| 文件 | 内容 |
| --- | --- |
| `src/index.ts` | 入口、`verifyPinPlan`，各命令的 export |
| `src/apply.ts` | `applyPinPlan` / `undoLastApply` / `resetCalibration` |
| `src/geometry.ts` | 连接点、朝外方向、导线坐标、校准所需的两种解释 |
| `src/match.ts` | 引脚名归一化与比对 |
| `src/plan.ts` | `.netlabels.json` 的类型与读取，对话框包装 |
| `src/target.ts` | "要操作哪个器件"的定位 |

## ⚠ 官方文档在引脚属性上是错的

[属性表](https://prodocs.lceda.cn/cn/api/reference/pro-api.isch_primitivepin.html)把
`pinnumber` / `pinName` / `x` / `y` / `rotation` 列成可直接读的字段，还把 pin number
写成全小写的 `pinnumber`。**两点都和 `@jlceda/pro-api-types` 对不上。**

实际情况（以类型定义为准）：字段名是 `pinNumber`（驼峰），而且**全部是 `protected`**，
只能走 `getState_PinNumber()` / `getState_X()` 这类访问器。照文档写会得到
`TS2339: Property 'pinnumber' does not exist` 和 `TS2445: Property 'pinName' is protected`。

`npx tsc --noEmit` 能提前拦住——这也是为什么值得把脚手架留在仓库里而不是临时 clone。

## 两个已知的工程环境问题

都不影响构建和运行，但会让检查工具的输出没法直接看：

- **`tsc --noEmit` 有 23 个 vendor 报错**：`pro-api-types/index.d.ts` 引用了 `react`，
  被解析到父工程（Vite + React）的 `node_modules/react`，那边没装 `@types/react`。
  报错全部落在 `node_modules/` 路径下，**看 `src/` 的部分即可**。
- **`npx eslint src` 不过**：脚手架的 @antfu 配置要求 tab 缩进 + 单引号，本项目源码
  一贯是 2 空格 + 双引号。跑 `--fix` 会把风格改得和 `src/lib/` 那边不一致，所以没跑。

## 关于打包进 .eext 的文件

脚手架自带的 `README.*.md` / `CHANGELOG.md` / `LICENSE` / `images/logo.png` 都会被
打进扩展包，扩展管理器显示的就是它们。原样保留会让这个扩展在 EDA 里显示成
"pro-api-sdk"、指向 easyeda 的 GitHub 仓库。所以：

- 删掉了 `README.en/ja/ru/zh-Hant.md` 和 `CHANGELOG.md`
- `LICENSE` 换成 MIT（`extension.json` 里写的就是 MIT，原来包里却是脚手架的
  Apache-2.0，两者矛盾）
- `images/logo.png` 换成自绘图标
- `locales/` 里清掉了脚手架的示例字符串

`build/`、`config/`、`src/`、`node_modules/` 不会进包，见 `.edaignore`。

## API 状态

用到的这批接口在官方文档里标着 **BETA**，签名可能变。参考：

- <https://prodocs.lceda.cn/cn/api/guide/>
- <https://prodocs.lceda.cn/cn/api/reference/pro-api.html>
