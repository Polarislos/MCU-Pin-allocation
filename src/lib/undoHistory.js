/*
  工程编辑的撤销 / 重做。

  ── 记什么 ──────────────────────────────────────────────────────────
  快照是工程状态的整份引用：需求行、求解器开关、已使用锁定、锁定组，外加
  当时的求解结果和签名。只有前四样（输入）变了才记一步；求解结果是跟着输入
  走的附属品——worker 异步算完写回来时只刷新"当前这一步"的结果，不另记一步。
  这样撤销"锁定这一组"时，方案也一并回到锁定之前，而不是留着一份对不上的
  结果标成"已过期"。

  React 的状态更新本身就是不可变的（改需求行是 map 出新数组、改排除脚是 new Set），
  所以快照存引用即可，不用深拷贝；比较也只比引用。

  ── 边界 ────────────────────────────────────────────────────────────
  换 MCU 时清空历史：撤回到另一颗片子的需求，要连引脚表一起换回去，那是
  "切换器件"而不是"撤销编辑"。同一颗片子上的载入工程、重置都可以撤销。

  这一份是纯函数，useUndoHistory 只是把它接到 React 上；tests/undoHistory.mjs 测这里。
*/
import { useCallback, useEffect, useReducer, useRef } from "react";

export const HISTORY_LIMIT = 100;

export function createHistory() {
  return { past: [], future: [] };
}

/* 输入变了：把变化之前的快照压栈，新的分支一开，重做就作废 */
export function recordChange(history, previous) {
  const past = [...history.past, previous];
  return { past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past, future: [] };
}

/* 返回 { history, target }；没有可撤销的返回 null */
export function undoStep(history, current) {
  if (!history.past.length) return null;
  return {
    history: { past: history.past.slice(0, -1), future: [current, ...history.future] },
    target: history.past[history.past.length - 1],
  };
}

export function redoStep(history, current) {
  if (!history.future.length) return null;
  return {
    history: { past: [...history.past, current], future: history.future.slice(1) },
    target: history.future[0],
  };
}

export function changedKeys(previous, next, keys) {
  return keys.filter((key) => previous[key] !== next[key]);
}

/*
  state     当前快照（每次渲染传新对象即可，比较的是里面各字段的引用）
  inputKeys 哪些字段算"用户的编辑"
  scope     变了就清空历史（当前 MCU 的 id）
  restore   把一份快照写回各个 useState
*/
export function useUndoHistory(state, { inputKeys, scope, restore }) {
  const history = useRef(createHistory());
  const committed = useRef(state);
  const scopeRef = useRef(scope);
  const restoring = useRef(false);
  const [, rerender] = useReducer((count) => count + 1, 0);

  useEffect(() => {
    const previous = committed.current;
    committed.current = state;
    if (scopeRef.current !== scope) {
      scopeRef.current = scope;
      history.current = createHistory();
      restoring.current = false;
      rerender();
      return;
    }
    /* 撤销/重做自己写回的状态不能再被当成一次编辑记进去 */
    if (restoring.current) {
      restoring.current = false;
      return;
    }
    if (changedKeys(previous, state, inputKeys).length === 0) return;
    history.current = recordChange(history.current, previous);
    rerender();
  });

  const step = useCallback((move) => {
    const next = move(history.current, committed.current);
    if (!next) return;
    history.current = next.history;
    restoring.current = true;
    restore(next.target);
    rerender();
  }, [restore]);

  return {
    canUndo: history.current.past.length > 0,
    canRedo: history.current.future.length > 0,
    undo: () => step(undoStep),
    redo: () => step(redoStep),
  };
}
