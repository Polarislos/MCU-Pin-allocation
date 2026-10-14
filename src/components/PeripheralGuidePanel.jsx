import { useEffect, useRef } from "react";
import { CAPABILITY_CATEGORIES } from "../lib/capabilities.js";
import { peripheralFunctions } from "../lib/peripherals.js";
import { compactSignals, usageById } from "../lib/peripheralUsage.js";
import { checkGuideUsage } from "../lib/guideUsageCheck.js";
import PeripheralModesSection from "./PeripheralModesSection.jsx";
import { GUIDE_COMPARISONS, GUIDE_USE_CASES } from "../data/peripheralGuides/phase2.js";
import { guidePlannerTemplate, usagePlannerTemplate } from "../data/peripheralGuides/phase3.js";
function ConnectionDiagram({ parts, title }) {
  return <figure className="guide-diagram"><figcaption>{title} · 连接概念示意</figcaption><div>
    {parts.map((part, index) => <span key={part} className="guide-diagram-step"><span className="guide-diagram-box">{part}</span>{index < parts.length - 1 && <span className="guide-diagram-arrow" aria-hidden="true">→</span>}</span>)}
  </div><small>示意图只表示数据/控制关系，不代表完整原理图或引脚分配。</small></figure>;
}
export default function PeripheralGuidePanel({ guide, mcu, mcuVendor, onClose, onSearch, onSearchUsage, onPlanTemplate, onPlanUsage, plannerTypes = [] }) {
  const dialog = useRef(null);
  useEffect(() => {
    if (!guide) return;
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); previous?.focus?.(); };
  }, [guide]);
  if (!guide) return null;
  const isSt = mcuVendor === "STMicroelectronics";
  const types = (isSt ? guide.st : guide.ti)?.types || [];
  const rows = mcu ? types.flatMap((type) => {
    const names = new Set(mcu.pins.flatMap((pin) => [...(pin.functions || []).map((f) => f.signal || f.name || ""), ...(pin.additionalFunctions || [])]).filter((name) => name.startsWith(type + "_") || new RegExp("^" + type + "[0-9]+_").test(name)).map((name) => name.split("_")[0]));
    return [...names].map((name) => ({ name, count: peripheralFunctions(mcu, name).length }));
  }) : [];
  const useCases = GUIDE_USE_CASES[guide.id] || [];
  const comparisons = GUIDE_COMPARISONS[guide.id] || [];
  const plannerTemplate = guidePlannerTemplate(guide.id);
  const usageResults = useCases.map((item) => {
    const usage = usageById(item.usage);
    return { ...item, usage, ...(isSt ? checkGuideUsage(mcu, usage) : { checks: [], matches: [], partial: [] }) };
  });
  return <dialog ref={dialog} className="peripheral-guide-dialog" aria-labelledby="guide-title" onCancel={onClose} onClick={(event) => { if (event.target === dialog.current) onClose(); }}>
    <article className="peripheral-guide-content">
      <header><div><small>外设介绍 · {CAPABILITY_CATEGORIES.find((category) => category.id === guide.category)?.label}</small><h2 id="guide-title">{guide.label}</h2></div><button type="button" onClick={onClose} aria-label="关闭外设介绍">关闭</button></header>
      <p className="guide-summary">{guide.summary}</p>
      <h3>什么时候用</h3><p>{guide.uses}</p>
      <h3>连接与信号</h3><p>{guide.signals}</p><p>这里描述通用信号类别，具体接线以所选型号的数据手册和引脚表为准。</p>
      <PeripheralModesSection id={guide.id} compact />
      <h3>选型要确认</h3><p>{guide.caution}</p>
      {comparisons.length > 0 && <section className="guide-comparisons"><h3>相近外设怎么选</h3>{comparisons.map((comparison) => <article key={comparison.title}><strong>{comparison.title}</strong><div><p>{comparison.left}</p><p>{comparison.right}</p></div></article>)}</section>}
      {useCases.length > 0 && <section className="guide-use-cases"><h3>常见接法与当前封装检查</h3><p className="guide-coverage-note">用途信号检查目前按 STM32 CubeMX 信号规则执行；结果只表示该封装有候选信号，不保证与其他接口同时使用时无冲突。未覆盖的厂商或外设会显示未知。</p>{usageResults.map((item) => {
        const template = usagePlannerTemplate(item.usage);
        return <article key={item.usage}><h4>{item.title}</h4><ConnectionDiagram parts={item.parts} title={item.title} />
        {!mcu ? <p>加载目标 MCU 的引脚表后可检查该用途。</p> : !isSt ? <p>当前用途规则仅覆盖 STM32 CubeMX 信号名；TI 的对应接法尚未核实，结果为未知。</p> : item.matches.length ? <p className="guide-check-ok">信号检查通过：{item.matches.map(({ entry }) => entry.instance).join("、")}。这只确认所需信号在此封装有候选脚。</p> : item.partial.length ? <p className="guide-check-missing">当前封装未找到完整信号组；缺少：{compactSignals([...new Set(item.partial.flatMap(({ result }) => result.missing || []))])}。</p> : <p>当前型号数据没有该用途的信号检查结果，不能据此判定外设不支持。</p>}
        <button type="button" className="linklike" onClick={() => onSearchUsage?.(item.usage)}>按此用途筛选 MCU →</button>
        {template && plannerTypes.includes(template.type) && <button type="button" className="linklike" onClick={() => onPlanUsage?.(template, item.title)}>加入引脚规划器 →</button>}
        {template && !plannerTypes.includes(template.type) && <small className="peripheral-directory-note">当前 MCU 未识别到该模板所需的可规划外设</small>}
        {!template && <small className="peripheral-directory-note">此用途暂未配置直接引脚规划模板</small>}
      </article>;
      })}</section>}
      <section className="guide-device"><h3>当前引脚规划器件</h3><p>{mcu ? `${mcu.partNumber} · ${mcu.package}` : "器件数据尚未加载"}</p>
      {rows.length ? <p>已加载引脚表识别到：{rows.map((row) => `${row.name}（${row.count} 种信号）`).join("、")}。</p> : guide.signals.includes("内部功能") ? <p>这是片内功能，没有专属外部引脚。</p> : <p>当前数据库和封装引脚表未确认对应信号，不能据此认定器件不支持。</p>}
      <p>外设存在、具体接法与多接口无冲突分配，请在型号搜索中的能力、用途和组合检查中分别确认。</p></section>
      <footer><button type="button" className="primary-button" onClick={() => onSearch(guide)}>查找带此外设的 MCU</button>
        {plannerTemplate && plannerTypes.includes(plannerTemplate.type) && <button type="button" className="secondary-button" onClick={() => onPlanTemplate?.(plannerTemplate, guide.label)}>加入引脚规划器</button>}
        {plannerTemplate && !plannerTypes.includes(plannerTemplate.type) && <small className="peripheral-directory-note">当前 MCU 未识别到 {plannerTemplate.type} 规划实例</small>}
        {!plannerTemplate && <small className="peripheral-directory-note">此外设目前没有直接的普通引脚规划模板</small>}
        <a href={guide.source} target="_blank" rel="noreferrer">ST 官方参考资料 ↗</a></footer>
      <small>官方资料用于了解原理和示例器件。最终能力以目标型号及封装的数据手册为准。</small>
    </article>
  </dialog>;
}
