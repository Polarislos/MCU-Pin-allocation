/*
  分配求解跑在 Worker 里：最坏情况（跑满节点预算判定无解）要 700ms 以上，
  放在主线程会把整个界面冻住。MCU 数据由主线程根据当前目录项传入，
  Worker 不再绑定单一 MCU，选择不同型号时可以复用同一个求解器实例。
*/
import { allocatePins } from "./allocator.js";

self.onmessage = (event) => {
  const { id, mcu, requirements, options, lockedGroups } = event.data;
  const started = performance.now();
  try {
    if (!mcu?.pins?.length) throw new Error("未提供有效的 MCU 引脚数据");
    const result = allocatePins(mcu, requirements, options, lockedGroups);
    self.postMessage({ id, result: { ...result, elapsed: Math.round(performance.now() - started) } });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
};
