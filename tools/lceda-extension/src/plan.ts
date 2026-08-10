/*
  规划器导出的「EDA 网络标签 (JSON)」的读取与类型。

  对应 src/lib/export.js 的 toNetLabels。关键字段：
    pinout[]  全部引脚（含电源脚）——核对用的基准，不只是被分配的那些
    labels[]  被分配到功能的脚要打的网络名
    designator 引脚编号。栅格封装上是球号（"E14"），四边封装上是脚号（"23"）。
               和 EDA 的 pinNumber 一样是**字符串**，可以直接比。
*/

export interface PinPlanPin {
  designator: string;
  name: string;
  kind: string;
}

export interface PinPlanLabel {
  designator: string;
  gpio: string;
  net: string;
  peripheral: string;
  signal: string;
  type: string;
  af: number | null;
}

export interface PinPlan {
  format: string;
  version: number;
  generatedAt: string;
  device: {
    partNumber: string;
    package: string;
    packageSize: string;
    pinCount: number;
    source: string;
  };
  pinout: PinPlanPin[];
  labels: PinPlanLabel[];
  warnings: string[];
}

export const TITLE = "引脚规划器";

export function report(lines: string[], title: string = TITLE): void {
  eda.sys_Dialog.showInformationMessage(lines.join("\n"), title, "知道了");
}

/* showConfirmationMessage 是回调式的，包成 Promise 好写。用户直接关掉对话框时
   回调是否触发没有文档保证——真不触发的话命令静默结束，不会留下半成品，因为
   调用点都是"确认了才继续写"。 */
export function confirm(
  lines: string[],
  mainButtonTitle: string,
  cancelButtonTitle = "取消",
  title: string = TITLE,
): Promise<boolean> {
  return new Promise((resolve) => {
    eda.sys_Dialog.showConfirmationMessage(
      lines.join("\n"), title, mainButtonTitle, cancelButtonTitle,
      (mainButtonClicked) => resolve(Boolean(mainButtonClicked)),
    );
  });
}

/* 输入框回调拿到的**永远是字符串**（文档明写：始终为 string，除非点了取消）。
   所以不能靠 typeof 判断有没有输入，只能看是不是 undefined / null / 空串。 */
export function askNumber(
  beforeContent: string,
  afterContent: string,
  value: number,
  bounds: { min: number; max: number },
  title: string = TITLE,
): Promise<number | null> {
  return new Promise((resolve) => {
    eda.sys_Dialog.showInputDialog(
      beforeContent, afterContent, title, "number", value,
      { min: bounds.min, max: bounds.max, step: 1 },
      (input) => {
        if (input === undefined || input === null || input === "") resolve(null);
        else resolve(Number(input));
      },
    );
  });
}

/* showSelectDialog 同样是回调式的。 */
export function askSelect(
  options: Array<{ value: string; displayContent: string }>,
  beforeContent: string,
  title: string = TITLE,
): Promise<string | null> {
  return new Promise((resolve) => {
    eda.sys_Dialog.showSelectDialog(
      options, beforeContent, undefined, title, undefined, false,
      (value) => resolve(value || null),
    );
  });
}

export async function readPlanFile(): Promise<PinPlan | null> {
  /* multiFiles: false 这一路重载返回的是 File | undefined，不是数组 */
  const file = await eda.sys_FileSystem.openReadFileDialog(".json", false);
  if (!file) return null;

  const text = await file.text();
  let plan: PinPlan;
  try {
    plan = JSON.parse(text) as PinPlan;
  } catch (error) {
    report([`这个文件不是合法的 JSON。`, "", String(error)]);
    return null;
  }
  if (plan.format !== "pinplan-netlabels") {
    /* 规划器有两种 .json 产物，文件名区分得不明显：工程存档是
       *.pinplan.json（顶栏「工程 → 保存」），网络标签是
       *-pin-plan.netlabels.json（求解结果面板的「导出」下拉）。选错是常态，
       所以这里不能只说"格式不对"，要直接指路。 */
    report(plan.format === "mcu-pin-planner.project"
      ? [
        "这是引脚规划器的【工程存档】，不是网络标签文件。",
        "",
        "两者都是 .json，注意区分：",
        "    工程存档    xxx.pinplan.json              ← 你选的是这个",
        "    网络标签    xxx-pin-plan.netlabels.json   ← 需要的是这个",
        "",
        "网络标签文件在规划器【右侧求解结果面板】的「导出」下拉里，",
        "选「EDA 网络标签 (JSON)」。要先求解出方案，导出菜单才有内容。",
      ]
      : [
        "这不是引脚规划器导出的网络标签文件。",
        "",
        `期望 format 为 "pinplan-netlabels"，实际是 "${plan.format ?? "（缺失）"}"。`,
        "",
        "在规划器右侧求解结果面板用「导出 → EDA 网络标签 (JSON)」导一份。",
      ]);
    return null;
  }
  if (plan.version !== 1) {
    report([`这份文件的版本是 ${plan.version}，本扩展只认版本 1。`]);
    return null;
  }
  return plan;
}
