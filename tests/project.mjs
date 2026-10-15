/*
  工程持久化与方案对比。

  这两块的失效方式都很安静：序列化少存一个字段，要到用户下次打开工程、
  发现锁定组没了才知道；diff 配错一组，评审时就会漏掉一处改动。所以逐项断言。
*/
import assert from "node:assert/strict";
import { allocatePins } from "../src/lib/allocator.js";
import { MCU_CATALOG, ensureMcuLoaded, registerMcu, resolveRuntimeQuery } from "../src/lib/mcuCatalog.js";
import {
  PROJECT_FORMAT, PROJECT_VERSION, loadProject, parseProject, projectFileName, projectToJson, serializeProject,
} from "../src/lib/project.js";
import { diffPlans, diffRequests, isEmptyDiff } from "../src/lib/diff.js";

/* 引脚表是懒加载的——还原工程之前必须先把这颗片子取回来，
   这正是 App 里 loadProjectFile() 要做的事。

   显式点名 H743 而不是取 MCU_CATALOG[0]：下面那组需求里有 ETH RMII，
   只有大片子排得出来，而清单是按 id 字母序生成的——靠目录顺序拿片子，
   加一颗字母序更靠前的小片子就会让这个测试莫名其妙地失败。 */
const mcuId = "st-stm32h743vit6-lqfp100";
assert.ok(MCU_CATALOG.some((record) => record.id === mcuId), `目录里没有 ${mcuId}`);
const mcu = await ensureMcuLoaded(mcuId);

const requests = [
  { id: "r1", type: "SPI", variant: "full4", instance: null, side: null, fiveVolt: true },
  { id: "r2", type: "ADC", variant: "ch4", instance: "ADC1", side: null, fiveVolt: false },
  { id: "r3", type: "ETH", variant: "rmii", instance: null, side: "right", fiveVolt: false },
];
const options = { protectDebug: true, protectOscillator: true };
const solved = allocatePins(mcu, requests, { maxSolutions: 3 });
assert.ok(solved.solutions.length >= 2, "对比测试需要至少两套方案");
const lockedGroups = [solved.solutions[0].groups.find((group) => group.type === "SPI")];

const baseState = {
  mcuId,
  mcu,
  requests,
  options,
  excludedPins: new Set([44, 12]),
  lockedGroups,
  solution: solved.solutions[0],
  activeIndex: 0,
  savedAt: "2026-08-08T00:00:00.000Z",
};
const json = projectToJson(serializeProject(baseState));

/* ---------- 文件形状 ---------- */
const raw = JSON.parse(json);
assert.equal(raw.format, PROJECT_FORMAT);
assert.equal(raw.version, PROJECT_VERSION);
assert.equal(raw.mcu.id, mcuId);
assert.equal(raw.mcu.partNumber, "STM32H743VIT6");
assert.deepEqual(raw.excludedPins, [12, 44], "排除引脚要排序，否则 git diff 会有假变更");
assert.ok(json.endsWith("\n"), "文件要以换行结尾");

/* 引脚必须降成脚号。内存里 assignment.pin 带着整条 pin 记录（几十个 AF），
   直接 JSON 化会让文件膨胀十几倍，且 diff 全是与设计无关的噪声。 */
for (const group of [...raw.lockedGroups, ...raw.plan.groups]) {
  for (const item of group.assignments) {
    assert.equal(typeof item.pin, "number", `${group.instance} 的引脚应存为脚号而不是对象`);
  }
}
assert.ok(json.length < 12000, `工程文件 ${json.length} 字节，偏大——检查是否又把整条 pin 记录写进去了`);

/* savedAt 放最后一个键：它每次保存都变，放末尾让 git diff 只有一行噪声 */
assert.equal(Object.keys(raw).at(-1), "savedAt");

/* ---------- 键序稳定 ---------- */
const shuffled = projectToJson(serializeProject({
  savedAt: "2026-08-08T00:00:00.000Z",
  solution: solved.solutions[0],
  lockedGroups,
  excludedPins: [12, 44],
  options: { protectOscillator: true, protectDebug: true },
  requests,
  mcu,
  mcuId,
  activeIndex: 0,
}));
assert.equal(shuffled, json, "同一份工程无论怎么构造，序列化结果都必须逐字节相同");

/* ---------- 往返恒等 ---------- */
const loaded = loadProject(json);
assert.equal(loaded.ok, true, loaded.errors?.join("；"));
assert.deepEqual(loaded.warnings, []);
assert.deepEqual(loaded.value.requests, requests, "需求行往返后必须完全一致");
assert.deepEqual(loaded.value.options, options);
assert.deepEqual([...loaded.value.excludedPins].sort((a, b) => a - b), [12, 44]);
assert.equal(loaded.value.plan.groups.length, solved.solutions[0].groups.length);

/* 锁定组还原出来的必须是 mcu.pins 里的真实对象，否则求解器拿不到 functions */
assert.equal(loaded.value.lockedGroups.length, 1);
for (const item of loaded.value.lockedGroups[0].assignments) {
  assert.ok(mcu.pins.includes(item.pin), `${item.signal} 的 pin 不是 mcu.pins 里的对象`);
}
/* 还原后的锁必须真能喂回求解器 */
const reSolved = allocatePins(
  mcu,
  loaded.value.requests,
  { maxSolutions: 1, excludedPins: [...loaded.value.excludedPins] },
  loaded.value.lockedGroups,
);
assert.equal(reSolved.droppedLocks.length, 0, "还原出来的锁应被求解器认领");
assert.ok(reSolved.solutions.length > 0);
assert.ok(reSolved.solutions[0].groups.some((group) => group.instance === loaded.value.lockedGroups[0].instance));

/* 模拟组的 af 是 null，往返后不能变成别的 */
const analogPlan = loaded.value.plan.groups.find((group) => group.type === "ADC");
assert.ok(analogPlan, "方案快照里应包含 ADC 组");
assert.ok(analogPlan.assignments.every((item) => item.af === null), "模拟通道的 af 应保持 null");

assert.match(projectFileName(mcu), /^STM32H743VIT6-pin-plan\.pinplan\.json$/);

/* ---------- 坏输入要产出可读的错误，而不是崩溃 ---------- */
assert.equal(parseProject("{oops").ok, false);
assert.equal(parseProject("[]").ok, false);
assert.equal(parseProject(JSON.stringify({ format: "something-else" })).ok, false);
assert.match(
  parseProject(JSON.stringify({ format: PROJECT_FORMAT, version: 99, mcu: { id: mcuId } })).errors[0],
  /版本/,
);
assert.match(
  loadProject(JSON.stringify({ format: PROJECT_FORMAT, version: PROJECT_VERSION, mcu: { id: "no-such-mcu" } })).errors[0],
  /不在当前目录/,
);

/* ---------- 对不上的内容要降级为 warning 并尽量恢复 ---------- */
const mangled = JSON.parse(json);
mangled.lockedGroups[0].assignments[0].pin = 999;         // 越界脚号
mangled.requests.push({ id: "rx", type: "NOPE", variant: "x" });
mangled.requests.push({ id: "ry", type: "SPI", variant: "no-such-variant" });
mangled.excludedPins.push(500);
const partial = loadProject(JSON.stringify(mangled));
assert.equal(partial.ok, true, "个别条目对不上时仍应载入");
assert.equal(partial.value.lockedGroups.length, 0, "越界脚号的锁定组要整组丢弃");
assert.equal(partial.value.requests.length, requests.length + 1, "未知类型丢弃，未知变体保留并改用默认值");
assert.equal(partial.value.requests.at(-1).variant, "full3", "未知变体应回落到该类型的默认变体");
assert.equal([...partial.value.excludedPins].includes(500), false);
assert.ok(partial.warnings.some((text) => /未知的接口类型/.test(text)));
assert.ok(partial.warnings.some((text) => /未知的接线变体/.test(text)));
assert.ok(partial.warnings.some((text) => /不在当前器件上/.test(text)));

/* 脚号对上但脚名对不上 = 文件来自另一份器件数据，这时的分配没有意义 */
const renamed = JSON.parse(json);
renamed.lockedGroups[0].assignments[0].pinName = "PZ9";
const wrongData = loadProject(JSON.stringify(renamed));
assert.equal(wrongData.value.lockedGroups.length, 0);
assert.ok(wrongData.warnings.some((text) => /文件记的是 PZ9/.test(text)));

/* 功能名 / AF 编号必须在那个脚上真实存在。这些值会原样进 .ioc 和 HAL 头文件，
   不校验就等于把文件里的任意字符串直接写进用户的工程。 */
for (const patch of [
  { function: "TOTALLY_MADE_UP" },
  { af: 13 },                       // 名字对但 AF 编号对不上
]) {
  const forged = JSON.parse(json);
  Object.assign(forged.lockedGroups[0].assignments[0], patch);
  const checked = loadProject(JSON.stringify(forged));
  assert.equal(checked.value.lockedGroups.length, 0, `伪造的 ${Object.keys(patch)[0]} 应导致整组丢弃`);
  assert.ok(checked.warnings.some((text) => /上没有/.test(text)));
}
/* 模拟通道走 additionalFunctions，同样要校验 */
const forgedAnalog = JSON.parse(json);
const analogGroupIndex = forgedAnalog.plan.groups.findIndex((group) => group.type === "ADC");
forgedAnalog.plan.groups[analogGroupIndex].assignments[0].function = "ADC9_INP99";
const analogChecked = loadProject(JSON.stringify(forgedAnalog));
assert.equal(
  analogChecked.value.plan.groups.filter((group) => group.type === "ADC").length,
  0,
  "伪造的模拟通道名应导致整组丢弃",
);

/* 型号不符只警告，不拒绝——数据可能只是修订版本不同 */
const otherPart = JSON.parse(json);
otherPart.mcu.partNumber = "STM32H743ZIT6";
otherPart.mcu.source.revision = "9";
const mismatched = loadProject(JSON.stringify(otherPart));
assert.equal(mismatched.ok, true);
assert.ok(mismatched.warnings.some((text) => /STM32H743ZIT6/.test(text)));
assert.ok(mismatched.warnings.some((text) => /Rev 9/.test(text)));

/* ---------- diffPlans ---------- */
const left = solved.solutions[0];
const right = solved.solutions[1];
const diff = diffPlans(left, right);

/* 自比必须完全干净，否则任何"没改动"的判断都不可信 */
assert.equal(isEmptyDiff(diffPlans(left, left)), true);
assert.deepEqual(diffPlans(left, left).summary, {
  groupsAdded: 0, groupsRemoved: 0, groupsChanged: 0, signalsMoved: 0, pinsTaken: 0, pinsFreed: 0,
});
assert.ok(diffPlans(left, left).groups.every((group) => group.status === "same"));

assert.equal(isEmptyDiff(diff), false, "方案 A 与方案 B 之间应有差异");
/* 占用与释放的脚数要和两套方案的引脚集合对得上 */
const pinsOf = (plan) => new Set(plan.groups.flatMap((group) => group.assignments.map((item) => item.pin.number)));
const leftPins = pinsOf(left);
const rightPins = pinsOf(right);
assert.equal(diff.summary.pinsTaken, [...rightPins].filter((pin) => !leftPins.has(pin)).length);
assert.equal(diff.summary.pinsFreed, [...leftPins].filter((pin) => !rightPins.has(pin)).length);

/* 换了外设实例要表现为 removed + added，而不是被抹平成"同一组换了脚"——
   换实例是真实的设计变更，评审必须看得见。 */
const swapped = {
  groups: [{
    type: "SPI",
    instance: "SPI2",
    variant: "full3",
    assignments: left.groups.find((group) => group.type === "SPI").assignments,
  }],
};
const onlySpi = { groups: [left.groups.find((group) => group.type === "SPI")] };
const instanceSwap = diffPlans(onlySpi, swapped);
assert.equal(instanceSwap.summary.groupsAdded, 1);
assert.equal(instanceSwap.summary.groupsRemoved, 1);
assert.equal(instanceSwap.summary.groupsChanged, 0);

/* 同实例换脚 = moved，逐信号列出来 */
const spiGroup = left.groups.find((group) => group.type === "SPI");
const otherPin = mcu.pins.find((pin) => pin.kind === "gpio" && !leftPins.has(pin.number));
const movedPlan = {
  groups: [{
    ...spiGroup,
    assignments: spiGroup.assignments.map((item, index) => (index === 0 ? { ...item, pin: otherPin } : item)),
  }],
};
const movedDiff = diffPlans(onlySpi, movedPlan);
assert.equal(movedDiff.summary.groupsChanged, 1);
assert.equal(movedDiff.summary.signalsMoved, 1);
assert.equal(movedDiff.pins.moved[0].signal, spiGroup.assignments[0].signal);
assert.equal(movedDiff.pins.moved[0].from.pinName, spiGroup.assignments[0].pin.name);
assert.equal(movedDiff.pins.moved[0].to.pinName, otherPin.name);
assert.equal(movedDiff.summary.pinsTaken, 1);
assert.equal(movedDiff.summary.pinsFreed, 1);

/* 空的一侧：整份方案新增 / 整份方案移除 */
assert.equal(diffPlans({ groups: [] }, onlySpi).summary.groupsAdded, 1);
assert.equal(diffPlans(onlySpi, { groups: [] }).summary.groupsRemoved, 1);

/* ---------- diffRequests ---------- */
const changedRequests = [
  { id: "r1", type: "SPI", variant: "full3", instance: null, side: null, fiveVolt: true },
  { id: "r2", type: "ADC", variant: "ch4", instance: "ADC1", side: null, fiveVolt: false },
  { id: "r9", type: "I2C", variant: "std", instance: null, side: null, fiveVolt: false },
];
assert.deepEqual(
  diffRequests(requests, changedRequests).map((row) => `${row.status}:${(row.to || row.from).type}`),
  ["changed:SPI", "same:ADC", "added:I2C", "removed:ETH"],
);
/* fiveVolt 改动必须算作 changed——它是硬约束，漏掉就等于漏掉一处电气变更 */
assert.equal(
  diffRequests(
    [{ id: "a", type: "SPI", variant: "full3", fiveVolt: false }],
    [{ id: "a", type: "SPI", variant: "full3", fiveVolt: true }],
  )[0].status,
  "changed",
);
/* 两份文件各建各的 id 时退回按类型配对 */
assert.deepEqual(
  diffRequests(
    [{ id: "x1", type: "SPI", variant: "full3" }, { id: "x2", type: "I2C", variant: "std" }],
    [{ id: "y1", type: "SPI", variant: "full4" }],
  ).map((row) => `${row.status}:${(row.to || row.from).type}`),
  ["changed:SPI", "removed:I2C"],
);

/* 选型页里的按需器件：工程要记下重新取回它的索引查询，默认目录也要认得
   本次会话已取回的片子——以前这两处都只认固化目录，按需器件一刷新就丢。 */
const runtimeId = "st-test-runtime-lqfp100";
const runtimeQuery = { id: runtimeId, vendor: "st", part: "STM32TESTx", package: "LQFP100" };
registerMcu({ id: runtimeId, partNumber: "STM32TESTx", package: "LQFP100", runtime: true, query: runtimeQuery }, { ...mcu, id: runtimeId });
const runtimeJson = projectToJson(serializeProject({ ...baseState, mcuId: runtimeId, mcuQuery: runtimeQuery }));
assert.deepEqual(JSON.parse(runtimeJson).mcu.query, { vendor: "st", part: "STM32TESTx", package: "LQFP100" });
assert.equal(loadProject(runtimeJson).ok, true, "按需器件的工程应能用默认目录还原");
assert.equal("query" in JSON.parse(json).mcu, false, "固化器件的工程不写 query，旧文件逐字节不变");

/* 旧版"最近使用"存的是转换结果的写法，服务端不认，必须纠正回索引写法 */
assert.deepEqual(await resolveRuntimeQuery(runtimeQuery), runtimeQuery);
assert.equal((await resolveRuntimeQuery({ ...runtimeQuery, vendor: "STMicroelectronics" })).vendor, "st");
assert.equal((await resolveRuntimeQuery({ id: "x", vendor: "Texas Instruments", part: "MSPM0X", package: "LQFP48 (PT)" })).vendor, "ti");

console.log(`Verified project round-trip (${json.length} bytes), stable key order, corrupt-file recovery.`);
console.log("Verified plan diff: instance swap, signal move, pin take/free accounting, and request-row diff.");
