import PageNavigation from "./PageNavigation.jsx";
import { useEffect, useMemo, useState } from "react";
import PeripheralModesSection from "./PeripheralModesSection.jsx";
import { GUIDE_COMPARISONS, GUIDE_USE_CASES } from "../data/peripheralGuides/phase2.js";
import { guidePlannerTemplate, usagePlannerTemplate } from "../data/peripheralGuides/phase3.js";
import { DIRECTORY_CATEGORIES, PERIPHERAL_DIRECTORY, peripheralDirectoryCategory } from "../data/peripheralGuides/directory.js";
import { compactSignals, usageById } from "../lib/peripheralUsage.js";
import { checkGuideUsage } from "../lib/guideUsageCheck.js";
import { CAPABILITIES, capabilityById, matchCapability } from "../lib/capabilities.js";
import { PERIPHERAL_GROUPS, profileOf } from "../lib/deviceSearch.js";

function readDirectoryState() {
  if (typeof window === "undefined") return { query: "", category: "all", id: "" };
  const hash = window.location.hash;
  const queryAt = hash.indexOf("?");
  const params = new URLSearchParams(queryAt === -1 ? "" : hash.slice(queryAt + 1));
  return {
    query: params.get("q") || "",
    category: DIRECTORY_CATEGORIES.some((item) => item.id === params.get("category")) ? params.get("category") : "all",
    id: params.get("id") || "",
  };
}

function GuideCard({ guide, selected, onSelect }) {
  return <button type="button" className={`peripheral-directory-card${selected ? " is-selected" : ""}`} aria-pressed={selected} onClick={onSelect}>
    <span className="peripheral-directory-card-heading"><strong>{guide.label}</strong></span>
    <span className="peripheral-directory-card-summary">{guide.summary}</span>
  </button>;
}

function ConnectionDiagram({ title, parts }) {
  return <div className="peripheral-directory-diagram" aria-label={`${title}连接关系`}>
    {parts.map((part, index) => <span key={`${part}-${index}`}>
      <strong>{part}</strong>{index < parts.length - 1 && <span aria-hidden="true">→</span>}
    </span>)}
  </div>;
}

function deviceVendorKey(record) {
  if (record?.id?.startsWith("st-")) return "st";
  if (record?.id?.startsWith("ti-")) return "ti";
  return null;
}

function normalizePackage(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function partMatches(indexPart, selectedPart) {
  const pattern = String(indexPart || "").toUpperCase();
  const selected = String(selectedPart || "").toUpperCase();
  if (!pattern || !selected) return false;
  if (pattern === selected) return true;
  /* CubeMX stores family suffixes as x placeholders, e.g. VITx for VIT6. */
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/X$/, ".");
  return new RegExp(`^${escaped}$`, "i").test(selected);
}

function findCurrentDevice(index, record) {
  const vendor = deviceVendorKey(record);
  if (!index?.devices || !vendor || !record?.partNumber) return null;
  const selectedPackage = normalizePackage(record.package);
  return index.devices.find((device) => device.id === record.id)
    || index.devices.find((device) => device.vendor === vendor
      && normalizePackage(device.package) === selectedPackage
      && partMatches(device.part, record.partNumber))
    || null;
}

function capabilityFromProfile(guide, profile, vendor, mcu) {
  if (guide.id === "gpio") {
    const count = mcu?.pins?.filter((pin) => pin.kind === "gpio").length || 0;
    return count ? { status: "listed", instances: [], source: "package", count } : { status: "unknown", instances: [], source: "package" };
  }
  if (!profile) return { status: "unknown", instances: [] };
  const condition = guide.searchCondition || { kind: "capability", value: guide.id, min: 1 };
  if (condition.kind === "capability") {
    const capability = capabilityById(condition.value) || CAPABILITIES.find((item) => item.id === guide.id);
    const matches = matchCapability(capability, vendor, profile);
    if (matches === null) return { status: "unknown", instances: [] };
    return { status: matches.length ? "listed" : "not-listed", instances: matches };
  }
  if (condition.kind === "group") {
    const group = PERIPHERAL_GROUPS.find((item) => item.id === condition.value);
    if (!group) return { status: "unknown", instances: [] };
    const matches = profile.filter((item) => group.types.includes(item.type));
    return { status: matches.length ? "listed" : "not-listed", instances: matches };
  }
  if (condition.kind === "type") {
    const matches = profile.filter((item) => item.type === condition.value || item.name === condition.value);
    return { status: matches.length ? "listed" : "not-listed", instances: matches };
  }
  return { status: "unknown", instances: [] };
}

function inspectUsage(mcu, vendor, usageId) {
  const usage = usageById(usageId);
  if (!mcu || !usage || vendor !== "st") return { status: "unknown", detail: "此用途的封装信号规则目前只覆盖 STM32。" };
  const result = checkGuideUsage(mcu, usage);
  if (result.matches.length) {
    return { status: "matched", detail: `当前封装找到候选信号组：${result.matches.map(({ entry }) => entry.instance).join("、")}。` };
  }
  if (result.partial.length) {
    const missing = compactSignals([...new Set(result.partial.flatMap(({ result: check }) => check.missing || []))]);
    return { status: "partial", detail: `当前封装未找到完整信号组${missing ? `；缺少：${missing}` : ""}。` };
  }
  return { status: "unknown", detail: "当前引脚档案没有该用途的可检查实例，不能据此判定外设不支持。" };
}

function PeripheralDetails({ guide, onClose, onSearch, onSearchUsage, onPlanTemplate, onPlanUsage, mcu, mcuRecord, plannerTypes, capability, indexDate }) {
  if (!guide) return <div className="peripheral-directory-empty"><strong>选择一个外设</strong><p>查看它的作用、常见应用和选型注意事项。</p></div>;
  const useCases = GUIDE_USE_CASES[guide.id] || [];
  const comparisons = GUIDE_COMPARISONS[guide.id] || [];
  const canSearch = Boolean(guide.searchCondition || guide.st || guide.ti);
  const template = guidePlannerTemplate(guide.id);
  const templateAvailable = Boolean(template && plannerTypes?.includes(template.type));
  const vendor = deviceVendorKey(mcuRecord);
  const capabilityLabel = capability?.status === "listed"
    ? capability.source === "package"
      ? `当前封装引脚档案包含 ${capability.count} 个 GPIO 引脚。`
      : `本机外设索引列出：${capability.instances.map((item) => item.name).join("、")}`
    : capability?.status === "not-listed"
      ? "本机外设索引未列出此项；请结合官方资料复核。"
      : "当前索引数据无法确认此项能力。";
  return <article className="peripheral-directory-details">
    <div className="peripheral-directory-detail-eyebrow">{peripheralDirectoryCategory(guide.directoryCategory)}</div>
    <h2>{guide.label}</h2>
    <p className="peripheral-directory-lead">{guide.summary}</p>
    <section className={`peripheral-directory-current-mcu is-${capability?.status || "unknown"}`} aria-label="当前 MCU 外设能力">
      <div><h3>当前 MCU · {mcuRecord?.partNumber || "未知型号"}</h3><span>{mcuRecord?.package || "封装未知"}</span></div>
      <p>{capabilityLabel}</p>
      <details className="peripheral-directory-evidence"><summary>数据依据与说明</summary>
        {capability?.status === "listed" && <p>{capability.source === "package" ? "GPIO 数量来自当前封装引脚档案。" : "索引实例/名称仅证明器件档案中列出了该外设；不等于当前封装能完成指定接法。"}</p>}
        {indexDate && <p>本机外设索引生成于 {indexDate}</p>}
      </details>
    </section>
    <section><h3>常见应用</h3><p>{guide.uses}</p></section>
    <PeripheralModesSection id={guide.id} />
    <section><h3>典型信号与连接</h3><p>{guide.signals}</p><small>这里介绍的是通用信号类别；具体信号名称、引脚和电气条件请以目标型号资料为准。</small></section>
    {useCases.length > 0 && <section className="peripheral-directory-use-cases">
      <h3>典型接法</h3>
      {useCases.map((item) => {
        const usage = usageById(item.usage);
        const useCheck = inspectUsage(mcu, vendor, item.usage);
        const useTemplate = usagePlannerTemplate(item.usage);
        const canPlanUse = Boolean(useTemplate && plannerTypes?.includes(useTemplate.type));
        return <article key={item.usage}>
          <strong>{item.title}</strong>
          <ConnectionDiagram title={item.title} parts={item.parts} />
          {usage && <>
            <p className={`peripheral-directory-usage-check is-${useCheck.status}`}>{useCheck.detail}候选信号检查不代表多个外设可以同时无冲突分配。</p>
            <div className="peripheral-directory-use-actions">
              <button type="button" className="linklike" onClick={() => onSearchUsage?.(usage)}>按此用途查找 MCU →</button>
              {canPlanUse && <button type="button" className="linklike" onClick={() => onPlanUsage?.(useTemplate, item.title)}>加入引脚规划器 →</button>}
              {useTemplate && !canPlanUse && <small className="peripheral-directory-note">当前 MCU 未识别到该模板所需的可规划外设</small>}
              {!useTemplate && <small className="peripheral-directory-note">此用途暂未配置直接引脚规划模板</small>}
            </div>
          </>}
        </article>;
      })}
    </section>}
    {comparisons.length > 0 && <section className="peripheral-directory-comparisons">
      <h3>相近接口对比</h3>
      {comparisons.map((comparison) => <article key={comparison.title}><strong>{comparison.title}</strong><p>{comparison.left}</p><p>{comparison.right}</p></article>)}
    </section>}
    <section><h3>选型注意</h3><p>{guide.caution || "确认目标型号的数据手册、参考手册和封装引脚表。"}</p></section>
    <footer>
      {canSearch && <button type="button" className="primary-button" onClick={() => onSearch(guide)}>查找带此外设的 MCU</button>}
      {templateAvailable && <button type="button" className="secondary-button" onClick={() => onPlanTemplate?.(template, guide.label)}>加入引脚规划器</button>}
      {template && !templateAvailable && <span className="peripheral-directory-note">当前 MCU 未识别到 {template.type} 规划实例</span>}
      {!template && <span className="peripheral-directory-note">此外设目前没有直接的普通引脚规划模板</span>}
      {guide.id === "gpio" && <><span className="peripheral-directory-note">GPIO 是引脚级功能，当前目录提供基础说明。</span><button type="button" className="secondary-button" onClick={onClose}>进入引脚规划器</button></>}
      {guide.source && <a href={guide.source} target="_blank" rel="noreferrer">参考资料 ↗</a>}
    </footer>
    <small className="peripheral-directory-note">厂商和系列之间的外设能力可能不同；请按具体型号与封装确认。</small>
  </article>;
}

export default function PeripheralDirectoryPage({ onNavigate, onClose, onSearch, onSearchUsage, onPlanTemplate, onPlanUsage, mcu, mcuRecord, plannerTypes = [] }) {
  const initial = useMemo(readDirectoryState, []);
  const [query, setQuery] = useState(initial.query);
  const [category, setCategory] = useState(initial.category);
  const [selectedId, setSelectedId] = useState(initial.id);
  const [deviceIndex, setDeviceIndex] = useState(null);

  useEffect(() => {
    let cancelled = false;
    import("../data/deviceIndex.json")
      .then((module) => { if (!cancelled) setDeviceIndex(module.default); })
      .catch(() => { if (!cancelled) setDeviceIndex(null); });
    return () => { cancelled = true; };
  }, []);

  const visibleGuides = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return PERIPHERAL_DIRECTORY.filter((guide) => {
      if (category !== "all" && guide.directoryCategory !== category) return false;
      if (!needle) return true;
      return [guide.label, guide.summary, guide.uses, guide.signals, peripheralDirectoryCategory(guide.directoryCategory), ...(guide.keywords || [])]
        .some((value) => String(value || "").toLocaleLowerCase().includes(needle));
    });
  }, [category, query]);

  const selectedGuide = visibleGuides.find((guide) => guide.id === selectedId) || visibleGuides[0] || null;
  const currentDevice = useMemo(() => findCurrentDevice(deviceIndex, mcuRecord), [deviceIndex, mcuRecord]);
  const currentProfile = useMemo(() => (deviceIndex && currentDevice ? profileOf(deviceIndex, currentDevice) : null), [deviceIndex, currentDevice]);
  const currentCapability = useMemo(() => (selectedGuide
    ? capabilityFromProfile(selectedGuide, currentProfile, deviceVendorKey(mcuRecord), mcu)
    : { status: "unknown", instances: [] }), [currentProfile, mcu, mcuRecord, selectedGuide]);
  const counts = useMemo(() => {
    const result = new Map(DIRECTORY_CATEGORIES.map((item) => [item.id, 0]));
    for (const guide of PERIPHERAL_DIRECTORY) result.set(guide.directoryCategory, (result.get(guide.directoryCategory) || 0) + 1);
    result.set("all", PERIPHERAL_DIRECTORY.length);
    return result;
  }, []);

  useEffect(() => {
    if (selectedGuide && selectedGuide.id !== selectedId) setSelectedId(selectedGuide.id);
    else if (!selectedGuide && selectedId) setSelectedId("");
  }, [selectedGuide, selectedId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (category !== "all") params.set("category", category);
    if (selectedGuide) params.set("id", selectedGuide.id);
    const suffix = params.size ? `?${params.toString()}` : "";
    const hash = `#/peripherals${suffix}`;
    if (window.location.hash !== hash) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
    }
  }, [category, query, selectedGuide]);

  return <section className="peripheral-directory-page" aria-label="外设总览">
    <header className="peripheral-directory-header">
      <PageNavigation activePage="peripherals" onNavigate={onNavigate} />
      <div><small>PERIPHERAL LIBRARY</small><h1>外设总览</h1></div>
      <span>{PERIPHERAL_DIRECTORY.length} 项 · 说明与应用</span>
    </header>
    <div className="peripheral-directory-layout">
      <nav className="peripheral-directory-categories" aria-label="外设分类">
        <div><strong>分类</strong><span>{visibleGuides.length} 项</span></div>
        {DIRECTORY_CATEGORIES.map((item) => <button key={item.id} type="button" className={category === item.id ? "is-active" : ""} aria-current={category === item.id ? "page" : undefined} onClick={() => setCategory(item.id)}>
          <span>{item.label}</span><small>{counts.get(item.id) || 0}</small>
        </button>)}
        <p>目录包含通用接口和器件特有功能。具体能力依 MCU 型号与封装而异。</p>
      </nav>
      <section className="peripheral-directory-results" aria-label="外设列表">
        <div className="peripheral-directory-searchbar">
          <label htmlFor="peripheral-directory-search">搜索外设、用途或信号</label>
          <input id="peripheral-directory-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：SPI、摄像头、采样、外部存储" />
          <span>{visibleGuides.length} 项</span>
        </div>
        {visibleGuides.length ? <div className="peripheral-directory-grid">
          {visibleGuides.map((guide) => <GuideCard key={guide.id} guide={guide} selected={guide.id === selectedGuide?.id} onSelect={() => setSelectedId(guide.id)} />)}
        </div> : <div className="peripheral-directory-no-results"><strong>没有找到匹配的外设</strong><p>试试外设缩写、中文名称或应用关键词。</p></div>}
      </section>
      <aside className="peripheral-directory-detail-pane" aria-label="外设详情" key={selectedGuide?.id || "empty"}>
        <PeripheralDetails guide={selectedGuide} onClose={onClose} onSearch={onSearch} onSearchUsage={onSearchUsage}
          onPlanTemplate={onPlanTemplate} onPlanUsage={onPlanUsage} mcu={mcu} mcuRecord={mcuRecord} plannerTypes={plannerTypes}
          capability={currentCapability} indexDate={deviceIndex?.generatedAt} />
      </aside>
    </div>
  </section>;
}
