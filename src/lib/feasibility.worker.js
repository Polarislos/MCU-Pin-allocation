/*
  组合可行性检查跑在 Worker 里：一次检查可能要展开几次求解，每次最坏几百毫秒，
  "检查本页"还会连着跑几十颗——放在主线程会把选择器冻住。
  labelOf 是函数传不过来，这里直接用 deviceSearch 的 conditionLabel。
*/
import { conditionLabel } from "./deviceSearch.js";
import { checkFeasibility } from "./feasibility.js";

self.onmessage = (event) => {
  const { id, mcu, conditions, options } = event.data;
  try {
    if (!mcu?.pins?.length) throw new Error("未提供有效的 MCU 引脚数据");
    const result = checkFeasibility(mcu, conditions, { ...options, labelOf: conditionLabel });
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
};
