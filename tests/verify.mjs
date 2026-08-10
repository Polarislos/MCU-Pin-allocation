/*
  分三层：

  1. 通用不变量 —— 遍历整个 MCU 目录跑，加一颗片子自动被覆盖（tests/lib/invariants.mjs）
  2. 器件抽检   —— 对着 datasheet 核对过的锚点，每颗片子一份（tests/fixtures/）
  3. 算法行为   —— 求解器、方案多样性、无解证明、AI 需求解析。这一层与器件无关，
                   借 H743 当被试品，不需要每加一颗片子就复制一遍。
*/
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveTheme } from "../src/lib/theme.js";
import {
  DEFINITIONS, allocatePins, createRequest, instancesForType, isFiveVoltTolerant, supportsFiveVolt,
} from "../src/lib/allocator.js";
import { signalGrammar } from "../src/lib/dialect.js";
import { analogFunctions, analogInputs, analogInstances } from "../src/lib/analog.js";
import { AI_ASSISTANT_TOOLS, createRequirementsEnvelope, validateRequirementsEnvelope } from "../src/lib/ai/requirements.js";
import { analysisFromEnvelope, analyzeRequirementsText } from "../src/lib/ai/assistant.js";
import { buildRequirementsSystemPrompt } from "../src/lib/ai/remote.js";
import { MCU_CATALOG, ensureMcuLoaded, getMcuById } from "../src/lib/mcuCatalog.js";
import { buildPeripheralCatalog, peripheralFunctions } from "../src/lib/peripherals.js";
import { checkMcuInvariants } from "./lib/invariants.mjs";
import { checkFixture, loadFixtures } from "./lib/fixtures.mjs";

/* ---------- 一 / 二：整个目录的通用不变量 + 器件抽检 ---------- */

assert.ok(MCU_CATALOG.length >= 2, "目录里至少要有两颗片子，否则跨厂商的抽象根本没被验证过");

const fixtures = await loadFixtures();
for (const record of MCU_CATALOG) {
  const data = await ensureMcuLoaded(record.id);
  checkMcuInvariants(record, data);
  const fixture = fixtures.get(record.id);
  assert.ok(fixture, `${record.partNumber} 没有 tests/fixtures/${record.id}.json——新片子必须留下人工核对过的锚点`);
  checkFixture(fixture, data);
}
for (const id of fixtures.keys()) {
  assert.ok(MCU_CATALOG.some((record) => record.id === id), `抽检文件 ${id}.json 没有对应的器件，目录里删干净了吗`);
}
console.log(`Verified ${MCU_CATALOG.length} devices against shared invariants and per-device fixtures.`);

/* ---------- 三：算法行为（借 H743 / MSPM0 当被试品） ---------- */

const mcu = getMcuById("st-stm32h743vit6-lqfp100").data;
const mspm0 = getMcuById("ti-mspm0g3519-lqfp64-pm").data;

const tiPeripheralCatalog = buildPeripheralCatalog(mspm0, "ti-mspm0");
assert.deepEqual(
  tiPeripheralCatalog.map((section) => section.label),
  ["PROJECT CONFIGURATION", "MSPM0 DRIVER LIBRARY", "ANALOG", "COMMUNICATIONS", "TIMERS", "SECURITY"],
);
assert.equal(tiPeripheralCatalog.find((section) => section.id === "communications").count, 6);
assert.ok(tiPeripheralCatalog.find((section) => section.id === "communications").items.some((item) => item.id === "SPI0"));
assert.ok(tiPeripheralCatalog.find((section) => section.id === "timers").items.some((item) => item.id === "timer-pwm"));
assert.ok(tiPeripheralCatalog.find((section) => section.id === "timers").items.some((item) => item.id === "TIMG0"));
const tiTimers = tiPeripheralCatalog.find((section) => section.id === "timers");
assert.deepEqual(tiTimers.items.find((item) => item.id === "timer-qei").availableInstances, ["TIMG8", "TIMG9"]);
assert.deepEqual(peripheralFunctions(mspm0, "TIMA0", "fault").map(([signal]) => signal), ["TIMA_FAL0", "TIMA_FAL1", "TIMA_FAL2"]);
assert.deepEqual(peripheralFunctions(mspm0, "TIMG8", "qei").map(([signal]) => signal), ["C0", "C1", "IDX"]);
const tiPlan = allocatePins(
  mspm0,
  [{ id: "spi", type: "SPI", variant: "full4", instance: "SPI0" }, { id: "i2c", type: "I2C", instance: "I2C0" }, { id: "uart", type: "UART", instance: "UART0" }],
  { maxSolutions: 1 },
);
assert.equal(tiPlan.solutions.length, 1);
assert.deepEqual(tiPlan.solutions[0].groups.map((group) => group.instance).sort(), ["I2C0", "SPI0", "UART0"]);
assert.ok(AI_ASSISTANT_TOOLS.includes("solve_pin_plan"));
assert.deepEqual(createRequirementsEnvelope({ mcuId: MCU_CATALOG[0].id }).modules, []);

const assistantPlan = analyzeRequirementsText(
  "一个 SPI 六轴 IMU、一个右侧 SD 卡、一个调试串口，保留 SWD",
  { mcuId: MCU_CATALOG[0].id },
);
assert.deepEqual(assistantPlan.modules.map((module) => module.id), ["imu", "sd-card", "debug-uart"]);
assert.deepEqual(assistantPlan.requests.map((request) => request.type), ["SPI", "SDMMC", "UART"]);
assert.equal(assistantPlan.requests[1].side, "right");
assert.ok(assistantPlan.constraints.some((constraint) => constraint.kind === "protectDebug"));

const directPlan = analyzeRequirementsText("需要 2 个 SPI、1 个 I2C4 和 1 个 USART3，靠左", { mcuId: MCU_CATALOG[0].id });
assert.deepEqual(directPlan.requests.map((request) => request.type), ["SPI", "SPI", "I2C", "UART"]);
assert.equal(directPlan.requests[2].instance, "I2C4");
assert.equal(directPlan.requests[3].instance, "USART3");
assert.ok(directPlan.requests.every((request) => request.side === "left"));

const aiEnvelope = createRequirementsEnvelope({
  mcuId: MCU_CATALOG[0].id,
  modules: [{ id: "imu", name: "六轴 IMU", requirements: [{ type: "SPI", variant: "full3", count: 1, side: "right" }] }],
  constraints: [{ kind: "protectDebug", value: true, label: "保留 SWD" }],
});
assert.equal(validateRequirementsEnvelope(aiEnvelope, { mcuId: MCU_CATALOG[0].id }).ok, true);
assert.equal(validateRequirementsEnvelope({ modules: [{ id: "bad", requirements: [{ type: "SPI", pin: "PA5" }] }] }).ok, false);
const normalizedAi = analysisFromEnvelope(aiEnvelope, { input: "IMU", mcuId: MCU_CATALOG[0].id });
assert.equal(normalizedAi.source, "remote");
assert.equal(normalizedAi.requests[0].side, "right");
assert.ok(buildRequirementsSystemPrompt({ mcuId: MCU_CATALOG[0].id }).includes("不要分配物理引脚"));

/* 引脚数据本身（脚号、AF 编号、保护标记、GPIO 数量）已由抽检覆盖，
   这里只测求解行为。 */
const result = allocatePins(
  mcu,
  { SPI: 2, I2C: 1, UART: 2 },
  { protectDebug: true, protectOscillator: true, includeNss: false, flowControl: false, maxSolutions: 3 },
);
assert.equal(result.solutions.length, 3);
for (const solution of result.solutions) {
  assert.equal(solution.groups.length, 5);
  const physicalPins = solution.groups.flatMap((group) => group.assignments.map((assignment) => assignment.pin.number));
  assert.equal(new Set(physicalPins).size, physicalPins.length);
  assert.ok(solution.groups.every((group) => group.assignments.every((assignment) => !assignment.pin.protection.length)));
}

const extendedSignals = allocatePins(
  mcu,
  { SPI: 1, I2C: 1, UART: 1 },
  { protectDebug: true, protectOscillator: true, includeNss: true, flowControl: true, maxSolutions: 1 },
);
assert.equal(extendedSignals.solutions.length, 1);
assert.deepEqual(
  extendedSignals.solutions[0].groups.find((group) => group.type === "SPI").assignments.map((item) => item.signal),
  ["SCK", "MISO", "MOSI", "NSS"],
);

const fixedSpi = allocatePins(
  mcu,
  { SPI: 1, I2C: 0, UART: 0 },
  { maxSolutions: 3, fixedInstances: { SPI: ["SPI1"] } },
);
assert.equal(fixedSpi.solutions.length, 3);
assert.ok(fixedSpi.solutions.every((solution) => solution.groups[0].instance === "SPI1"));
assert.deepEqual(
  extendedSignals.solutions[0].groups.find((group) => group.type === "UART").assignments.map((item) => item.signal),
  ["TX", "RX", "CTS", "RTS"],
);

// (a) 无解要能区分"已穷举确认"和"预算耗尽无法判定"
const provenInfeasible = allocatePins(mcu, { SPI: 9, I2C: 0, UART: 0 }, { maxSolutions: 5 });
assert.equal(provenInfeasible.solutions.length, 0);
assert.equal(provenInfeasible.proven, true, "SPI9 应能穷举证明无解");

const undecided = allocatePins(
  mcu,
  { SPI: 4, I2C: 3, UART: 4 },
  { maxSolutions: 5, includeNss: true, flowControl: true },
);
assert.equal(undecided.solutions.length, 0);
assert.equal(undecided.proven, false, "触及搜索上限时不得声称已确认无解");
assert.ok(undecided.exhausted || undecided.truncated);

// 有解时 proven 必须为 false —— 它只表示"确认无解"，不表示"这就是全部方案"
assert.equal(result.solutions.length > 0 && result.proven, false);

// (c) 多套方案必须使用互不相同的外设实例组合，而不是同一方案的微调
const diverse = allocatePins(mcu, { SPI: 3, I2C: 2, UART: 4 }, { maxSolutions: 5 });
assert.equal(diverse.solutions.length, 5);
const instanceSets = diverse.solutions.map((solution) =>
  solution.groups.map((group) => `${group.type}:${group.instance}`).sort().join(","));
assert.equal(new Set(instanceSets).size, 5, "5 套方案应有 5 种不同的外设实例组合");

const pinSets = diverse.solutions.map((solution) =>
  new Set(solution.groups.flatMap((group) => group.assignments.map((item) => item.pin.number))));
for (let i = 1; i < pinSets.length; i += 1) {
  const differing = [...pinSets[i]].filter((number) => !pinSets[0].has(number)).length;
  assert.ok(differing >= 2, `方案 ${i} 与方案 A 只差 ${differing} 个引脚，多样性不足`);
}

// 方案 A 仍应是分数最优的
assert.deepEqual(
  diverse.solutions.map((solution) => solution.score),
  [...diverse.solutions.map((solution) => solution.score)].sort((left, right) => left - right),
);

// (d) 锁定组数超过需求数时，多余的锁必须被剥离且组数等于需求数
const seed = allocatePins(mcu, { SPI: 2, I2C: 0, UART: 0 }, { maxSolutions: 1 });
const twoLocks = seed.solutions[0].groups.filter((group) => group.type === "SPI");
assert.equal(twoLocks.length, 2);
const overLocked = allocatePins(mcu, { SPI: 1, I2C: 0, UART: 0 }, { maxSolutions: 1 }, twoLocks);
assert.equal(overLocked.solutions[0].groups.length, 1, "需求 1 组时不得返回 2 组");
assert.equal(overLocked.droppedLocks.length, 1);
assert.equal(overLocked.droppedLocks[0].type, "SPI");

// 锁定组必须原样出现在结果中
const oneLock = [twoLocks[0]];
const locked = allocatePins(mcu, { SPI: 2, I2C: 0, UART: 0 }, { maxSolutions: 1 }, oneLock);
assert.equal(locked.droppedLocks.length, 0);
assert.ok(locked.solutions[0].groups.some((group) => group.instance === oneLock[0].instance));

// 性能：成功路径不应跑满节点预算（否则 UI 会卡）
for (const requirement of [{ SPI: 1, I2C: 1, UART: 1 }, { SPI: 2, I2C: 1, UART: 2 }, { SPI: 3, I2C: 2, UART: 4 }]) {
  const started = Date.now();
  const run = allocatePins(mcu, requirement, { maxSolutions: 5 });
  const elapsed = Date.now() - started;
  assert.ok(run.solutions.length > 0);
  assert.ok(elapsed < 400, `${JSON.stringify(requirement)} 耗时 ${elapsed}ms，超出预期`);
}

/* ---------- 扩展外设 / 逐路需求 / 方位偏好 ---------- */

const bigBoard = [
  { id: "eth", type: "ETH", variant: "rmii" },
  { id: "sd", type: "SDMMC", variant: "bit4" },
  { id: "usb", type: "USB", variant: "device" },
  { id: "qspi", type: "QUADSPI", variant: "bank1" },
  { id: "spi", type: "SPI" },
  { id: "i2c", type: "I2C" },
  { id: "uart", type: "UART", variant: "flow" },
];
const board = allocatePins(mcu, bigBoard, { maxSolutions: 3 });
assert.ok(board.solutions.length > 0, "ETH+SDMMC+USB+QUADSPI+SPI+I2C+UART 应有解");
for (const solution of board.solutions) {
  assert.equal(solution.groups.length, bigBoard.length, "每一路需求都要落到一个组");
  const pins = solution.groups.flatMap((group) => group.assignments.map((item) => item.pin.number));
  assert.equal(new Set(pins).size, pins.length, "跨外设不得共用物理脚");
  assert.ok(solution.groups.every((group) => group.assignments.every((item) => !item.pin.protection.length)));
  // 变体决定信号数：RMII 9 脚、SDMMC 4-bit 6 脚、USB 2 脚、QUADSPI 6 脚
  const sizes = Object.fromEntries(solution.groups.map((group) => [group.requestId, group.assignments.length]));
  assert.deepEqual(sizes, { eth: 9, sd: 6, usb: 2, qspi: 6, spi: 3, i2c: 2, uart: 4 });
}

// 同类型不同变体必须能共存——这正是全局 flowControl 开关做不到的
const mixedUart = allocatePins(
  mcu,
  [{ id: "bt", type: "UART", variant: "flow" }, { id: "log", type: "UART", variant: "txonly" }],
  { maxSolutions: 1 },
);
const uartSignals = Object.fromEntries(mixedUart.solutions[0].groups.map((group) => [
  group.requestId,
  group.assignments.map((item) => item.signal).sort().join("/"),
]));
assert.deepEqual(uartSignals, { bt: "CTS/RTS/RX/TX", log: "TX" });

// 方位偏好：四条边都要能落在正确的边上
for (const [side, range] of Object.entries({
  left: [1, 25], bottom: [26, 50], right: [51, 75], top: [76, 100],
})) {
  const placed = allocatePins(mcu, [{ id: "s", type: "SPI", side }], { maxSolutions: 1 });
  const numbers = placed.solutions[0].groups[0].assignments.map((item) => item.pin.number);
  assert.ok(
    numbers.every((number) => number >= range[0] && number <= range[1]),
    `side=${side} 应落在脚 ${range[0]}-${range[1]}，实际 ${numbers.join(",")}`,
  );
}

// 指定实例是硬约束
const pinnedInstance = allocatePins(
  mcu,
  [{ id: "a", type: "SPI", instance: "SPI2" }, { id: "b", type: "I2C", instance: "I2C3" }],
  { maxSolutions: 3 },
);
assert.ok(pinnedInstance.solutions.length > 0);
for (const solution of pinnedInstance.solutions) {
  assert.equal(solution.groups.find((group) => group.type === "SPI").instance, "SPI2");
  assert.equal(solution.groups.find((group) => group.type === "I2C").instance, "I2C3");
}

/* 组合枚举必须按引脚代价 best-first，否则 limit 个名额会被引脚编号靠前的
   分支灌满：TIM1_CH1N 会锁死在 PA7(#31，占用 ADC 通道)，永远轮不到紧邻
   CH1 的 PE8(#38)。 */
const bldc = allocatePins(mcu, [{ id: "m", type: "TIM", variant: "bldc" }], { maxSolutions: 1 });
const bldcPins = Object.fromEntries(
  bldc.solutions[0].groups[0].assignments.map((item) => [item.signal, item.pin.name]),
);
assert.equal(bldcPins.CH1N, "PE8", `三相互补的 CH1N 应选 PE8，实际 ${bldcPins.CH1N}`);
assert.ok(
  bldc.solutions[0].groups[0].assignments.every((item) => !/ADC/.test(item.pin.additionalFunctions.join(" "))),
  "有非 ADC 方案时不应占用 ADC 通道脚",
);

// 大配置的求解延迟
const bigStarted = Date.now();
allocatePins(mcu, bigBoard, { maxSolutions: 5 });
const bigElapsed = Date.now() - bigStarted;
assert.ok(bigElapsed < 400, `7 路大配置耗时 ${bigElapsed}ms，超出预期`);

/* ---------- 5V 容忍：硬约束 ---------- */

/* 白名单要与真实数据自洽：正好覆盖数据里出现的全部 FT* 结构，一个不多一个不少。
   漏一个就会把耐压脚误判成不耐压，多一个就会把 3.3V 脚放进 5V 方案里。
   （"白名单里的值都在数据里出现过"是通用不变量；这里反过来查有没有漏。） */
const ioStructures = new Set(mcu.pins.map((pin) => pin.ioStructure).filter(Boolean));
assert.deepEqual(
  [...mcu.electrical.fiveVoltTolerantIoStructures].sort(),
  [...ioStructures].filter((name) => name.startsWith("FT")).sort(),
  "electrical 白名单与数据里的 FT* 结构对不上",
);

const intolerant = mcu.pins.filter((pin) => pin.kind === "gpio" && isFiveVoltTolerant(mcu, pin) === false);
assert.equal(supportsFiveVolt(mspm0), false, "MSPM0 数据分不出耐压等级，该约束必须整体不可用");
/* 数据支持不了这条约束时返回 null（未知），不是 false（不耐压） */
assert.equal(isFiveVoltTolerant(mspm0, mspm0.pins.find((pin) => pin.name === "PA0")), null);

const intolerantNumbers = new Set(intolerant.map((pin) => pin.number));
for (const type of ["SPI", "I2C", "UART", "TIM", "ADC"]) {
  const plan = allocatePins(mcu, [{ id: "v", type, fiveVolt: true }], { maxSolutions: 3 });
  assert.ok(plan.solutions.length > 0, `${type} 的 5V 需求应有解`);
  for (const solution of plan.solutions) {
    assert.ok(
      solution.groups[0].assignments.every((item) => !intolerantNumbers.has(item.pin.number)),
      `${type} 标了 5V 却分到了不耐压的脚`,
    );
  }
}

/* 候选缓存键必须带上耐压要求：同一次求解里一路 5V SPI、一路普通 SPI，
   共用一个 key 会让后来的那路拿到错误的候选池。 */
const mixedVoltage = allocatePins(
  mcu,
  [{ id: "hv", type: "SPI", variant: "full3", fiveVolt: true }, { id: "lv", type: "SPI", variant: "full3" }],
  { maxSolutions: 1 },
);
assert.equal(mixedVoltage.solutions.length, 1);
const hvGroup = mixedVoltage.solutions[0].groups.find((group) => group.requestId === "hv");
assert.ok(
  hvGroup.assignments.every((item) => !intolerantNumbers.has(item.pin.number)),
  "同一次求解里的 5V 需求被非 5V 的候选池污染了",
);

/* MSPM0 上这个标志应被忽略——不报错、也不因此无解 */
const tiFiveVolt = allocatePins(mspm0, [{ id: "s", type: "SPI", fiveVolt: true }], { maxSolutions: 1 });
assert.equal(tiFiveVolt.solutions.length, 1, "器件数据不支持耐压约束时应忽略该标志而不是判无解");

/* ---------- 模拟通道 ---------- */

/* 实例集合与通道数由抽检覆盖（ST 的 ADC123_INP10 逐位展开成 ADC1/2/3，
   不是一个叫 "ADC123" 的实例）。这里测的是解析规则本身。
   INN 是差分负端，不能当独立的一路模拟输入： */
assert.ok(
  analogInputs(mcu, "ADC").get("ADC1").every((item) => item.channel.startsWith("INP")),
  "只有单端正输入 INP 可以作为候选",
);
assert.equal(analogFunctions(mcu, "ADC", "ADC1").length, 14);

/* TI 用 A<adc>_<channel> 和单路 DAC_OUT，同一套接口要能解析出来 */
assert.ok(analogInputs(mspm0, "ADC").get("ADC0").some((item) => item.pin.name === "PA12" && item.channel === "8"));
assert.deepEqual(analogInstances(mspm0, "DAC"), ["DAC"]);

const adcPlan = allocatePins(mcu, [{ id: "a", type: "ADC", variant: "ch4", instance: "ADC1" }], { maxSolutions: 3 });
assert.ok(adcPlan.solutions.length > 0);
for (const solution of adcPlan.solutions) {
  const group = solution.groups[0];
  assert.equal(group.instance, "ADC1", "指定实例是硬约束");
  assert.equal(group.assignments.length, 4);
  assert.equal(new Set(group.assignments.map((item) => item.pin.number)).size, 4, "四路通道不得共用同一个脚");
  assert.ok(group.assignments.every((item) => item.af === null), "模拟通道没有 AF 编号");
  assert.ok(
    group.assignments.every((item) => item.pin.additionalFunctions.some((name) => /^ADC(1|12|123)_INP/.test(name))),
    "分到的脚必须真的挂在 ADC1 上",
  );
}

/* pinCost 对含 ADC 的脚有 +4 罚分，模拟需求本身必须豁免，
   否则求解器会绕开用户明确要的东西。 */
assert.ok(
  adcPlan.solutions[0].groups[0].assignments.every((item) => /ADC/.test(item.pin.additionalFunctions.join(" "))),
  "模拟需求被自己的 ADC 罚分挡住了",
);

/* ADC3 只有 4 个 INP 脚，要 8 路是能靠计数证明的无解——不能退化成"无法判定" */
const analogInfeasible = allocatePins(mcu, [{ id: "a", type: "ADC", variant: "ch8", instance: "ADC3" }], { maxSolutions: 1 });
assert.equal(analogInfeasible.solutions.length, 0);
assert.equal(analogInfeasible.proven, true, "通道数不够是纯计数结论，必须能证明无解");

/* RMII 恰好吃掉 ADC1 十四个脚里的六个，剩下八个脚只有唯一一种 8 通道取法。
   这正是预枚举 + 截断永远答不出来的情形。 */
const analogVsEth = allocatePins(
  mcu,
  [{ id: "a", type: "ADC", variant: "ch8", instance: "ADC1" }, { id: "e", type: "ETH", variant: "rmii" }],
  { maxSolutions: 1 },
);
assert.ok(analogVsEth.solutions.length > 0, "ADC 8 路 + RMII 有解，求解器必须找得到");
const ethPins = new Set(analogVsEth.solutions[0].groups.find((g) => g.type === "ETH").assignments.map((i) => i.pin.number));
assert.ok(
  analogVsEth.solutions[0].groups.find((g) => g.type === "ADC").assignments.every((i) => !ethPins.has(i.pin.number)),
  "模拟通道与 ETH 抢到了同一个脚",
);

/* DAC1 只有 PA4/PA5 两个脚，而它们同时是 ADC12_INP18/INP19。
   余量小的模拟组必须先排，否则 ADC 会把 DAC 饿死。 */
const analogContention = allocatePins(
  mcu,
  [{ id: "a", type: "ADC", variant: "ch4", instance: "ADC1" }, { id: "d", type: "DAC", variant: "out2" }],
  { maxSolutions: 1 },
);
assert.ok(analogContention.solutions.length > 0, "ADC 与 DAC 抢 PA4/PA5 时应仍有解");
assert.deepEqual(
  analogContention.solutions[0].groups.find((g) => g.type === "DAC").assignments.map((i) => i.pin.name),
  ["PA4", "PA5"],
);

/* 方位偏好在模拟路径上同样生效（ADC 脚分布在左边和底边两条边上） */
for (const [side, range] of Object.entries({ left: [1, 25], bottom: [26, 50] })) {
  const placed = allocatePins(mcu, [{ id: "a", type: "ADC", variant: "ch4", instance: "ADC1", side }], { maxSolutions: 1 });
  const numbers = placed.solutions[0].groups[0].assignments.map((item) => item.pin.number);
  assert.ok(
    numbers.every((number) => number >= range[0] && number <= range[1]),
    `ADC side=${side} 应落在脚 ${range[0]}-${range[1]}，实际 ${numbers.join(",")}`,
  );
}

/* 5V + 模拟：ADC 脚里有一半是 TT_*，标了 5V 就必须避开 */
const analogFiveVolt = allocatePins(mcu, [{ id: "a", type: "ADC", variant: "ch4", fiveVolt: true }], { maxSolutions: 3 });
assert.ok(analogFiveVolt.solutions.length > 0);
for (const solution of analogFiveVolt.solutions) {
  assert.ok(solution.groups[0].assignments.every((item) => !intolerantNumbers.has(item.pin.number)));
}

/* 数字 + 模拟混合板：不得共用物理脚，且延迟可接受 */
const mixedBoard = [
  { id: "a", type: "ADC", variant: "ch4" },
  { id: "d", type: "DAC", variant: "out2" },
  { id: "s", type: "SDMMC", variant: "bit4" },
  { id: "e", type: "ETH", variant: "rmii" },
  { id: "p", type: "SPI" },
  { id: "i", type: "I2C" },
  { id: "u", type: "UART", variant: "flow" },
];
const mixedStarted = Date.now();
const mixed = allocatePins(mcu, mixedBoard, { maxSolutions: 5 });
const mixedElapsed = Date.now() - mixedStarted;
assert.ok(mixed.solutions.length > 0, "数字 + 模拟混合板应有解");
for (const solution of mixed.solutions) {
  assert.equal(solution.groups.length, mixedBoard.length);
  const pins = solution.groups.flatMap((group) => group.assignments.map((item) => item.pin.number));
  assert.equal(new Set(pins).size, pins.length, "数字与模拟不得共用物理脚");
}
assert.ok(mixedElapsed < 1200, `含模拟的 7 路大配置耗时 ${mixedElapsed}ms，超出预期`);

/*
  ETH 的 MII / RMII 方言映射。

  单独测是因为目录里三颗片子都不覆盖它：H743 的数据是手工整理的，信号名本来
  就带模式限定（ETH_MII_TXD0），走不到 rename 那条分支。会用到中立写法的是
  tools/import-stm32.mjs 从 CubeMX 库导出来的数据——那份数据不在目录里，
  但映射错了会让导入的 H7 器件以太网直接无解，所以在这里锁住。
*/
{
  const neutral = { signalDialect: "st" };
  const grammar = signalGrammar(neutral, "ETH", DEFINITIONS.ETH);
  const canonical = (name) => {
    const match = name.match(grammar.pattern);
    assert.ok(match, `${name} 没被 ETH 语法匹配上`);
    return grammar.normalizeAll(match[2]);
  };

  /* 名字自带模式区分的，1:1 直译——PA1 上库里并列 ETH_REF_CLK 和 ETH_RX_CLK，
     译反了会把 RMII 的参考时钟当成 MII 的接收时钟。 */
  assert.deepEqual(canonical("ETH_REF_CLK"), ["RMII_REF_CLK"]);
  assert.deepEqual(canonical("ETH_RX_CLK"), ["MII_RX_CLK"]);
  assert.deepEqual(canonical("ETH_CRS_DV"), ["RMII_CRS_DV"]);
  assert.deepEqual(canonical("ETH_RX_DV"), ["MII_RX_DV"]);
  /* CRS 与 CRS_DV 是两根不同的线，锚定的正则不能让前者吃掉后者 */
  assert.deepEqual(canonical("ETH_CRS"), ["MII_CRS"]);

  /* MII 独有 */
  assert.deepEqual(canonical("ETH_TXD3"), ["MII_TXD3"]);
  assert.deepEqual(canonical("ETH_TX_CLK"), ["MII_TX_CLK"]);

  /* 两种模式共用同一根线：一个厂商名要落到两个规范名上 */
  assert.deepEqual(canonical("ETH_TXD0"), ["MII_TXD0", "RMII_TXD0"]);
  assert.deepEqual(canonical("ETH_TX_EN"), ["MII_TX_EN", "RMII_TX_EN"]);
  assert.deepEqual(canonical("ETH_RXD1"), ["MII_RXD1", "RMII_RXD1"]);

  /* 两种模式通用且本来就是规范名的，不该被改写 */
  assert.deepEqual(canonical("ETH_MDC"), ["MDC"]);
  assert.deepEqual(canonical("ETH_MDIO"), ["MDIO"]);

  /* 手工数据里已经是规范名的写法必须原样通过，否则改方言就会打坏 H743 */
  assert.deepEqual(canonical("ETH_MII_TXD0"), ["MII_TXD0"]);
  assert.deepEqual(canonical("ETH_RMII_REF_CLK"), ["RMII_REF_CLK"]);
}

/*
  主题的自动档规则。

  边界值在两处重复：src/lib/theme.js 和 index.html 里那段抢跑脚本（它必须在
  样式表解析前定好配色，等不到 JS chunk 下载完）。两处漂了不会报错，只会表现为
  "刷新时闪一下另一种配色"——所以这里连 index.html 一起校验。
*/
{
  const at = (hour) => { const date = new Date(2026, 0, 15, hour, 0, 0); return date; };
  for (const hour of [0, 3, 5, 18, 19, 23]) {
    assert.equal(resolveTheme("auto", at(hour)), "dark", `${hour}:00 应判为夜间`);
  }
  for (const hour of [6, 7, 12, 17]) {
    assert.equal(resolveTheme("auto", at(hour)), "light", `${hour}:00 应判为日间`);
  }
  /* 手动锁定压过时间 */
  assert.equal(resolveTheme("light", at(23)), "light");
  assert.equal(resolveTheme("dark", at(12)), "dark");

  const shell = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const bounds = [...shell.matchAll(/getHours\(\)\s*(>=|<)\s*(\d+)/g)].map((match) => Number(match[2]));
  assert.deepEqual(
    bounds.sort((left, right) => left - right), [6, 18],
    "index.html 抢跑脚本的昼夜边界与 src/lib/theme.js 不一致，刷新时会闪一下另一种配色",
  );
}

/*
  从外设配置直接勾选外设 → 必须真的排得出来。

  侧栏列的是 buildPeripheralCatalog() 的条目，求解走的是 DEFINITIONS + createRequest。
  两边对"实例叫什么"的理解一旦不一致（比如目录里是 CAN1、求解器认的是 CAN），
  勾选后会得到一路永远无解的需求，而界面上什么都不会提示。

  只挑 modeled 的条目——静态信息行本来就不该出现加入按钮。
*/
{
  const { buildPeripheralCatalog } = await import("../src/lib/peripherals.js");
  for (const [record, data] of [
    [getMcuById("st-stm32h743vit6-lqfp100"), mcu],
    [getMcuById("ti-mspm0g3519-lqfp64-pm"), mspm0],
  ]) {
    const catalog = buildPeripheralCatalog(data, record.uiProfile);
    const pickable = catalog.flatMap((section) => section.items)
      .filter((item) => item.modeled && item.type && item.instance);
    assert.ok(pickable.length > 0, `${record.partNumber}: 侧栏一个可勾选的外设都没有`);

    for (const item of pickable) {
      /* 目录里的实例名必须是求解器认得的那一个 */
      const known = instancesForType(data, item.type);
      assert.ok(
        known.includes(item.instance),
        `${record.partNumber}: 侧栏列出了 ${item.type} 的实例「${item.instance}」，`
        + `但求解器只认 ${known.slice(0, 5).join("/")}…——勾选后会永远无解`,
      );
    }

    /* 抽一路真的排一遍，确认 createRequest 的默认变体在这颗片子上可行 */
    const sample = pickable[0];
    const plan = allocatePins(
      data,
      [{ ...createRequest(sample.type, { instance: sample.instance }), id: "picked" }],
      { maxSolutions: 1 },
    );
    assert.ok(
      plan.solutions.length > 0,
      `${record.partNumber}: 勾选 ${sample.label} 后排不出方案（默认变体 ${sample.type} 不可行）`,
    );
    assert.equal(plan.solutions[0].groups[0].instance, sample.instance, "勾选的实例被求解器换成了别的");
  }
  console.log("Verified peripheral-sidebar picks map to solvable, instance-pinned requests on both vendors.");
}

/*
  STORAGE_KEYS 必须登记全部持久化的键。

  个人中心的"清除本地数据"按这张表操作——漏登记一个键，那份数据就永远删不掉，
  而且用户看到的用量统计也是错的。这类遗漏不会报错，只会表现为"我明明清了，
  API Key 怎么还在"。所以拿源码反查：凡是出现在 localStorage.*Item() 里的字面量
  键名，都得在表里。
*/
{
  const { STORAGE_KEYS } = await import("../src/lib/preferences.js");
  const registered = new Set(Object.values(STORAGE_KEYS));
  const sources = ["../src/App.jsx", "../src/lib/theme.js", "../src/lib/preferences.js"];
  const used = new Set();
  for (const relative of sources) {
    const code = await readFile(new URL(relative, import.meta.url), "utf8");
    /* 直接写字面量的：localStorage.getItem("xxx") */
    for (const match of code.matchAll(/localStorage\.\w+Item\(\s*"([^"]+)"/g)) used.add(match[1]);
    /* 经由常量的：const X_KEY = "xxx"，只收本工具自己的前缀 */
    for (const match of code.matchAll(/=\s*"(mcu-pin-planner[.:][\w.:-]+)"/g)) used.add(match[1]);
  }
  for (const key of used) {
    assert.ok(
      registered.has(key),
      `localStorage 键「${key}」没有登记到 preferences.js 的 STORAGE_KEYS，个人中心清不掉它`,
    );
  }
  assert.ok(used.size >= 3, `只扫到 ${used.size} 个存储键，正则可能失效了`);
  console.log(`Verified all ${used.size} localStorage keys are registered for clearing.`);
}

console.log(`Verified ${mcu.pins.length} pins, 82 GPIOs, and ${result.solutions.length} conflict-free allocation plans.`);
console.log("Verified theme auto-mode boundaries and the inline pre-paint script agreeing on them.");
console.log("Verified ETH MII/RMII dialect mapping, including the shared lines that map to two canonical names.");
console.log(`Verified 5V tolerance (${intolerant.length} intolerant GPIOs) as a hard constraint and cache-key isolation.`);
console.log(`Verified ADC/DAC channel allocation on both vendor conventions (${mixedElapsed}ms for the mixed board).`);
console.log("Verified infeasibility proof, solution diversity, lock-overflow handling, and solver latency.");
console.log(`Verified 9 peripheral types, per-request variants, side preference, and instance pinning (${bigElapsed}ms for 7 interfaces).`);
