/*
  界面冒烟测试。allocator 的断言覆盖不了 React 组件——props 改名、
  少传一个 Set、在早退之后调 useState，这些都只会在运行时炸成白屏，
  build 是发现不了的。这里用 Vite 的 SSR 加载器把 App.jsx 真正渲染一遍。

  Worker 在 useEffect 里创建，renderToString 不跑副作用，所以不需要
  在 Node 里补 Worker 的桩。
*/
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});

let html;
let solutionHtml;
let inspectorHtml;
let diffHtml;
let baselineDiffHtml;
let pinHtml;
let tiPinHtml;
let dualHtml;
let bgaHtml;
try {
  const app = await server.ssrLoadModule("/src/App.jsx");
  const { allocatePins } = await server.ssrLoadModule("/src/lib/allocator.js");
  const { buildPeripheralCatalog } = await server.ssrLoadModule("/src/lib/peripherals.js");
  /* 引脚表懒加载后，App 对"当前这颗片子"是同步取值的——所以渲染前要先
     把它取回来，正如浏览器里 main.jsx 挂载前做的那样。 */
  const mcuCatalog = await server.ssrLoadModule("/src/lib/mcuCatalog.js");
  const mcu = await mcuCatalog.ensureMcuLoaded("st-stm32h743vit6-lqfp100");
  const mspm0 = await mcuCatalog.ensureMcuLoaded("ti-mspm0g3519-lqfp64-pm");

  html = renderToString(createElement(app.default));

  /* 结果面板只在求解完成后出现，整体渲染覆盖不到。喂一份真实求解结果进去。 */
  const result = allocatePins(
    mcu,
    [{ id: "spi", type: "SPI", variant: "full4" }, { id: "eth", type: "ETH", variant: "rmii" }],
    { maxSolutions: 3 },
  );
  solutionHtml = renderToString(createElement(app.SolutionPanel, {
    result: { ...result, elapsed: 12 },
    pending: false,
    stale: false,
    activeIndex: 0,
    setActiveIndex: () => {},
    lockedGroups: [],
    onToggleLock: () => {},
    onExport: () => {},
    onRerun: () => {},
  }));

  const lockedSolutionGroups = app.updateSolutionLocks([], result.solutions[0], true);
  assert.equal(lockedSolutionGroups.length, result.solutions[0].groups.length, "一键锁定应覆盖当前方案全部分组");
  assert.ok(lockedSolutionGroups.every((group) => group.locked), "一键锁定的分组应带 locked 标记");
  assert.deepEqual(app.updateSolutionLocks(lockedSolutionGroups, result.solutions[0], false), [], "解除本方案锁定应移除全部分组锁");

  const catalog = buildPeripheralCatalog(mcu, "stm32-cube");
  const spi1 = catalog.flatMap((category) => category.items).find((item) => item.id === "SPI1");
  inspectorHtml = renderToString(createElement(app.PeripheralInspector, {
    mcuData: mcu,
    peripheral: spi1,
    pinnedInstances: new Set(["SPI:SPI1"]),
    onToggleFixed: () => {},
    onSelectPin: () => {},
  }));

  const tiTimers = buildPeripheralCatalog(mspm0, "ti-mspm0").find((section) => section.id === "timers");
  const tiPwm = tiTimers.items.find((item) => item.id === "timer-pwm");
  const tiInspectorHtml = renderToString(createElement(app.PeripheralInspector, {
    mcuData: mspm0,
    peripheral: tiPwm,
    pinnedInstances: new Set(),
    onToggleFixed: () => {},
    onSelectPin: () => {},
  }));
  assert.ok(tiInspectorHtml.includes("PWM 输出"), "TI PWM 模式检视面板缺少模式标题");
  assert.ok(tiInspectorHtml.includes("TIMA0"), "TI PWM 模式检视面板缺少可用实例");

  /* 对比面板只在有求解结果时挂载，整体渲染同样覆盖不到。 */
  diffHtml = renderToString(createElement(app.DiffPanel, {
    solutions: result.solutions,
    activeIndex: 0,
    baseline: null,
    requests: [],
    onLoadBaseline: () => {},
    onClearBaseline: () => {},
  }));

  /* 与基线对比时，需求行的增删改也要列出来——"这版把 ETH 删了"解释了
     后面一连串引脚差异的由来。 */
  baselineDiffHtml = renderToString(createElement(app.DiffPanel, {
    solutions: [result.solutions[0]],
    activeIndex: 0,
    baseline: {
      name: "v1.pinplan.json",
      plan: result.solutions[1],
      requests: [
        { id: "spi", type: "SPI", variant: "full3", instance: null, side: null, fiveVolt: false },
        { id: "eth", type: "ETH", variant: "rmii", instance: null, side: null, fiveVolt: false },
      ],
    },
    requests: [
      { id: "spi", type: "SPI", variant: "full4", instance: null, side: null, fiveVolt: true },
      { id: "adc", type: "ADC", variant: "ch4", instance: null, side: null, fiveVolt: false },
    ],
    onLoadBaseline: () => {},
    onClearBaseline: () => {},
  }));

  /* 过期判定必须覆盖每一个会改变求解输入的字段。5V 是硬约束，
     漏掉它用户就会照着一份不再成立的方案画板子。 */
  const baseRow = { id: "r1", type: "SPI", variant: "full3", instance: null, side: null, fiveVolt: false };
  const sign = (row) => app.inputSignature([row], { protectDebug: true, protectOscillator: true }, new Set(), []);
  assert.equal(sign(baseRow), sign({ ...baseRow }), "同一份输入的签名必须稳定");
  for (const patch of [
    { fiveVolt: true }, { variant: "full4" }, { instance: "SPI2" }, { side: "left" }, { type: "I2C", variant: "std" },
  ]) {
    assert.notEqual(
      sign(baseRow), sign({ ...baseRow, ...patch }),
      `改动 ${Object.keys(patch).join("/")} 后签名没变，界面不会提示方案已过期`,
    );
  }

  /* 保存 → 刷新 → 恢复的整条链路。App 恢复出来的方案对应的正是恢复出来的输入，
     所以签名必须一致——否则一进页面就被标成"已过期"，用户会以为工具坏了。 */
  const { projectToJson, serializeProject, loadProject } = await server.ssrLoadModule("/src/lib/project.js");
  const liveRequests = [
    { id: "r1", type: "SPI", variant: "full3", instance: null, side: null, fiveVolt: true },
    { id: "r2", type: "ADC", variant: "ch4", instance: "ADC1", side: null, fiveVolt: false },
  ];
  const liveOptions = { protectDebug: true, protectOscillator: true };
  const liveExcluded = new Set([44]);
  const livePlan = allocatePins(mcu, liveRequests, { maxSolutions: 1, excludedPins: [44] }).solutions[0];
  const saved = projectToJson(serializeProject({
    mcuId: "st-stm32h743vit6-lqfp100",
    mcu,
    requests: liveRequests,
    options: liveOptions,
    excludedPins: liveExcluded,
    lockedGroups: [],
    solution: livePlan,
    activeIndex: 0,
  }));
  const back = loadProject(saved);
  assert.equal(back.ok, true, back.errors?.join("；"));
  assert.equal(
    app.inputSignature(liveRequests, liveOptions, liveExcluded, []),
    app.inputSignature(back.value.requests, back.value.options, back.value.excludedPins, back.value.lockedGroups),
    "恢复出来的工程签名与保存时不一致，页面一打开就会显示「已过期」",
  );
  /* 恢复的方案要能直接喂给结果面板渲染，且明确标出它不是本次求解结果 */
  const restoredHtml = renderToString(createElement(app.SolutionPanel, {
    result: { solutions: [back.value.plan], restored: true, visited: 0, poolSize: 1, droppedLocks: [] },
    pending: false,
    stale: false,
    activeIndex: 0,
    setActiveIndex: () => {},
    lockedGroups: [],
    onToggleLock: () => {},
    onExport: () => {},
    onRerun: () => {},
  }));
  assert.ok(restoredHtml.includes("上次保存的方案"), "恢复的方案应说明它不是本次求解结果");
  assert.ok(!restoredHtml.includes("undefined"), "恢复的方案面板渲染出 undefined");
  assert.ok(!restoredHtml.includes("AFnull"), "恢复的方案面板印出了 AFnull");
  assert.equal(
    (restoredHtml.match(/class="assignment"/g) || []).length,
    livePlan.groups.reduce((sum, group) => sum + group.assignments.length, 0),
    "恢复的方案明细条数与保存时不符",
  );

  /* 两边封装和 BGA 目前目录里还没有实物，但渲染分支已经在了——用合成器件
     跑一遍，免得真接一颗 TSSOP 进来时这段代码是第一次运行。 */
  const syntheticPins = (count, location) => Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    name: `P${index + 1}`,
    kind: "gpio",
    functions: [],
    additionalFunctions: [],
    protection: [],
    ...(location ? { location: location(index) } : {}),
  }));
  const renderPackage = (mcuData) => renderToString(createElement(app.PackageView, {
    mcuData,
    pins: mcuData.pins,
    selectedPin: null,
    onSelect: () => {},
    excludedPins: new Set(),
    assignedPins: new Map(),
    search: "",
    stale: false,
    highlightedPeripheral: null,
    onClearPeripheralHighlight: () => {},
  }));

  dualHtml = renderPackage({
    partNumber: "SYN-TSSOP20",
    vendor: "Synthetic",
    package: "TSSOP20",
    packageGeometry: { shape: "TSSOP", pinsPerSide: 10 },
    pinCount: 20,
    pins: syntheticPins(20),
  });
  bgaHtml = renderPackage({
    partNumber: "SYN-TFBGA16",
    vendor: "Synthetic",
    package: "TFBGA16",
    packageGeometry: { shape: "TFBGA", rows: 4, columns: 4 },
    pinCount: 16,
    pins: syntheticPins(16, (index) => `${"ABCD"[Math.floor(index / 4)]}${(index % 4) + 1}`),
  });

  /* 引脚详情的耐压标注：ST 有依据要显示，TI 数据分不出来就必须不显示。 */
  pinHtml = renderToString(createElement(app.PinInspector, {
    mcu,
    pin: mcu.pins.find((pin) => pin.name === "PA5"),
    excluded: false,
    onToggleExclude: () => {},
  }));
  tiPinHtml = renderToString(createElement(app.PinInspector, {
    mcu: mspm0,
    pin: mspm0.pins.find((pin) => pin.name === "PA0"),
    excluded: false,
    onToggleExclude: () => {},
  }));
} finally {
  await server.close();
}

assert.ok(html.length > 5000, "渲染结果过短，组件树可能提前中断");

// 默认三路需求行都在，且每行都有接线/实例/方位三个下拉
for (const needle of ["接口需求", "自动选择", "不限方位", "生成方案", "导出全部引脚 CSV", "选择 MCU", "STM32H743VIT6"]) {
  assert.ok(html.includes(needle), `界面缺少「${needle}」`);
}
/* 5V 用的是勾选框不是下拉，所以这个数不该变；DiffPanel 只在有求解结果时挂载，
   首屏 result 为 null，它的两个下拉也不计入。 */
const selectCount = (html.match(/<select/g) || []).length;
assert.equal(selectCount, 13, `期望 MCU 选择器 + 3 行 × 4 个下拉，实际 ${selectCount} 个`);

// 新外设必须出现在"添加"按钮和类型下拉里
for (const label of ["Ethernet", "SDMMC", "QUADSPI", "USB OTG", "FDCAN", "定时器 PWM", "ADC 模拟输入", "DAC 模拟输出"]) {
  assert.ok(html.includes(label), `类型列表缺少「${label}」`);
}

// 工程存取入口和逐路 5V 开关
for (const needle of ["保存", "载入", "重置", "5V 容忍"]) {
  assert.ok(html.includes(needle), `界面缺少「${needle}」`);
}
const fiveVoltBoxes = (html.match(/第 \d+ 路接 5V 电平/g) || []).length;
assert.equal(fiveVoltBoxes, 3, `期望 3 行各一个 5V 勾选框，实际 ${fiveVoltBoxes} 个`);

// 封装图 100 个引脚按钮
const pinCount = (html.match(/class="pin pin-/g) || []).length;
assert.equal(pinCount, 100, `期望 100 个引脚按钮，实际 ${pinCount} 个`);

/* 脚数预算提示（默认 SPI 3 + I2C 2 + UART 2 = 7 脚 / 82 个 GPIO）。
   renderToString 会在相邻的 JSX 表达式之间插 <!-- --> 分隔注释，
   先去掉再比对文本。 */
const text = html.replaceAll("<!-- -->", "");
assert.ok(text.includes("3 路 · 7 / 82 脚"), "接口需求标题缺少脚数预算");

/* ---------- 结果面板（求解完成后才出现的那半屏） ---------- */
const solutionText = solutionHtml.replaceAll("<!-- -->", "");
assert.ok(solutionText.includes("方案 A"), "缺少方案标签页");
assert.ok(solutionText.includes("SPI"), "缺少 SPI 分组");
assert.ok(solutionText.includes("Ethernet"), "缺少 ETH 分组标题（类型标签取自 DEFINITIONS）");
assert.ok(solutionText.includes("RMII + MDIO"), "分组标题缺少接线变体");
assert.ok(solutionText.includes("全双工 + 硬件 NSS"), "SPI 分组缺少接线变体");
assert.ok(solutionText.includes("导出"), "缺少导出入口");
// SPI 4 线 + RMII 9 线 = 13 条分配明细
const assignmentCount = (solutionHtml.match(/class="assignment"/g) || []).length;
assert.equal(assignmentCount, 13, `期望 13 条分配明细，实际 ${assignmentCount}`);
assert.ok(!solutionText.includes("undefined"), "结果面板渲染出 undefined");

/* ---------- 外设检视面板 ---------- */
assert.ok(inspectorHtml.includes("SPI1"), "检视面板缺少实例名");
assert.ok(inspectorHtml.includes("取消固定"), "pinnedInstances 未生效——应显示为已固定");
assert.ok(!inspectorHtml.includes("undefined"), "检视面板渲染出 undefined");

/* ---------- 对比面板 ---------- */
const diffText = diffHtml.replaceAll("<!-- -->", "");
assert.ok(diffText.includes("方案对比"), "对比面板缺少标题");
assert.ok(diffText.includes("方案 A"), "对比面板缺少方案下拉");
assert.ok(diffText.includes("对比基线"), "对比面板缺少基线模式入口");
assert.ok(!diffText.includes("undefined"), "对比面板渲染出 undefined");
/* 方案 A 与方案 B 的确不同，所以必须真的列出差异，而不是显示"两侧完全一致" */
assert.ok(!diffText.includes("两侧完全一致"), "方案 A/B 应有差异");
assert.match(diffText, /组新增/, "对比面板缺少差异概览");
assert.ok((diffHtml.match(/class="diff-signal/g) || []).length > 0, "对比面板没有列出任何信号差异");

/* 基线模式：需求行的增删改要列出来，且改动要显示"旧 → 新" */
const baselineText = baselineDiffHtml.replaceAll("<!-- -->", "");
assert.ok(baselineText.includes("v1.pinplan.json"), "基线模式缺少文件名");
assert.ok(baselineText.includes("需求行改动"), "基线模式缺少需求行改动小节");
assert.equal((baselineDiffHtml.match(/class="diff-request diff-/g) || []).length, 3, "SPI 改动 + ADC 新增 + ETH 移除 = 3 行");
assert.ok(baselineText.includes("全双工 3 线 → 全双工 + 硬件 NSS · 5V"), "需求行改动应显示旧 → 新");
assert.ok(!baselineText.includes("undefined"), "基线对比渲染出 undefined");

/* ---------- 引脚耐压标注 ---------- */
// PA5 是 TT_ha，不耐 5V
assert.ok(pinHtml.includes("电平耐受"), "引脚详情缺少耐压标注");
assert.ok(pinHtml.includes("仅 3.3V"), "PA5 是 TT_ha，应标为仅 3.3V");
// MSPM0 的数据全是 STD，分不出耐压等级，就不该给出结论
assert.ok(!tiPinHtml.includes("电平耐受"), "器件数据分不出耐压时不该显示耐压结论");

/* ---------- 其它封装形态 ---------- */

// TSSOP：20 个引脚全部画出来，且只有左右两条边有内容
assert.equal((dualHtml.match(/class="pin pin-/g) || []).length, 20, "两边封装应画出 20 个引脚");
assert.match(dualHtml, /pin-side pin-side-top"><\/div>/, "两边封装的顶边应为空");
assert.match(dualHtml, /pin-side pin-side-bottom"><\/div>/, "两边封装的底边应为空");
assert.ok(!dualHtml.includes("undefined"), "两边封装渲染出 undefined");

// BGA：16 个球 + 行标 A-D，标号用 location 而不是脚号
assert.equal((bgaHtml.match(/class="pin pin-/g) || []).length, 16, "BGA 应画出 16 个球");
assert.ok(bgaHtml.includes("ball-grid"), "BGA 应走栅格渲染分支");
for (const label of ["A", "B", "C", "D"]) {
  assert.ok(
    bgaHtml.includes(`class="ball-grid-row-label" aria-hidden="true">${label}<`),
    `BGA 缺少行标 ${label}`,
  );
}
assert.ok(bgaHtml.includes("<small>C2</small>"), "BGA 的球应标 location（C2）而不是脚号");
assert.ok(!/<small>\d+<\/small>/.test(bgaHtml), "BGA 上不该出现纯脚号标注");
assert.ok(!bgaHtml.includes("undefined"), "BGA 渲染出 undefined");

/*
  新手教程的高亮目标必须真的存在。

  这是这个功能唯一会**静默**坏掉的地方：改 UI 时把某个 class 换掉，教程不会
  报错，只会指着一片空白讲"点这里"。运行时组件里有兜底（找不到就跳过该步），
  但那是降级不是正确——所以在这里当成硬断言。

  只校验 class / id 选择器：教程写的都是这两种，遇到别的形式说明约定变了，
  应当先想清楚而不是让测试悄悄放行。
*/
{
  const { TOUR_STEPS } = await import("../src/lib/tour.js");
  assert.ok(TOUR_STEPS.length > 0, "教程一步都没有");
  assert.equal(
    new Set(TOUR_STEPS.map((step) => step.id)).size, TOUR_STEPS.length,
    "教程步骤 id 有重复",
  );
  for (const step of TOUR_STEPS) {
    assert.ok(step.title && step.body, `教程步骤 ${step.id} 缺标题或正文`);
    const match = /^([.#])([\w-]+)$/.exec(step.target);
    assert.ok(match, `教程步骤 ${step.id} 的 target「${step.target}」不是简单的 class/id 选择器`);
    const [, kind, name] = match;
    const present = kind === "."
      ? new RegExp(`class="[^"]*\\b${name}\\b`).test(html)
      : html.includes(`id="${name}"`);
    assert.ok(present, `教程步骤 ${step.id} 指向的「${step.target}」在页面上不存在，会高亮到空白处`);
  }
  console.log(`Verified all ${TOUR_STEPS.length} tour targets exist in the rendered app.`);
}

console.log(`Rendered App.jsx: ${html.length} bytes, ${pinCount} pins, ${selectCount} selects.`);
console.log("Rendered dual (TSSOP20) and grid (TFBGA16) package layouts.");
console.log(`Rendered SolutionPanel: ${assignmentCount} assignments; PeripheralInspector: pinned state ok.`);
assert.ok(solutionHtml.includes("锁定本方案引脚"), "方案面板缺少一键锁定全部方案引脚入口");
console.log("Rendered DiffPanel and PinInspector: plan diff rows and 5V tolerance annotation ok.");
console.log("Verified save→restore lifecycle: signature match, restored-plan banner, and stale detection fields.");
