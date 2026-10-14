/*
  撤销 / 重做的栈逻辑（src/lib/undoHistory.js 的纯函数部分）。
  React 那层（useUndoHistory）只是在渲染后比较引用、调用这些函数。
*/
import assert from "node:assert/strict";
import { HISTORY_LIMIT, changedKeys, createHistory, recordChange, redoStep, undoStep } from "../src/lib/undoHistory.js";

const KEYS = ["requests", "options", "excludedPins", "lockedGroups"];
const snap = (requests, extra = {}) => ({
  requests, options: { protectDebug: true }, excludedPins: new Set(), lockedGroups: [], result: null, ...extra,
});

/* 只有输入字段的引用变了才算一次编辑；求解结果单独变化不算 */
const a = snap(["SPI"]);
assert.deepEqual(changedKeys(a, { ...a, result: { solutions: [] } }, KEYS), []);
assert.deepEqual(changedKeys(a, { ...a, requests: ["SPI", "I2C"] }, KEYS), ["requests"]);
assert.deepEqual(changedKeys(a, { ...a, excludedPins: new Set() }, KEYS), ["excludedPins"], "新 Set 就是一次修改，不比内容");

/* 撤销 → 重做往返 */
const b = snap(["SPI", "I2C"]);
const c = snap(["SPI", "I2C", "UART"]);
let history = recordChange(recordChange(createHistory(), a), b);
let step = undoStep(history, c);
assert.equal(step.target, b);
step = undoStep(step.history, step.target);
assert.equal(step.target, a);
assert.equal(undoStep(step.history, step.target), null, "撤销到底返回 null");
step = redoStep(step.history, a);
assert.equal(step.target, b);
step = redoStep(step.history, b);
assert.equal(step.target, c);
assert.equal(redoStep(step.history, c), null);

/* 撤销后再编辑：重做分支作废 */
history = recordChange(createHistory(), a);
step = undoStep(history, b);
history = recordChange(step.history, a);
assert.equal(history.future.length, 0);
assert.equal(redoStep(history, snap(["CAN"])), null);

/* 快照带着当时的求解结果：撤销"锁定这一组"时方案一起回退 */
const solved = snap(["SPI"], { result: { solutions: ["before-lock"] } });
const locked = { ...solved, lockedGroups: [{ type: "SPI" }], result: { solutions: ["after-lock"] } };
step = undoStep(recordChange(createHistory(), solved), locked);
assert.deepEqual(step.target.result.solutions, ["before-lock"]);

/* 上限：只留最近 HISTORY_LIMIT 步 */
history = createHistory();
for (let index = 0; index < HISTORY_LIMIT + 20; index += 1) history = recordChange(history, snap([index]));
assert.equal(history.past.length, HISTORY_LIMIT);
assert.deepEqual(history.past[0].requests, [20], "丢的是最早的");

console.log("undo history: record, undo/redo round trip, branch reset, result snapshot, limit ok");
