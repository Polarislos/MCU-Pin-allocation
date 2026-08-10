/*
  定位"要操作哪个器件"。核对和应用两条命令共用。
*/

import type { PinPlan } from "./plan.js";
import { askSelect, report } from "./plan.js";

export interface ComponentRow {
  id: string;
  label: string;
  pinCount: number;
}

/* 一次性把页面上的器件连同引脚数读出来。引脚数要逐个器件问，所以这里是
   N 次异步调用——只在需要弹选择器时才值得，但顺带也给"选中了但读不到"的
   情况提供了兜底，所以无条件取一次。 */
export async function listComponents(): Promise<ComponentRow[]> {
  const components = await eda.sch_PrimitiveComponent.getAll();
  const rows: ComponentRow[] = [];
  for (const component of components || []) {
    const id = component.getState_PrimitiveId();
    if (!id) continue;
    const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id);
    const designator = component.getState_Designator() || "?";
    const name = component.getState_Name() || "";
    rows.push({ id, label: name ? `${designator}  ${name}` : designator, pinCount: pins?.length ?? 0 });
  }
  return rows;
}

/*
  读当前选中的器件 ID。

  ⚠ 这个必须在弹出**任何**对话框之前调用。文件选择框是模态的，会把焦点从画布
  上抢走，等它关掉再来读，选中往往已经被清空了——表现就是"我明明选中了、还高亮
  着，却说没选"。

  用 getAllSelectedPrimitives_PrimitiveId 而不是 getSelectedPrimitives_PrimitiveId：
  后者在类型定义里标着 @deprecated。

  点一下器件，选中集里可能不止器件本身（还有位号、型号这些附属图元），所以不能
  看到多个就报错——要和页面上的器件列表求交集。
*/
export async function readSelectedComponentIds(componentIds: Set<string>): Promise<string[]> {
  const selected = await eda.sch_SelectControl.getAllSelectedPrimitives_PrimitiveId();
  return (selected || []).filter((id) => componentIds.has(id));
}

/*
  优先用选中的器件，没有就让用户从列表里挑。

  列表里带上引脚数，并把"脚数和方案一致"的排在最前——在几十个器件的图上，
  这一条比位号更能一眼认出哪个是目标 MCU。
*/
export async function resolveTargetComponent(
  components: ComponentRow[],
  preselected: string[],
  plan: PinPlan,
  title: string,
): Promise<string | null> {
  if (preselected.length === 1) return preselected[0];

  const pool = preselected.length > 1
    ? components.filter((item) => preselected.includes(item.id))
    : components;

  if (pool.length === 0) {
    report(["当前原理图页上没有找到任何器件。"], title);
    return null;
  }
  if (pool.length === 1) return pool[0].id;

  /* 脚数匹配的排前面，其余按位号 */
  const ranked = [...pool].sort((left, right) => {
    const leftHit = left.pinCount === plan.device.pinCount ? 0 : 1;
    const rightHit = right.pinCount === plan.device.pinCount ? 0 : 1;
    return leftHit - rightHit || left.label.localeCompare(right.label);
  });

  return askSelect(
    ranked.map((item) => ({
      value: item.id,
      displayContent: `${item.label}  ·  ${item.pinCount} 脚${
        item.pinCount === plan.device.pinCount ? "  ← 脚数匹配" : ""}`,
    })),
    preselected.length > 1
      ? `选中了 ${preselected.length} 个器件，挑一个：`
      : `没有检测到选中的器件。方案是 ${plan.device.partNumber}（${plan.device.pinCount} 脚），挑一个：`,
    title,
  );
}
