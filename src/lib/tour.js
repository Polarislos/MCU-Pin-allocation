/*
  新手教程的步骤定义。

  与渲染分开，这样步骤本身能被测试覆盖——最容易坏的不是动画而是**选择器失配**：
  某次改 UI 把 class 换掉，教程就会指着一片空白讲"点这里"。tests/verify.mjs 会
  拿渲染出来的 HTML 逐条校验 target 真的存在。

  ── 讲什么 ──────────────────────────────────────────────────────────
  按真实工作流排：选器件 → 描述需求 → 求解 → 读封装图 → 查引脚 → 导出。
  每一步只讲"这块是干什么的、为什么需要它"，不讲操作细节——界面本身已经写了
  按钮文案，教程再复述一遍是浪费。

  ── placement ──────────────────────────────────────────────────────
  提示卡相对高亮区域的位置。定不下来时用 "auto"，由组件按可用空间自己挑，
  避免卡片跑到视口外。
*/

export const TOUR_STEPS = [
  {
    id: "mcu",
    target: ".mcu-selector",
    placement: "bottom",
    title: "先选目标器件",
    body: "下拉里是已固化进目录的几颗。点「选择其他型号…」可以从本机 CubeMX / SysConfig 库里搜三千多个型号，选中后现场转换成引脚数据。",
  },
  {
    id: "requirements",
    target: ".request-list",
    placement: "right",
    title: "描述你要什么接口",
    body: "按「路」添加：一路 SPI、一路 I²C、两路 UART。每一路可以指定接线变体（SPI 三线还是带片选）、锁定外设实例、要求靠板子哪一侧、以及是否必须耐 5V。",
  },
  {
    id: "solve",
    /* 不能用 .primary-button：AI 助手的「解析需求」也挂这个类且在 DOM 里更靠前，
       querySelector 会取到它，教程就指着错的按钮讲求解。 */
    target: ".solve-button",
    placement: "right",
    title: "交给求解器",
    body: "求解器会同时满足所有约束，给出多套差异明显的方案。排不下时它会明确告诉你无解——而不是给一个看似可行、实际冲突的结果。",
  },
  {
    id: "package",
    target: ".package-stage",
    placement: "left",
    title: "封装图就是结果",
    body: "分配到的引脚按外设着色，鼠标悬停看详情。灰色是被保护的调试口和晶振脚，默认不参与分配。",
  },
  {
    id: "inspector",
    target: ".detail-panel",
    placement: "left",
    title: "逐脚核对",
    body: "点任意引脚查看它的全部复用功能、AF 编号（F1 系列是重映射组号）、模拟通道和电平耐受。发现某个脚要留给别的用途，可以在这里排除它再重排。",
  },
  {
    id: "export",
    target: ".project-tools",
    placement: "bottom",
    title: "导出与存档",
    body: "结果可导出成 CSV、CubeMX .ioc 片段、HAL 引脚头文件或 Markdown 评审表。工程本身也能存成文件，换台机器接着改。",
  },
];

/* 组件按 id 找步骤时用；顺带保证 id 不重复。 */
export function stepIndexById(id) {
  return TOUR_STEPS.findIndex((step) => step.id === id);
}
