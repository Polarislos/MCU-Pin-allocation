import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFINITIONS, PERIPHERAL_TYPE_ORDER, SIDES, createRequest, instancesForType, isFiveVoltTolerant,
  protocolForFunction, supportsFiveVolt,
} from "./lib/allocator.js";
import { EXPORT_FORMATS, downloadSolution } from "./lib/export.js";
import { decodeFanoutFile, encodeFanoutFile, fanoutFileName, fillFanout } from "./lib/fanout.js";
import {
  TIMER_MODE_LABELS, buildPeripheralCatalog, isPeripheralPin, peripheralFunctions, requestTypesFor,
} from "./lib/peripherals.js";
import { packageLayout } from "./lib/package.js";
import {
  DEFAULT_MCU_ID, MCU_CATALOG, catalogLabel, ensureMcuLoaded, fetchRuntimeMcu, getMcuById, isMcuLoaded,
} from "./lib/mcuCatalog.js";
import { MODULE_CATALOG } from "./data/moduleCatalog.js";
import { analysisToRequestRows, analyzeRequirementsText } from "./lib/ai/assistant.js";
import { analyzeRequirementsRemote } from "./lib/ai/remote.js";
import { applyTheme, readThemeMode, resolveTheme, watchAutoTheme, writeThemeMode } from "./lib/theme.js";
import { readPreferences, rememberMcu, writePreferences } from "./lib/preferences.js";
import Tour from "./components/Tour.jsx";
import PersonalCenter from "./components/PersonalCenter.jsx";
import { loadProject, parseProject, projectFileName, projectToJson, serializeProject } from "./lib/project.js";
import { diffPlans, diffRequests, isEmptyDiff } from "./lib/diff.js";

const AI_CONFIG_STORAGE_KEY = "mcu-pin-planner.ai-config.v1";
const PROJECT_STORAGE_KEY = "mcu-pin-planner.project.v1";

/*
  挂载前要预加载哪颗片子的引脚表。只解析出 mcuId，不做完整校验——
  真正的还原仍然走 readStoredProject()，这里错了最多是多下一份数据。
*/
export function bootstrapMcuId() {
  if (typeof window === "undefined") return DEFAULT_MCU_ID;
  try {
    /* 优先级：上次的工程 > 个人中心设的默认器件 > 内置默认。
       工程排第一是因为"接着上次改"比"每次都开同一颗"更常见；个人中心那项
       解决的是"我这块板子就用这颗，别老给我开 H743"。 */
    const stored = JSON.parse(window.localStorage.getItem(PROJECT_STORAGE_KEY) || "null");
    const fromProject = stored?.mcu?.id;
    if (MCU_CATALOG.some((item) => item.id === fromProject)) return fromProject;
    const preferred = readPreferences().defaultMcuId;
    return MCU_CATALOG.some((item) => item.id === preferred) ? preferred : DEFAULT_MCU_ID;
  } catch {
    return DEFAULT_MCU_ID;
  }
}

/* 上次的工作状态。刷新就丢是这个工具最大的短板——存不下就没法进评审流程。
   任何解析失败都静默回落到默认状态：一份坏数据不该让页面打不开。 */
function readStoredProject() {
  if (typeof window === "undefined") return null;
  try {
    const text = window.localStorage.getItem(PROJECT_STORAGE_KEY);
    if (!text) return null;
    const loaded = loadProject(text);
    return loaded.ok ? loaded.value : null;
  } catch {
    return null;
  }
}

/* 保存下来的方案不是"刚跑出来的求解结果"——它没有 visited / poolSize 这些
   搜索元信息，也不该冒充。用 restored 标记出来，结果面板会换一句说明。 */
function restoredResult(plan) {
  return plan ? { solutions: [plan], restored: true, visited: 0, poolSize: 1, droppedLocks: [] } : null;
}

function createDefaultRequests(requestTypes) {
  const preferred = ["SPI", "I2C", "UART"].filter((type) => requestTypes.includes(type));
  const types = preferred.length ? preferred : requestTypes.slice(0, 3);
  return types.map((type) => createRequest(type));
}

function readAiConfig() {
  const defaults = { enabled: false, endpoint: "", model: "", apiKey: "" };
  if (typeof window === "undefined") return defaults;
  try {
    const stored = JSON.parse(window.localStorage.getItem(AI_CONFIG_STORAGE_KEY) || "null");
    return { ...defaults, ...(stored || {}), apiKey: "" };
  } catch {
    return defaults;
  }
}

/* 描述"当前这套输入"。结果面板拿它和生成结果时的快照比对，
   不一致就说明屏幕上的方案已经过期。
   任何会改变求解输入的字段都必须计入——漏掉一个（比如 5V 这种硬约束），
   用户改了它却看不到"已过期"，就会照着一份不再成立的方案画板子。 */
export function inputSignature(requests, options, excludedPins, lockedGroups) {
  return JSON.stringify({
    requests: requests.map((request) => [
      request.id, request.type, request.variant, request.instance, request.side, Boolean(request.fiveVolt),
    ]),
    options: { protectDebug: options.protectDebug, protectOscillator: options.protectOscillator },
    excluded: [...excludedPins].sort((left, right) => left - right),
    locks: lockedGroups.map((group) => `${group.type}:${group.instance}`).sort(),
  });
}

/* 工程文件里的 MCU 可能还没加载过引脚表——先取回来再还原，
   否则 hydrateProject 会把工程里每个引脚都判成"不存在"。 */
async function loadProjectFile(file) {
  const text = await file.text();
  const parsed = parseProject(text);
  if (parsed.ok) {
    try {
      await ensureMcuLoaded(parsed.value.mcu.id);
    } catch {
      return { ok: false, errors: [`MCU「${parsed.value.mcu.id}」的引脚数据加载失败`], warnings: [], value: null };
    }
  }
  return loadProject(text);
}

/* 一行 = 一路接口。变体、指定实例、方位偏好都是逐路独立的——
   实际板子上 UART1 接蓝牙要流控、UART2 是调试口不要，二者必须能共存。 */
function RequestRow({ mcu, request, index, onChange, onRemove, typeOrder = PERIPHERAL_TYPE_ORDER }) {
  const definition = DEFINITIONS[request.type];
  const instances = useMemo(() => instancesForType(mcu, request.type), [mcu, request.type]);
  const variants = Object.entries(definition.variants);
  /* 两边封装（SOIC/TSSOP）没有顶边和底边可言，就不该给出这两个选项——
     那是一个永远满足不了的偏好。 */
  const sides = packageLayout(mcu).availableSides;
  /* 器件数据分不出耐压等级时（MSPM0 全是 STD）不给这个开关——
     没有依据就不该让用户以为约束生效了。 */
  const fiveVoltAvailable = supportsFiveVolt(mcu);

  function update(patch) {
    onChange({ ...request, ...patch });
  }

  return (
    <div className={`request-row request-${definition.protocol}`}>
      <div className="request-head">
        <span className="request-index">{index + 1}</span>
        <select
          aria-label="接口类型"
          value={request.type}
          onChange={(event) => {
            const type = event.target.value;
            update({ type, variant: DEFINITIONS[type].defaultVariant, instance: null });
          }}
        >
          {typeOrder.map((type) => <option key={type} value={type}>{DEFINITIONS[type].label}</option>)}
        </select>
        <button type="button" className="request-remove" aria-label={`删除第 ${index + 1} 路接口`} onClick={onRemove}>×</button>
      </div>
      <div className="request-body">
        <label>
          <span>接线</span>
          <select value={request.variant} onChange={(event) => update({ variant: event.target.value })}>
            {variants.map(([id, variant]) => <option key={id} value={id}>{variant.label}</option>)}
          </select>
        </label>
        <label>
          <span>实例</span>
          <select value={request.instance || ""} onChange={(event) => update({ instance: event.target.value || null })}>
            <option value="">自动选择</option>
            {instances.map((instance) => <option key={instance} value={instance}>{instance}</option>)}
          </select>
        </label>
        <label>
          <span>靠近</span>
          <select value={request.side || ""} onChange={(event) => update({ side: event.target.value || null })}>
            <option value="">不限方位</option>
            {sides.map((side) => <option key={side} value={side}>{SIDES[side].label}</option>)}
          </select>
        </label>
        {fiveVoltAvailable && (
          <label className="request-flag" title="这一路接 5V 电平，只从耐 5V 的引脚里选（硬约束）">
            <span>电平</span>
            <span className="request-flag-box">
              <input
                type="checkbox"
                aria-label={`第 ${index + 1} 路接 5V 电平`}
                checked={Boolean(request.fiveVolt)}
                onChange={(event) => update({ fiveVolt: event.target.checked })}
              />
              <b>5V 容忍</b>
            </span>
          </label>
        )}
      </div>
    </div>
  );
}

function Toggle({ checked, onChange, children }) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-track" aria-hidden="true"><span /></span>
      <span>{children}</span>
    </label>
  );
}

/*
  器件选择器。

  目录里固化的只有几颗，但本机的 CubeMX / SysConfig 库里有三千多个型号可选，
  所以这里是"下拉选常用 + 搜索选任意一颗"两条路：

  - 下拉：固化进 src/data/mcus/ 的器件，离线可用、被 npm test 覆盖；
  - 搜索：src/data/deviceIndex.json 里的全部型号，选中时由本地服务器现场转换。

  索引有 550 KB，首屏用不到，所以点开搜索框才去动态 import——不能让一个多数
  人不会用的功能拖慢启动。
*/
/*
  主题切换：跟随时间 / 亮 / 暗。

  三个并排的按钮而不是一个循环切换的图标——图标式的循环按钮要点两下才知道
  有几档，而"当前是自动档、现在解析成暗色"这件事本身需要被看见（自动档按钮上
  标出当前实际配色）。
*/
function ThemeSwitch({ mode, resolved, onChange }) {
  const options = [
    { id: "auto", label: "自动", title: `跟随时间：18:00–06:00 用暗色（当前 ${resolved === "dark" ? "暗色" : "亮色"}）` },
    { id: "light", label: "亮", title: "始终使用亮色" },
    { id: "dark", label: "暗", title: "始终使用暗色" },
  ];
  return (
    <div className="theme-switch" role="group" aria-label="主题">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          title={option.title}
          aria-pressed={mode === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.id === "auto" ? `${option.label}·${resolved === "dark" ? "暗" : "亮"}` : option.label}
        </button>
      ))}
    </div>
  );
}

function McuSelector({ catalog, selectedId, onChange, onPick, loading, notice }) {
  const [browsing, setBrowsing] = useState(false);
  const [index, setIndex] = useState(null);
  const [query, setQuery] = useState("");
  const [indexError, setIndexError] = useState("");

  useEffect(() => {
    if (!browsing || index) return;
    let cancelled = false;
    import("./data/deviceIndex.json")
      .then((module) => { if (!cancelled) setIndex(module.default.devices); })
      .catch(() => {
        if (!cancelled) setIndexError("器件索引还没生成，先跑一次 npm run mcu:catalog");
      });
    return () => { cancelled = true; };
  }, [browsing, index]);

  /* 3000+ 条全渲染会卡，而且一次看几百个型号也没意义——只给前 60 条，
     让人把搜索词打得更具体。 */
  const matches = useMemo(() => {
    if (!index) return [];
    const words = query.trim().toUpperCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const hits = [];
    for (const item of index) {
      const haystack = `${item.part} ${item.series} ${item.package} ${item.pinCount}`.toUpperCase();
      if (words.every((word) => haystack.includes(word))) {
        hits.push(item);
        if (hits.length >= 60) break;
      }
    }
    return hits;
  }, [index, query]);

  return (
    <div className="mcu-selector">
      <span>目标 MCU</span>
      <select
        aria-label="选择 MCU"
        value={catalog.some((item) => item.id === selectedId) ? selectedId : ""}
        disabled={loading}
        onChange={(event) => onChange(event.target.value)}
      >
        {!catalog.some((item) => item.id === selectedId) && (
          <option value="">{catalogLabel(getMcuById(selectedId))}（按需加载）</option>
        )}
        {catalog.map((item) => (
          <option key={item.id} value={item.id}>{catalogLabel(item)}</option>
        ))}
      </select>
      <small>
        {loading ? "正在加载引脚数据…" : (
          <button type="button" className="linklike" onClick={() => setBrowsing((value) => !value)}>
            {browsing ? "收起" : "选择其他型号…"}
          </button>
        )}
      </small>

      {browsing && (
        <div className="mcu-browser">
          <input
            type="search"
            value={query}
            autoFocus
            placeholder="型号 / 系列 / 封装，如 F407 LQFP100"
            onChange={(event) => setQuery(event.target.value)}
          />
          {indexError && <p className="mcu-browser-note error">{indexError}</p>}
          {!indexError && !index && <p className="mcu-browser-note">正在载入器件索引…</p>}
          {index && query.trim() === "" && (
            <p className="mcu-browser-note">
              共 {index.length} 个型号可选。引脚数据在选中时由本地服务器现场转换，
              需要本机装有 CubeMX / SysConfig。
            </p>
          )}
          {index && query.trim() !== "" && matches.length === 0 && (
            <p className="mcu-browser-note">没有匹配的型号</p>
          )}
          <ul className="mcu-browser-list">
            {matches.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => { setBrowsing(false); onPick(item); }}>
                  <strong>{item.part}</strong>
                  <span>{item.package} · {item.pinCount} 脚</span>
                  <em>{item.series}{item.core ? ` · ${item.core}` : ""}</em>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {notice && <p className={`mcu-browser-note ${notice.kind}`}>{notice.text}</p>}
    </div>
  );
}

/*
  需求助手住在右侧抽屉里，不占左栏。

  它是**一次性入口**：描述一遍板子 → 应用成接口需求行 → 之后基本不再回头。
  常驻在左栏顶部却要占 455px（textarea + 示例 + 常用模块列表），等于让每次
  改一路接口都先滚过它。抽屉里反而能给它更宽的版面。
*/
function RequirementsAssistant({ mcuId, open, onClose, onApply }) {
  const [prompt, setPrompt] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiConfig, setAiConfig] = useState(readAiConfig);
  const [configOpen, setConfigOpen] = useState(false);
  const [assistantError, setAssistantError] = useState("");
  const remoteReady = aiConfig.enabled && aiConfig.endpoint.trim() && aiConfig.model.trim();

  async function analyze() {
    setAnalyzing(true);
    setAssistantError("");
    try {
      if (remoteReady) {
        try {
          const remote = await analyzeRequirementsRemote({ ...aiConfig, input: prompt, mcuId });
          setAnalysis(remote);
        } catch (error) {
          const fallback = analyzeRequirementsText(prompt, { mcuId });
          fallback.source = "offline-fallback";
          fallback.warnings = [`云端 AI 暂不可用，已回退离线解析：${error.message}`, ...fallback.warnings];
          setAnalysis(fallback);
        }
      } else {
        const local = analyzeRequirementsText(prompt, { mcuId });
        local.source = "offline";
        setAnalysis(local);
      }
    } finally {
      setAnalyzing(false);
    }
  }

  function updateAiConfig(patch) {
    setAiConfig((current) => {
      const next = { ...current, ...patch };
      if (typeof window !== "undefined") {
        window.localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify({
          enabled: next.enabled,
          endpoint: next.endpoint,
          model: next.model,
        }));
      }
      return next;
    });
  }

  function addModule(module) {
    setPrompt((current) => current ? `${current}，${module.name}` : module.name);
    setAnalysis(null);
  }

  if (!open) return null;

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-labelledby="assistant-title">
      <button type="button" className="sheet-scrim" aria-label="关闭" onClick={onClose} />
      <section className="sheet ai-assistant" aria-labelledby="assistant-title">
        <div className="assistant-heading">
          <div>
            <span>AI WORKFLOW</span>
            <h2 id="assistant-title">工程需求助手</h2>
          </div>
          <small className={remoteReady ? "is-cloud" : ""}>{remoteReady ? "云端 AI" : "离线解析"}</small>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="assistant-config">
          <button type="button" className="assistant-config-toggle" onClick={() => setConfigOpen((current) => !current)} aria-expanded={configOpen}>
            {remoteReady ? "云端 AI 已配置" : "配置云端 AI（可选）"}
          </button>
          {configOpen && (
            <div className="assistant-config-panel">
              <label>
                <span>兼容 Chat Completions 的接口地址</span>
                <input
                  aria-label="AI 接口地址"
                  value={aiConfig.endpoint}
                  onChange={(event) => updateAiConfig({ endpoint: event.target.value })}
                  placeholder="https://your-proxy.example/v1/chat/completions"
                />
              </label>
              <label>
                <span>模型名称</span>
                <input
                  aria-label="AI 模型名称"
                  value={aiConfig.model}
                  onChange={(event) => updateAiConfig({ model: event.target.value })}
                  placeholder="由你的服务提供商指定"
                />
              </label>
              <label>
                <span>API Key（仅保存在当前页面内存）</span>
                <input
                  aria-label="AI API Key"
                  type="password"
                  value={aiConfig.apiKey}
                  onChange={(event) => setAiConfig((current) => ({ ...current, apiKey: event.target.value }))}
                  placeholder="不填则不发送 Authorization"
                />
              </label>
              <Toggle checked={aiConfig.enabled} onChange={(value) => updateAiConfig({ enabled: value })}>优先使用云端 AI</Toggle>
              <p>接口只接收当前 MCU、模块目录和工程描述；模型输出结构化需求，物理引脚仍由本地求解器计算。</p>
            </div>
          )}
        </div>
        {assistantError && <p className="assistant-error">{assistantError}</p>}
        <p className="assistant-intro">描述板子要接的模块，先生成可审查的接口需求，再交给引脚求解器。</p>
        <textarea
          aria-label="工程需求描述"
          className="assistant-input"
          value={prompt}
          onChange={(event) => { setPrompt(event.target.value); setAnalysis(null); }}
          placeholder="例如：一个 SPI 六轴 IMU、一个右侧 SD 卡、一个调试串口，保留 SWD"
          rows={4}
        />
        <div className="assistant-examples" aria-label="需求示例">
          <span>示例</span>
          <button type="button" onClick={() => setPrompt("一个 SPI 六轴 IMU、一个右侧 SD 卡、一个调试串口，保留 SWD")}>传感器 + 存储</button>
          <button type="button" onClick={() => setPrompt("RMII 以太网、USB 设备和 1 个 FDCAN")}>网络 + 通信</button>
        </div>
        <div className="assistant-actions">
          <button type="button" className="secondary-button" onClick={() => { setPrompt(""); setAnalysis(null); }}>清空</button>
          <button type="button" className="primary-button" onClick={analyze} disabled={!prompt.trim() || analyzing}>
            {analyzing ? "解析中…" : "解析需求"}
          </button>
        </div>
        <div className="module-library">
          <div className="module-library-heading"><strong>常用模块</strong><span>点击加入草案</span></div>
          <div className="module-chip-list">
            {MODULE_CATALOG.map((module) => (
              <button key={module.id} type="button" className="module-chip" onClick={() => addModule(module)}>
                <span>{module.name}</span><small>{module.category}</small>
              </button>
            ))}
          </div>
        </div>
        {analysis && (
          <div className="assistant-result" aria-live="polite">
            <div className="assistant-result-heading">
              <strong>{analysis.summary}</strong>
              <span>{analysis.source === "remote" ? "云端 AI" : analysis.source === "offline-fallback" ? "回退解析" : "离线解析"} · v{analysis.envelope.version}</span>
            </div>
            {analysis.modules.length > 0 && (
              <div className="assistant-module-list">
                {analysis.modules.map((module) => (
                  <div key={`${module.id}-${module.variantId}`} className="assistant-module-card">
                    <div><strong>{module.name}</strong><span>{module.variantLabel}</span></div>
                    <small>{module.notes}</small>
                  </div>
                ))}
              </div>
            )}
            {analysis.requests.length > 0 && (
              <div className="assistant-request-list">
                <div className="assistant-subheading">将提交给求解器</div>
                {analysis.requests.map((request, index) => (
                  <div className="assistant-request" key={`${request.type}-${request.source}-${index}`}>
                    <strong>{DEFINITIONS[request.type].label}</strong>
                    <span>{request.variant}{request.instance ? ` · ${request.instance}` : " · 自动选择实例"}</span>
                    {request.side && <small>{SIDES[request.side].label}优先</small>}
                  </div>
                ))}
              </div>
            )}
            {analysis.constraints.length > 0 && (
              <div className="assistant-constraints">
                {analysis.constraints.map((constraint) => <span key={constraint.kind}>{constraint.label}</span>)}
              </div>
            )}
            {analysis.warnings.map((warning) => <p className="assistant-warning" key={warning}>{warning}</p>)}
            {analysis.requests.length > 0 && (
              <div className="assistant-apply-actions">
                <button type="button" className="secondary-button" onClick={() => onApply(analysis, false)}>应用到需求</button>
                <button type="button" className="primary-button" onClick={() => onApply(analysis, true)}>应用并生成方案</button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/*
  外设配置侧栏。

  两种操作，刻意分开：
  - 点条目本身 = **检视**，右侧面板列出这个实例能落到哪些脚；
  - 点右侧的 +/✓ = **加进接口需求**，并把实例锁定成这一个。

  没有把整行做成"点一下就加进需求"——先看清楚 SPI3 到底有没有可用的脚、
  会不会和调试口撞上，再决定要不要它，这个顺序对密集封装很重要。合并成一个
  动作等于逼人先添加再回头删。
*/
function PeripheralSidebar({
  catalog, activePeripheral, onSelect, pinnedInstances, onToggleRequest, defaultOpenSection = "connectivity",
}) {
  /* 单开手风琴。原先是一个 Set，能同时摊开任意多个分类——H743 光 Connectivity
     一类就有 25 个实例（约 1000px），两三类叠起来左栏就没底了。 */
  const [openSection, setOpenSection] = useState(defaultOpenSection);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setOpenSection(defaultOpenSection);
    setFilter("");
  }, [defaultOpenSection]);

  /* 不占引脚的分类（CubeMX 的 System Core / Security / Computing / Middleware /
     Trace / Power，以及 MSPM0 的 Project Configuration 一类）判据是"一个实例都没有"。
     它们与引脚分配无关，却在首屏占掉 6 行分类头，折进一个只读组里。 */
  const pinCategories = catalog.filter((category) => category.items.some((item) => item.instance));
  const staticCategories = catalog.filter((category) => !category.items.some((item) => item.instance));

  const query = filter.trim().toLowerCase();
  const matches = query
    ? catalog.flatMap((category) => category.items
      .filter((item) => item.label.toLowerCase().includes(query)
        || item.instance?.toLowerCase().includes(query)
        || item.signals?.some((signal) => signal.toLowerCase().includes(query)))
      .map((item) => ({ item, categoryLabel: category.label })))
    : [];

  function renderItem(item, categoryLabel) {
    const selected = activePeripheral?.id === item.id;
    const added = item.type && pinnedInstances.has(`${item.type}:${item.instance}`);
    /* 只有真正可分配的实例能加进需求。静态条目（CubeMX 那套里
       不参与求解的信息行）没有 type，加了也排不出东西。 */
    const addable = Boolean(item.modeled && item.type && item.instance);
    return (
      <div key={`${categoryLabel || ""}${item.id}`} className={`peripheral-item-row${added ? " is-added" : ""}`}>
        <button
          type="button"
          className={`peripheral-item${selected ? " is-active" : ""}${item.instance ? "" : " is-static"}`}
          onClick={() => onSelect(item)}
        >
          <span>{item.label}</span>
          <small>{added ? "已加入需求" : categoryLabel ? `${categoryLabel} · ${item.status}` : item.status}</small>
        </button>
        {addable && (
          <button
            type="button"
            className="peripheral-pick"
            aria-pressed={added}
            title={added ? `从接口需求中移除 ${item.label}` : `把 ${item.label} 加进接口需求`}
            onClick={() => onToggleRequest(item)}
          >
            {added ? "✓" : "+"}
          </button>
        )}
      </div>
    );
  }

  function renderCategory(category) {
    const open = openSection === category.id;
    const availableCount = category.count ?? category.items.filter((item) => item.instance).length;
    const activeTimerMode = category.id === "timers" && activePeripheral?.timerMode ? activePeripheral.timerMode : null;
    const visibleItems = activeTimerMode
      ? category.items.filter((item) => !item.instance || item.timerModes?.includes(activeTimerMode))
      : category.items;
    return (
      <div className={`peripheral-category${open ? " is-open" : ""}`} key={category.id}>
        <button
          type="button"
          className="category-row"
          onClick={() => setOpenSection((current) => (current === category.id ? null : category.id))}
          aria-expanded={open}
        >
          <span>{category.label}</span>
          <span className="category-meta">{availableCount > 0 ? availableCount : ""}<b aria-hidden="true">{open ? "⌄" : "›"}</b></span>
        </button>
        {open && (
          <div className="category-items">
            {activeTimerMode && (
              <div className="timer-mode-filter">
                <span>当前模式</span>
                <strong>{TIMER_MODE_LABELS[activeTimerMode] || activeTimerMode}</strong>
              </div>
            )}
            {visibleItems.map((item) => renderItem(item))}
            {visibleItems.length === 0 && <span className="category-empty">当前模式没有可用实例</span>}
          </div>
        )}
      </div>
    );
  }

  const staticOpen = openSection === "__static";
  const staticItems = staticCategories.flatMap((category) => category.items
    .map((item) => ({ item, categoryLabel: category.label })));

  return (
    <section className="peripheral-sidebar" aria-label="外设分类导航">
      <div className="sidebar-heading">
        <span>PERIPHERALS</span>
        <strong>外设配置</strong>
      </div>
      <p className="sidebar-hint">点名称查看它能连到哪些物理引脚，点 <b>+</b> 直接加进接口需求。</p>
      <label className="peripheral-filter">
        <span className="sr-only">筛选外设实例</span>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="筛选 SPI1、UART、MOSI…"
        />
        {filter && (
          <button type="button" aria-label="清空筛选" onClick={() => setFilter("")}>×</button>
        )}
      </label>
      {query ? (
        <div className="peripheral-nav is-flat">
          <div className="category-items">
            {matches.map(({ item, categoryLabel }) => renderItem(item, categoryLabel))}
            {matches.length === 0 && <span className="category-empty">没有匹配「{filter.trim()}」的外设</span>}
          </div>
        </div>
      ) : (
        <nav className="peripheral-nav">
          {pinCategories.map(renderCategory)}
          {staticItems.length > 0 && (
            <div className={`peripheral-category is-secondary${staticOpen ? " is-open" : ""}`}>
              <button
                type="button"
                className="category-row"
                onClick={() => setOpenSection((current) => (current === "__static" ? null : "__static"))}
                aria-expanded={staticOpen}
              >
                <span>其他（不占引脚）</span>
                <span className="category-meta">{staticItems.length}<b aria-hidden="true">{staticOpen ? "⌄" : "›"}</b></span>
              </button>
              {staticOpen && (
                <div className="category-items">
                  {staticItems.map(({ item, categoryLabel }) => renderItem(item, categoryLabel))}
                </div>
              )}
            </div>
          )}
        </nav>
      )}
    </section>
  );
}

/* 导出供 tests/render.mjs 单独渲染：这两个面板只有在选中外设或求解完成后
   才出现，整体渲染 App 覆盖不到，而它们恰恰是改动最集中的地方。 */
export function PeripheralInspector({ mcuData, peripheral, pinnedInstances, onToggleFixed, onSelectPin }) {
  if (!peripheral) {
    return <div className="peripheral-empty">从左侧展开一个分类，选择 SPI1、I2C1 或其他外设实例。</div>;
  }
  const rows = peripheral.instance ? peripheralFunctions(mcuData, peripheral.instance, peripheral.timerMode) : [];
  const visibleSignalCount = peripheral.timerMode && peripheral.instance ? rows.length : peripheral.signalCount;
  const timerModePinCount = peripheral.timerMode
    ? mcuData.pins.filter((pin) => isPeripheralPin(pin, peripheral.instance, peripheral.timerMode, mcuData)).length
    : 0;
  const isFixed = peripheral.type && pinnedInstances.has(`${peripheral.type}:${peripheral.instance}`);
  return (
    <section className="peripheral-inspector" aria-labelledby="peripheral-title">
      <div className="peripheral-inspector-heading">
        <div>
          <span>{peripheral.instance ? "外设实例" : "配置项"}</span>
          <h2 id="peripheral-title">{peripheral.label}</h2>
        </div>
        {peripheral.type && (
          <button type="button" className={isFixed ? "fixed-button" : "secondary-button"} onClick={() => onToggleFixed(peripheral)}>
            {isFixed ? "取消固定" : `固定为 ${peripheral.instance}`}
          </button>
        )}
      </div>
      <p className="peripheral-description">
        {peripheral.instance
          ? `${visibleSignalCount} 个信号可映射到多个 GPIO 复用位置。${peripheral.timerMode && peripheral.timerMode !== "general" ? `${TIMER_MODE_LABELS[peripheral.timerMode]}已启用。` : ""}点击候选引脚可在封装图中定位。`
          : peripheral.description}
      </p>
      {peripheral.timerMode && (
        <div className="timer-mode-panel">
          <div className="timer-mode-panel-heading">
            <span>TI TIMER 模式</span>
            <strong>{TIMER_MODE_LABELS[peripheral.timerMode] || peripheral.timerMode}</strong>
          </div>
          <p>封装图已定位 {timerModePinCount} 个相关引脚，下面列出当前模式可用的定时器实例。</p>
          <div className="timer-mode-instances">
            {(peripheral.availableInstances || []).map((instance) => <span key={instance}>{instance}</span>)}
            {peripheral.availableInstances?.length === 0 && <small>当前封装没有匹配实例</small>}
          </div>
        </div>
      )}
      {rows.length > 0 ? (
        <div className="peripheral-signal-list">
          {rows.map(([signal, candidates]) => (
            <div className="peripheral-signal" key={signal}>
              <div className="signal-name"><strong>{signal}</strong><small>{candidates.length} 个候选</small></div>
              <div className="candidate-list">
                {candidates.slice(0, 8).map((candidate) => (
                  <button type="button" key={`${candidate.pin.number}-${candidate.af}`} onClick={() => onSelectPin(candidate.pin)}>
                    {candidate.pin.name}<small>脚 {candidate.pin.number} / {candidate.af == null ? "附加功能" : `AF${candidate.af}`}</small>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="peripheral-empty compact">这是一个配置项，当前数据没有可分配的外部信号。</div>
      )}
    </section>
  );
}

function PinButton({ pin, state, assigned, selected, dimmed, focused, label, onClick }) {
  const marker = label ?? pin.number;
  return (
    <button
      type="button"
      className={`pin pin-${state}${assigned ? " is-assigned" : ""}${selected ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}${focused ? " is-peripheral-focus" : ""}`}
      title={`${marker} · ${pin.name}`}
      onClick={onClick}
    >
      <span>{pin.name}</span>
      <small>{marker}</small>
    </button>
  );
}

/* 一个方格里放几个引脚才不至于挤成一团——周边式按每边脚数缩放，
   栅格式按行列里较大的一边。 */
function packageMetrics(perSide) {
  const scale = perSide > 25
    ? Math.max(0.72, 25 / perSide)
    : Math.max(0.88, Math.min(1, perSide / 25));
  const pinThick = Math.max(14, Math.round(19 * scale));
  const pinGap = Math.max(2, Math.round(3 * scale));
  return {
    scale,
    pinThick,
    pinGap,
    bodyPad: Math.max(16, Math.round(20 * scale)),
    lead: Math.max(52, Math.round(68 * scale)),
  };
}

export function PackageView({ mcuData, pins, selectedPin, onSelect, excludedPins, assignedPins, search, stale, highlightedPeripheral, onClearPeripheralHighlight }) {
  /* 边和坐标一律取自 package.js——求解器给"靠右"打分用的是同一份换算，
     这里另算一遍就会出现图上画在右边、求解器认为在顶边的引脚。 */
  const layout = useMemo(() => packageLayout(mcuData), [mcuData]);
  const isGrid = layout.kind === "grid";
  const perSide = isGrid ? Math.max(layout.grid.rows, layout.grid.columns) : layout.pinsPerSide;
  const { scale, pinThick, pinGap, bodyPad, lead } = packageMetrics(perSide);
  /* 两边封装的横向没有引脚排，本体宽度收窄到刚好放下型号即可。 */
  const columns = isGrid ? layout.grid.columns : layout.sides.top.length || layout.sides.bottom.length;
  const rows = isGrid ? layout.grid.rows : layout.sides.left.length || layout.sides.right.length;
  const pitch = pinThick + pinGap;
  const spanX = Math.max(columns * pitch - pinGap, 168);
  const spanY = Math.max(rows * pitch - pinGap, 120);
  /* 这些尺寸不能继续依赖 styles.css 的 25-pin 默认值。
     引脚变量虽然按封装缩放了，但若本体/舞台仍使用根变量，64-pin
     封装就会出现“引脚很小、芯片很大”的错位。 */
  const bodyW = spanX + 2 * bodyPad;
  const bodyH = spanY + 2 * bodyPad;
  const stageW = bodyW + 2 * lead;
  const stageH = bodyH + 2 * lead;
  const hasPeripheralFocus = Boolean(highlightedPeripheral?.instance || highlightedPeripheral?.timerMode);
  const packageStyle = {
    "--pin-per-side": perSide,
    "--pin-thick": `${pinThick}px`,
    "--pin-gap": `${pinGap}px`,
    "--pin-pitch": `${pitch}px`,
    "--span-x": `${spanX}px`,
    "--span-y": `${spanY}px`,
    "--body-pad": `${bodyPad}px`,
    "--lead": `${isGrid ? 0 : lead}px`,
    "--body-w": `${bodyW}px`,
    "--body-h": `${bodyH}px`,
    "--stage-w": `${stageW}px`,
    "--stage-h": `${stageH}px`,
    "--pin-padding": `${Math.max(4, Math.round(5 * scale))}px`,
    "--pin-font-size": `${Math.max(9, Math.round(10 * scale))}px`,
    "--pin-number-size": `${Math.max(8, Math.round(9 * scale))}px`,
    "--chip-title-size": `${Math.max(22, Math.round(27 * scale))}px`,
  };
  const peripheralPinCount = useMemo(
    () => hasPeripheralFocus
      ? pins.filter((pin) => isPeripheralPin(pin, highlightedPeripheral?.instance, highlightedPeripheral?.timerMode, mcuData)).length
      : 0,
    [pins, highlightedPeripheral, hasPeripheralFocus, mcuData],
  );
  const normalizedSearch = search.trim().toUpperCase();

  /* 用 DEFINITIONS 里的 protocol 而不是 type.toLowerCase()——两者对多数类型
     一样，但 TIM 的配色变量叫 --timer，直接小写会拿不到颜色。 */
  function pinState(pin) {
    if (excludedPins.has(pin.number)) return "excluded";
    if (assignedPins.has(pin.number)) return DEFINITIONS[assignedPins.get(pin.number).type].protocol;
    if (pin.protection.length) return "protected";
    if (pin.kind !== "gpio") return "fixed";
    return "free";
  }

  function isDimmed(pin) {
    if (hasPeripheralFocus && !isPeripheralPin(pin, highlightedPeripheral?.instance, highlightedPeripheral?.timerMode, mcuData)) return true;
    if (!normalizedSearch) return false;
    return !pin.name.includes(normalizedSearch)
      && !pin.functions.some((item) => item.name.includes(normalizedSearch))
      && !pin.additionalFunctions.some((item) => item.includes(normalizedSearch));
  }

  const renderPin = (pin) => (
    <PinButton
      key={pin.number}
      pin={pin}
      label={isGrid ? layout.locationOf(pin.number) : pin.number}
      state={pinState(pin)}
      assigned={assignedPins.has(pin.number) && !excludedPins.has(pin.number)}
      selected={selectedPin?.number === pin.number}
      dimmed={isDimmed(pin)}
      focused={hasPeripheralFocus && isPeripheralPin(pin, highlightedPeripheral?.instance, highlightedPeripheral?.timerMode, mcuData)}
      onClick={() => onSelect(pin)}
    />
  );

  const focusBanner = hasPeripheralFocus && (
    <div className="peripheral-focus-banner" aria-live="polite">
      <span>当前封装定位</span>
      <strong>{highlightedPeripheral.label}</strong>
      <small>{peripheralPinCount} 个对应引脚</small>
      <button type="button" className="peripheral-focus-clear" onClick={onClearPeripheralHighlight}>清除定位</button>
    </div>
  );

  const stageClass = `package-stage package-${layout.kind}${stale ? " is-stale" : ""}${hasPeripheralFocus ? " has-peripheral-focus" : ""}`;
  const stageLabel = `${mcuData.partNumber} ${mcuData.package} 封装图`;

  /* BGA / WLCSP 没有引脚排，只有球阵。行标（A、B、C…）和列号沿边标出来，
     否则一屏几百个球根本读不出位置。 */
  if (isGrid) {
    return (
      <div className={stageClass} style={packageStyle} aria-label={stageLabel}>
        {focusBanner}
        <div className="ball-grid-title">
          <strong>{mcuData.partNumber}</strong>
          <small>{mcuData.vendor} · {mcuData.package}</small>
        </div>
        <div className="ball-grid" style={{ "--grid-columns": layout.grid.columns }}>
          <div className="ball-grid-corner" aria-hidden="true" />
          {Array.from({ length: layout.grid.columns }, (_, index) => (
            <div className="ball-grid-column-label" key={`col-${index}`} aria-hidden="true">{index + 1}</div>
          ))}
          {layout.rows.map((row) => (
            <Fragment key={row.label}>
              <div className="ball-grid-row-label" aria-hidden="true">{row.label}</div>
              {row.cells.map((pin, index) => (
                pin ? renderPin(pin) : <div className="ball-empty" key={`gap-${row.label}-${index}`} aria-hidden="true" />
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={stageClass} style={packageStyle} aria-label={stageLabel}>
      <div className="pin-side pin-side-top">{layout.sides.top.map(renderPin)}</div>
      <div className="pin-side pin-side-right">{layout.sides.right.map(renderPin)}</div>
      <div className="pin-side pin-side-bottom">{layout.sides.bottom.map(renderPin)}</div>
      <div className="pin-side pin-side-left">{layout.sides.left.map(renderPin)}</div>
      {focusBanner}
      <div className="chip-body">
        <div className="pin-one" aria-hidden="true" />
        <span>{mcuData.vendor}</span>
        <strong>{mcuData.partNumber}</strong>
        <small>{[mcuData.core, mcuData.package].filter(Boolean).join(" · ")}</small>
      </div>
    </div>
  );
}

export function PinInspector({ mcu, pin, excluded, onToggleExclude }) {
  if (!pin) {
    return <div className="empty-state">点击封装图中的引脚，查看它支持的全部复用功能。</div>;
  }
  /* null = 这颗器件的数据分不出耐压等级，别显示成"仅 3.3V" */
  const tolerant = mcu ? isFiveVoltTolerant(mcu, pin) : null;
  return (
    <section className="inspector" aria-labelledby="pin-inspector-title">
      <div className="inspector-heading">
        <div>
          <span>物理脚 {pin.number}</span>
          <h2 id="pin-inspector-title">{pin.name}</h2>
        </div>
        {pin.kind === "gpio" && (
          <button type="button" className={excluded ? "danger-button" : "secondary-button"} onClick={onToggleExclude}>
            {excluded ? "恢复使用" : "排除此脚"}
          </button>
        )}
      </div>
      <dl className="pin-meta">
        <div><dt>复位名称</dt><dd>{pin.resetName}</dd></div>
        <div><dt>I/O结构</dt><dd>{pin.ioStructure || pin.ioType || "专用"}</dd></div>
        {tolerant !== null && pin.kind === "gpio" && (
          <div>
            <dt>电平耐受</dt>
            <dd className={tolerant ? "is-tolerant" : "is-intolerant"}>{tolerant ? "耐 5V" : "仅 3.3V"}</dd>
          </div>
        )}
      </dl>
      {pin.protection.length > 0 && <p className="notice">默认保护：{pin.protection.join(" / ")}</p>}
      <div className="function-grid">
        {pin.functions.length > 0 ? pin.functions.map((item) => (
          <div className={`function-row function-${protocolForFunction(item.name)}`} key={`${item.name}-${item.af}`}>
            <span>{item.name}</span><b>AF{item.af}</b>
          </div>
        )) : <p className="muted">没有可用的数字复用功能。</p>}
      </div>
      {pin.additionalFunctions.length > 0 && (
        <div className="additional-functions">
          <h3>附加功能</h3>
          <p>{pin.additionalFunctions.join(" · ")}</p>
        </div>
      )}
    </section>
  );
}

export function SolutionPanel({ result, pending, stale, activeIndex, setActiveIndex, lockedGroups, onToggleLock, onExport, onRerun }) {
  const [exportOpen, setExportOpen] = useState(false);
  if (pending) {
    return (
      <div className="empty-state compact solving">
        <span className="spinner" aria-hidden="true" />
        正在搜索可行的引脚组合…
      </div>
    );
  }
  if (!result) return <div className="empty-state compact">设置接口数量后点击“生成方案”。</div>;
  if (result.error) {
    return <div className="error-state"><strong>求解器出错</strong><p>{result.error}</p></div>;
  }
  if (!result.solutions.length) {
    /* 区分"穷举完确认无解"和"预算耗尽只能说不知道"——两者的应对方式完全不同 */
    return result.proven ? (
      <div className="error-state">
        <strong>确认无解</strong>
        <p>已穷举全部组合，当前约束下这些接口无法同时分配。请减少接口数量、解除锁定、恢复被排除引脚，或关闭调试/晶振保护。</p>
      </div>
    ) : (
      <div className="warn-state">
        <strong>搜索未跑完，无法判定</strong>
        <p>
          已检查 {result.visited.toLocaleString()} 个节点（
          {result.exhausted ? "触及搜索上限" : ""}
          {result.exhausted && result.truncated ? "，" : ""}
          {result.truncated ? "部分实例的组合数超出缓存上限" : ""}
          ），没有找到方案，但<b>不能断定无解</b>。请缩小需求后重试。
        </p>
      </div>
    );
  }
  const solution = result.solutions[activeIndex] || result.solutions[0];
  return (
    <section className="solution-panel">
      {stale && (
        <div className="stale-banner">
          <span>需求或规则已改动，下方仍是上一次的结果。</span>
          <button type="button" onClick={onRerun}>重新生成</button>
        </div>
      )}
      {result.droppedLocks?.length > 0 && (
        <p className="notice notice-warn">
          锁定组数超过需求数，已自动释放：{result.droppedLocks.map((item) => item.instance).join("、")}
        </p>
      )}
      <div className="solution-toolbar">
        <div className="solution-tabs" role="tablist" aria-label="可选分配方案">
          {result.solutions.map((_, index) => (
            <button key={index} type="button" className={index === activeIndex ? "active" : ""} onClick={() => setActiveIndex(index)}>
              方案 {String.fromCharCode(65 + index)}
            </button>
          ))}
        </div>
        <div className="export-menu">
          <button type="button" className="text-button" onClick={() => setExportOpen((open) => !open)} aria-expanded={exportOpen}>
            导出 ⌄
          </button>
          {exportOpen && (
            <div className="export-options">
              {EXPORT_FORMATS.map((format) => (
                <button
                  key={format.id}
                  type="button"
                  onClick={() => { setExportOpen(false); onExport(solution, format.id); }}
                >
                  {format.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {result.restored ? (
        <p className="solver-meta">
          这是上次保存的方案，不是本次求解结果。改动需求或点“生成方案”后会重新搜索。
        </p>
      ) : (
        <p className="solver-meta">
          搜索 {result.visited.toLocaleString()} 个节点 / {result.elapsed ?? 0} ms，
          从 {result.poolSize} 套候选中挑出实例组合互不相同的 {result.solutions.length} 套，按布线距离和稀缺资源占用评分。
        </p>
      )}
      <div className="solution-groups">
        {solution.groups.map((group) => {
          const locked = lockedGroups.some((item) => item.type === group.type && item.instance === group.instance);
          return (
            <article className={`solution-group group-${DEFINITIONS[group.type].protocol}`} key={group.requestId || `${group.type}-${group.instance}`}>
              <header>
                <div>
                  <span>{DEFINITIONS[group.type].label}</span>
                  <strong>{group.instance}</strong>
                  <small>{DEFINITIONS[group.type].variants[group.variant]?.label}</small>
                </div>
                <button type="button" className="text-button" onClick={() => onToggleLock(group)}>{locked ? "解除锁定" : "锁定整组"}</button>
              </header>
              {group.assignments.map((assignment) => (
                <div className="assignment" key={assignment.signal}>
                  <span>{assignment.signal}</span>
                  <b>{assignment.pin.name}</b>
                  <small>脚 {assignment.pin.number} / AF{assignment.af}</small>
                </div>
              ))}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function DiffSignalRow({ item }) {
  const label = { added: "新增", removed: "移除", moved: "改脚", same: "" }[item.status];
  return (
    <div className={`diff-signal diff-${item.status}`}>
      <span>{item.signal}</span>
      <b>
        {item.from ? item.from.pinName : "—"}
        <i aria-hidden="true"> → </i>
        {item.to ? item.to.pinName : "—"}
      </b>
      <small>{label}</small>
    </div>
  );
}

/*
  方案对比。评审要回答的是"相比上一版改了什么"，所以按组、按信号列出来，
  而不是让人对着两张封装图找不同。

  两种对比源共用同一套 diffPlans：同一次求解的多套方案互比（数据现成），
  以及当前方案与载入的基线工程文件互比。
*/
function requestSummary(request) {
  const parts = [DEFINITIONS[request.type]?.variants[request.variant]?.label || request.variant];
  if (request.instance) parts.push(request.instance);
  if (request.side) parts.push(`${SIDES[request.side].label}优先`);
  if (request.fiveVolt) parts.push("5V");
  return parts.join(" · ");
}

export function DiffPanel({ solutions = [], activeIndex = 0, baseline, requests = [], onLoadBaseline, onClearBaseline }) {
  const [mode, setMode] = useState("solutions");
  const [leftIndex, setLeftIndex] = useState(0);
  const [rightIndex, setRightIndex] = useState(1);
  const fileRef = useRef(null);

  const canCompareSolutions = solutions.length >= 2;
  const effectiveMode = mode === "baseline" && !baseline ? "baseline" : (canCompareSolutions ? mode : "baseline");

  const left = effectiveMode === "baseline" ? baseline?.plan : solutions[leftIndex];
  const right = effectiveMode === "baseline" ? solutions[activeIndex] : solutions[rightIndex];
  const diff = left && right ? diffPlans(left, right) : null;
  /* 与基线比时，需求本身的变化和引脚的变化同样重要——"这版把 ETH 删了"
     解释了后面一连串引脚差异的由来。方案互比时两侧需求相同，没这回事。 */
  const requestRows = effectiveMode === "baseline" && baseline
    ? diffRequests(baseline.requests, requests).filter((row) => row.status !== "same")
    : [];

  return (
    <section className="diff-panel" aria-labelledby="diff-title">
      <div className="section-heading">
        <h2 id="diff-title">方案对比</h2>
        <div className="diff-mode" role="tablist" aria-label="对比方式">
          <button
            type="button"
            role="tab"
            aria-selected={effectiveMode === "solutions"}
            className={effectiveMode === "solutions" ? "active" : ""}
            disabled={!canCompareSolutions}
            onClick={() => setMode("solutions")}
          >
            方案互比
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveMode === "baseline"}
            className={effectiveMode === "baseline" ? "active" : ""}
            onClick={() => setMode("baseline")}
          >
            对比基线
          </button>
        </div>
      </div>

      {effectiveMode === "solutions" ? (
        <div className="diff-controls">
          <label>
            <span>基准</span>
            <select value={leftIndex} onChange={(event) => setLeftIndex(Number(event.target.value))}>
              {solutions.map((_, index) => (
                <option key={index} value={index}>方案 {String.fromCharCode(65 + index)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>对照</span>
            <select value={rightIndex} onChange={(event) => setRightIndex(Number(event.target.value))}>
              {solutions.map((_, index) => (
                <option key={index} value={index}>方案 {String.fromCharCode(65 + index)}</option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <div className="diff-baseline">
          <input
            ref={fileRef}
            type="file"
            accept=".json,.pinplan.json,application/json"
            aria-label="载入基线工程文件"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onLoadBaseline(file);
              event.target.value = "";
            }}
          />
          {baseline ? (
            <div className="diff-baseline-info">
              <span>基线：<strong>{baseline.name}</strong></span>
              <button type="button" className="text-button" onClick={onClearBaseline}>清除</button>
            </div>
          ) : (
            <p className="muted">载入一份保存过的 .pinplan.json 作为基线，对比当前方案改了哪些脚。</p>
          )}
          <button type="button" className="secondary-button" onClick={() => fileRef.current?.click()}>
            {baseline ? "更换基线文件" : "载入基线文件"}
          </button>
        </div>
      )}

      {requestRows.length > 0 && (
        <div className="diff-requests">
          <div className="diff-subheading">需求行改动</div>
          {requestRows.map((row, index) => {
            const request = row.to || row.from;
            return (
              <div className={`diff-request diff-${row.status}`} key={`${request.id}-${index}`}>
                <span>{DEFINITIONS[request.type]?.label || request.type}</span>
                <b>{row.status === "changed" ? `${requestSummary(row.from)} → ${requestSummary(row.to)}` : requestSummary(request)}</b>
                <small>{{ added: "新增", removed: "移除", changed: "改动" }[row.status]}</small>
              </div>
            );
          })}
        </div>
      )}
      {!diff && <p className="muted">{effectiveMode === "baseline" ? "还没有基线，或当前没有可对比的方案。" : "至少要有两套方案才能互比。"}</p>}
      {diff && isEmptyDiff(diff) && <p className="muted">两侧完全一致。</p>}
      {diff && !isEmptyDiff(diff) && (
        <>
          <p className="diff-summary">
            {diff.summary.groupsAdded} 组新增 · {diff.summary.groupsRemoved} 组移除 · {diff.summary.groupsChanged} 组改动 ·
            占用 {diff.summary.pinsTaken} 脚 / 释放 {diff.summary.pinsFreed} 脚
          </p>
          <div className="diff-groups">
            {diff.groups.filter((group) => group.status !== "same").map((group) => (
              <article className={`diff-group diff-group-${group.status}`} key={group.key}>
                <header>
                  <strong>{group.instance}</strong>
                  <span>{DEFINITIONS[group.type]?.label || group.type}</span>
                  <small>{{ added: "新增", removed: "移除", changed: "改动" }[group.status]}</small>
                </header>
                {group.signals.filter((item) => item.status !== "same").map((item) => (
                  <DiffSignalRow item={item} key={item.signal} />
                ))}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function App() {
  const [restored] = useState(readStoredProject);
  /* main.jsx 已经把这颗片子的引脚表取回来了；万一没有（直接挂载 App 的场景）
     就退回默认那颗，而不是让整棵组件树对着 null 崩掉。 */
  const [selectedMcuId, setSelectedMcuId] = useState(() => (
    restored?.mcuId && isMcuLoaded(restored.mcuId) ? restored.mcuId : DEFAULT_MCU_ID
  ));
  const [mcuLoading, setMcuLoading] = useState(false);
  /* 按需器件的加载结果单独提示：它与工程文件的提示（projectNotice）来源不同，
     混在一起会互相覆盖。 */
  const [mcuNotice, setMcuNotice] = useState(null);

  /* 主题。初值从 localStorage 读，与 index.html 里那段抢跑脚本得出的结论一致，
     所以挂载时不会闪。 */
  const [themeMode, setThemeMode] = useState(readThemeMode);
  const [resolvedTheme, setResolvedTheme] = useState(() => resolveTheme(readThemeMode()));

  useEffect(() => {
    if (themeMode !== "auto") {
      applyTheme(themeMode);
      setResolvedTheme(themeMode);
      return undefined;
    }
    /* 自动档要在跨过 18:00 / 06:00 时自己切过去——这个页面常被开一整天 */
    return watchAutoTheme((theme) => {
      applyTheme(theme);
      setResolvedTheme(theme);
    });
  }, [themeMode]);

  function handleThemeChange(mode) {
    setThemeMode(mode);
    writeThemeMode(mode);
  }

  /* 本地偏好 + 两个新面板。preferences 是唯一副本，个人中心改完立刻回写并重读，
     不做乐观更新——这些值都很小，读一次的开销远低于两处状态不同步的排查成本。 */
  const [preferences, setPreferences] = useState(readPreferences);
  const [centerOpen, setCenterOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);

  function updatePreferences(patch) {
    /* patch 为 null = 调用方已经自己写过盘（比如 forgetMcu / clearStorage），
       这里只负责重新读一遍让界面跟上 */
    setPreferences(patch ? writePreferences(patch) : readPreferences());
  }

  /* 首次使用自动弹教程。等首屏渲染完再弹，否则高亮框会定位到还没布局好的元素。 */
  useEffect(() => {
    if (preferences.tourSeen) return undefined;
    const timer = setTimeout(() => setTourOpen(true), 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeTour() {
    setTourOpen(false);
    if (!preferences.tourSeen) updatePreferences({ tourSeen: true });
  }

  const mcuRecord = useMemo(() => getMcuById(selectedMcuId), [selectedMcuId]);

  /* 记录用过的器件。放在这里而不是各个切换入口里——切换有三条路径
     （下拉、按需搜索、最近列表），逐个去记必然会漏。 */
  useEffect(() => {
    if (!mcuRecord?.id) return;
    setPreferences(rememberMcu(mcuRecord));
  }, [mcuRecord?.id]);
  const mcu = mcuRecord.data;
  const requestTypes = useMemo(
    () => (mcu ? requestTypesFor(mcu, mcuRecord.uiProfile) : PERIPHERAL_TYPE_ORDER),
    [mcu, mcuRecord.uiProfile],
  );
  const [requests, setRequests] = useState(() => (
    restored?.requests?.length ? restored.requests : createDefaultRequests(requestTypes)
  ));
  const [options, setOptions] = useState(restored?.options || { ...readPreferences().solverDefaults });
  const [excludedPins, setExcludedPins] = useState(() => restored?.excludedPins || new Set());
  const [selectedPin, setSelectedPin] = useState(
    () => mcu.pins.find((pin) => pin.name === "PA5") || mcu.pins.find((pin) => pin.kind === "gpio"),
  );
  const [search, setSearch] = useState("");
  const [result, setResult] = useState(() => restoredResult(restored?.plan));
  /* 恢复出来的方案对应的正是恢复出来的输入，所以签名要一并恢复——
     否则一进页面就被判成"已过期"。 */
  const [resultSignature, setResultSignature] = useState(() => (
    restored?.plan
      ? inputSignature(restored.requests, restored.options, restored.excludedPins, restored.lockedGroups)
      : null
  ));
  const [pending, setPending] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [lockedGroups, setLockedGroups] = useState(restored?.lockedGroups || []);
  const [activePeripheral, setActivePeripheral] = useState(null);
  const [highlightedPeripheral, setHighlightedPeripheral] = useState(null);
  /* 右栏一次只显示一种详情：引脚详情和外设详情讲的是同一块面积上的两件事，
     叠着放会把求解结果挤到看不见的地方。谁被点中谁上前。 */
  const [detailFocus, setDetailFocus] = useState("pin");
  /* 底部操作条里的两个折叠。默认收起——它们是"设完就不再动"的东西，
     而操作条的本职是让「生成方案」在任何滚动位置都点得到。 */
  const [rulesOpen, setRulesOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  /* 助手抽屉关上后，左栏入口条要能说清"上次它干了什么"，
     否则用户不知道现在这几路需求是自己加的还是助手生成的。 */
  const [assistantSummary, setAssistantSummary] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [projectNotice, setProjectNotice] = useState(
    restored ? { kind: "ok", text: "已恢复上次的工程" } : null,
  );
  const workerRef = useRef(null);
  const requestIdRef = useRef(0);
  const projectFileRef = useRef(null);
  const fanoutFileRef = useRef(null);
  const fanoutSolutionRef = useRef(null);
  const peripheralCatalog = useMemo(() => buildPeripheralCatalog(mcu, mcuRecord.uiProfile), [mcu, mcuRecord.uiProfile]);

  useEffect(() => {
    const worker = new Worker(new URL("./lib/solver.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (event) => {
      if (event.data.id !== requestIdRef.current) return; // 丢弃被新请求取代的旧响应
      setPending(false);
      setResult(event.data.error ? { error: event.data.error, solutions: [] } : event.data.result);
      setActiveIndex(0);
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  const currentSignature = inputSignature(requests, options, excludedPins, lockedGroups);
  const isStale = Boolean(result) && resultSignature !== null && resultSignature !== currentSignature;

  /* 自动保存当前工程。刷新即丢是这个工具最大的短板——不能存就没法评审、
     没法分享、没法对比两版方案。写失败（隐私模式、配额满）不影响使用。 */
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(PROJECT_STORAGE_KEY, projectToJson(serializeProject({
        mcuId: selectedMcuId,
        mcu,
        requests,
        options,
        excludedPins,
        lockedGroups,
        solution: result?.solutions?.[activeIndex] || result?.solutions?.[0] || null,
        activeIndex,
      })));
    } catch {
      /* 存不下就算了，不打断操作 */
    }
  }, [selectedMcuId, mcu, requests, options, excludedPins, lockedGroups, result, activeIndex]);
  const pinnedInstances = useMemo(
    () => new Set(requests.filter((request) => request.instance).map((request) => `${request.type}:${request.instance}`)),
    [requests],
  );
  /* 需求总脚数。LQFP100 只有 82 个可用 GPIO，先把这个数摆出来，
     用户加到第 4 路 SDMMC 时就该察觉不对，而不是等求解器报无解。
     模拟变体给的是 channels（一路一个脚），数字变体给的是 signals 列表。 */
  const plannedPinCount = requests.reduce((sum, request) => {
    const variant = DEFINITIONS[request.type].variants[request.variant];
    return sum + (variant?.signals?.length ?? variant?.channels ?? 0);
  }, 0);
  const gpioBudget = useMemo(() => mcu.pins.filter((pin) => pin.kind === "gpio").length, [mcu]);

  const activeSolution = result?.solutions?.[activeIndex] || result?.solutions?.[0];
  const assignedPins = useMemo(() => {
    const map = new Map();
    for (const group of activeSolution?.groups || []) {
      for (const assignment of group.assignments) map.set(assignment.pin.number, group);
    }
    return map;
  }, [activeSolution]);

  /* 换片子要先把那颗的引脚表取回来。加载期间保持旧片子显示（而不是清空成
     白屏），失败就留在原地并说明原因——切不过去总比切到一颗空片子好。 */
  /* 换片子要重置的全部状态。固化器件和按需器件都走这里，保证两条路径不会
     漏掉某一项（漏了的话，比如锁定组留着上一颗片子的引脚，会一直错到导出）。 */
  function applyMcu(nextId, nextMcu, nextRecord) {
    requestIdRef.current += 1;
    setSelectedMcuId(nextId);
    setRequests(createDefaultRequests(requestTypesFor(nextMcu, nextRecord.uiProfile)));
    setExcludedPins(new Set());
    setSelectedPin(nextMcu.pins.find((pin) => pin.kind === "gpio") || nextMcu.pins[0]);
    setSearch("");
    setResult(null);
    setResultSignature(null);
    setPending(false);
    setActiveIndex(0);
    setLockedGroups([]);
    setActivePeripheral(null);
    setDetailFocus("pin");
    setHighlightedPeripheral(null);
    /* 基线是按当前 MCU 校验过的，换片子后不再可比 */
    setBaseline(null);
    setProjectNotice(null);
  }

  async function handleMcuChange(nextId) {
    if (nextId === selectedMcuId || !nextId) return;
    const nextRecord = getMcuById(nextId);
    let nextMcu = nextRecord.data;
    if (!nextMcu) {
      setMcuLoading(true);
      try {
        nextMcu = await ensureMcuLoaded(nextId);
      } catch {
        setMcuLoading(false);
        setProjectNotice({ kind: "error", text: `${catalogLabel(nextRecord)} 的引脚数据加载失败` });
        return;
      }
      setMcuLoading(false);
    }
    setMcuNotice(null);
    applyMcu(nextId, nextMcu, nextRecord);
  }

  /*
    选中索引里的按需器件：本地服务器现场把厂商库转成引脚数据。

    失败信息要原样透出（本机没装 CubeMX、这颗片子转换不出来、静态部署没有接口
    三种情况的处理方式完全不同），成功时也要把冒烟求解的提示带出来——比如某颗
    片子的以太网命名对不上，与其让人排半天才发现无解，不如当场说清楚。
  */
  async function handleMcuPick(entry) {
    if (entry.id === selectedMcuId) return;
    setMcuLoading(true);
    setMcuNotice(null);
    try {
      const { record, data, warnings, cached } = await fetchRuntimeMcu(entry);
      setMcuLoading(false);
      applyMcu(record.id, data, record);
      setMcuNotice(warnings.length > 0
        ? { kind: "warn", text: `${record.partNumber}：${warnings.join("；")}` }
        : { kind: "ok", text: `${record.partNumber} 已载入${cached ? "（缓存）" : ""}，未固化进目录` });
    } catch (error) {
      setMcuLoading(false);
      setMcuNotice({ kind: "error", text: `${entry.part} 加载失败：${error.message}` });
    }
  }

  /*
    从外设配置直接加/减一路需求。

    加进来的需求**锁定实例**（instance: item.instance）——用户点的是 SPI3 而不是
    "随便一路 SPI"，求解器不该把它换成 SPI1。想放开限制的话在接口需求那边把实例
    改回"任意"即可。

    变体用该类型的默认值（SPI 三线、UART 收发、ADC 一路…）。这里不猜用户要几路
    ADC 或要不要硬件流控——那些在接口需求行里一眼可改，而在侧栏里多塞一个选择
    反而挡住了"快速勾几个外设"这件事本身。

    与检视面板那个「固定/取消固定」不是一回事：那个只改某一路需求锁不锁实例，
    需求本身留着；这里管的是这一路要不要。两者共用 pinnedInstances 作指示，
    所以加的时候必须先认领已有的同类型未锁定需求——否则用检视面板取消固定后，
    侧栏会显示成"未加入"，再点一下就多出重复的一路。
  */
  function togglePeripheralRequest(item) {
    if (!item?.type || !item?.instance) return;
    const pinned = requests.find((request) => request.type === item.type && request.instance === item.instance);
    if (pinned) {
      updateRequests(requests.filter((request) => request.id !== pinned.id));
      /* 锁定组按需求 id 记，删了需求就得把对应的锁一起撤掉，
         否则求解时会拿着一个没有主人的锁去占脚。 */
      setLockedGroups((current) => current.filter((group) => group.requestId !== pinned.id));
      return;
    }
    const free = requests.find((request) => request.type === item.type && !request.instance);
    updateRequests(free
      ? requests.map((request) => (request.id === free.id ? { ...request, instance: item.instance } : request))
      : [...requests, createRequest(item.type, { instance: item.instance })]);
  }

  function selectPeripheral(peripheral) {
    const inheritsTimerMode = peripheral?.instance && peripheral?.type === "TIM"
      && activePeripheral?.timerMode
      ? activePeripheral.timerMode
      : null;
    const nextPeripheral = inheritsTimerMode && !peripheral.timerMode
      ? { ...peripheral, timerMode: inheritsTimerMode }
      : peripheral;
    setActivePeripheral(nextPeripheral);
    setDetailFocus("peripheral");
    setHighlightedPeripheral((current) => (
      current?.id === nextPeripheral?.id && current?.timerMode === nextPeripheral?.timerMode
        ? null
        : (nextPeripheral?.instance || nextPeripheral?.timerMode ? nextPeripheral : null)
    ));
  }

  function selectPackagePin(pin) {
    setSelectedPin(pin);
    setDetailFocus("pin");
    setHighlightedPeripheral(null);
  }

  /* 从外设详情的候选列表里点一个脚：目的是"在封装图里定位它"，不是"改看这个脚"。
     所以右栏留在外设详情上——否则每点一个候选，正在对照的候选列表就消失了。 */
  function selectPeripheralPin(pin) {
    setSelectedPin(pin);
    setHighlightedPeripheral(null);
  }

  /* 求解的唯一入口。改需求行时会顺带丢弃不再匹配任何请求的锁，
     否则求解器会把它们当成多余的锁剥离掉，用户看到的是莫名其妙的告警。 */
  function runAllocation(next = {}) {
    const nextRequests = next.requests ?? requests;
    const nextLocks = next.lockedGroups ?? lockedGroups;
    const nextExcluded = next.excludedPins ?? excludedPins;
    const nextOptions = next.options ?? options;
    setHighlightedPeripheral(null);
    requestIdRef.current += 1;
    setResultSignature(inputSignature(nextRequests, nextOptions, nextExcluded, nextLocks));
    setPending(true);
    workerRef.current?.postMessage({
      id: requestIdRef.current,
      mcu,
      requirements: nextRequests,
      options: { ...nextOptions, excludedPins: [...nextExcluded], maxSolutions: 5 },
      lockedGroups: nextLocks,
    });
  }

  /* 改需求行不自动重跑——用户往往要连改好几行，每改一次都跑一遍
     既慢又干扰。改完点"生成方案"，期间按钮和封装图会标记为已过期。 */
  function updateRequests(nextRequests) {
    setHighlightedPeripheral(null);
    setRequests(nextRequests);
    const live = new Set(nextRequests.map((request) => `${request.type}:${request.variant}`));
    setLockedGroups((current) => current.filter((group) => live.has(`${group.type}:${group.variant}`)));
  }

  function toggleExclude(pin) {
    setHighlightedPeripheral(null);
    const next = new Set(excludedPins);
    if (next.has(pin.number)) next.delete(pin.number);
    else next.add(pin.number);
    const filteredLocks = lockedGroups.filter((group) => !group.assignments.some((item) => item.pin.number === pin.number));
    setExcludedPins(next);
    setLockedGroups(filteredLocks);
    if (result) runAllocation({ lockedGroups: filteredLocks, excludedPins: next });
  }

  function toggleLock(group) {
    setHighlightedPeripheral(null);
    const exists = lockedGroups.some((item) => item.type === group.type && item.instance === group.instance);
    const next = exists
      ? lockedGroups.filter((item) => !(item.type === group.type && item.instance === group.instance))
      : [...lockedGroups, { ...group, locked: true }];
    setLockedGroups(next);
    runAllocation({ lockedGroups: next });
  }

  /* 侧边栏的"固定为 SPI1"：优先把同类型里第一个"自动选择"的需求行改成这个实例，
     一行都没有就新增一行。这样点一下就能表达"这块板子非 SPI1 不可"，
     不必先回需求列表手动加行。 */
  function toggleFixed(peripheral) {
    if (!peripheral?.type || !peripheral.instance) return;
    const { type, instance } = peripheral;
    const pinned = requests.find((request) => request.type === type && request.instance === instance);
    if (pinned) {
      updateRequests(requests.map((request) => (
        request.id === pinned.id ? { ...request, instance: null } : request
      )));
      return;
    }
    const free = requests.find((request) => request.type === type && !request.instance);
    updateRequests(free
      ? requests.map((request) => (request.id === free.id ? { ...request, instance } : request))
      : [...requests, createRequest(type, { instance })]);
  }

  function updateOptions(patch) {
    setHighlightedPeripheral(null);
    setOptions((current) => ({ ...current, ...patch }));
  }

  function applyAssistantAnalysis(analysis, generate = false) {
    const nextRequests = analysisToRequestRows(analysis).filter((request) => requestTypes.includes(request.type));
    if (!nextRequests.length) return;
    const nextOptions = {
      ...options,
      ...(analysis.constraints.some((constraint) => constraint.kind === "protectDebug") ? { protectDebug: true } : {}),
      ...(analysis.constraints.some((constraint) => constraint.kind === "protectOscillator") ? { protectOscillator: true } : {}),
    };
    updateRequests(nextRequests);
    setOptions(nextOptions);
    /* 应用完就收起抽屉：结果（接口需求行、或者直接是方案）在它后面，
       盖着看不见等于让人再点一次关闭。 */
    setAssistantSummary(analysis.summary);
    setAssistantOpen(false);
    if (generate) runAllocation({ requests: nextRequests, options: nextOptions, lockedGroups: [] });
  }

  function exportSolution(solution, formatId) {
    /* 扇出网络标签这一项要先要一份 EDA 导出的模板才能填，走文件选择那条路。
       记下当前方案：文件选完可能已经过了几秒，那时再去读 activeIndex 未必还是
       用户点导出时看的那一套。 */
    if (EXPORT_FORMATS.find((item) => item.id === formatId)?.needsTemplate) {
      fanoutSolutionRef.current = solution;
      fanoutFileRef.current?.click();
      return;
    }
    downloadSolution(mcu, solution, formatId);
  }

  /* 填好的扇出表格是 UTF-16 LE 的字节，不是文本——必须原样交给 Blob，
     经一手字符串会被当成 UTF-8 再编码一遍，EDA 就不认了。 */
  function downloadBytes(bytes, fileName, mime) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function fillFanoutTemplate(file) {
    const solution = fanoutSolutionRef.current;
    if (!solution) return;
    try {
      const filled = fillFanout(decodeFanoutFile(await file.arrayBuffer()), mcu, solution);
      downloadBytes(encodeFanoutFile(filled.text), fanoutFileName(mcu), "text/csv");
      const { signal, power, cleared } = filled.stats;
      setProjectNotice({
        kind: filled.warnings.length > 0 ? "warn" : "ok",
        text: [
          `${filled.designator}：填了 ${signal} 个信号脚、${power} 个电源脚，`
            + `清空 ${cleared} 个未分配脚的网络名。导回 EDA 前先在表格里过一眼。`,
          ...filled.warnings,
        ].join("　"),
      });
    } catch (error) {
      setProjectNotice({ kind: "error", text: error.message });
    }
  }

  function downloadText(text, fileName, mime = "application/json") {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function saveProject() {
    downloadText(projectToJson(serializeProject({
      mcuId: selectedMcuId,
      mcu,
      requests,
      options,
      excludedPins,
      lockedGroups,
      solution: result?.solutions?.[activeIndex] || result?.solutions?.[0] || null,
      activeIndex,
    })), projectFileName(mcu));
    setProjectNotice({ kind: "ok", text: "已导出工程文件" });
  }

  /* 载入工程：整份状态替换掉当前的。载入的方案是快照而不是求解结果，
     所以签名一并设成载入后的输入，避免一进来就显示"已过期"。 */
  async function openProjectFile(file) {
    const loaded = await loadProjectFile(file);
    if (!loaded.ok) {
      setProjectNotice({ kind: "error", text: loaded.errors.join("；") });
      return;
    }
    const next = loaded.value;
    requestIdRef.current += 1;
    setSelectedMcuId(next.mcuId);
    setRequests(next.requests);
    setOptions(next.options);
    setExcludedPins(next.excludedPins);
    setLockedGroups(next.lockedGroups);
    setResult(restoredResult(next.plan));
    setResultSignature(inputSignature(next.requests, next.options, next.excludedPins, next.lockedGroups));
    setPending(false);
    setActiveIndex(0);
    setActivePeripheral(null);
    setDetailFocus("pin");
    setHighlightedPeripheral(null);
    setSelectedPin(getMcuById(next.mcuId).data.pins.find((pin) => pin.kind === "gpio"));
    setProjectNotice({
      kind: loaded.warnings.length ? "warn" : "ok",
      text: loaded.warnings.length ? `已载入 ${file.name}，但有问题：${loaded.warnings.join("；")}` : `已载入 ${file.name}`,
    });
  }

  async function loadBaselineFile(file) {
    const loaded = await loadProjectFile(file);
    if (!loaded.ok) {
      setProjectNotice({ kind: "error", text: `基线载入失败：${loaded.errors.join("；")}` });
      return;
    }
    if (loaded.value.mcuId !== selectedMcuId) {
      setProjectNotice({ kind: "error", text: "基线用的是另一颗 MCU，无法与当前方案对比" });
      return;
    }
    if (!loaded.value.plan) {
      setProjectNotice({ kind: "error", text: "这份基线文件里没有保存方案，无从对比" });
      return;
    }
    setBaseline({ name: file.name, plan: loaded.value.plan, requests: loaded.value.requests });
    setProjectNotice({ kind: "ok", text: `已载入基线 ${file.name}` });
  }

  function resetProject() {
    requestIdRef.current += 1;
    setRequests(createDefaultRequests(requestTypes));
    setOptions({ ...readPreferences().solverDefaults });
    setExcludedPins(new Set());
    setLockedGroups([]);
    setResult(null);
    setResultSignature(null);
    setPending(false);
    setActiveIndex(0);
    setBaseline(null);
    setActivePeripheral(null);
    setDetailFocus("pin");
    setHighlightedPeripheral(null);
    setProjectNotice({ kind: "ok", text: "已重置为空工程" });
  }

  return (
    <main>
      <header className="app-header">
        <div>
          <span className="product-kicker">MCU PIN PLANNER</span>
          <h1>MCU 引脚规划器</h1>
        </div>
        <div className="header-tools">
          <div className="header-utility">
            <button type="button" className="utility-button" onClick={() => setTourOpen(true)} title="重新观看新手教程">
              新手教程
            </button>
            <button type="button" className="utility-button" onClick={() => setCenterOpen(true)} title="本地偏好与记录">
              个人中心
            </button>
          </div>
          <ThemeSwitch mode={themeMode} resolved={resolvedTheme} onChange={handleThemeChange} />
          <McuSelector
            catalog={MCU_CATALOG}
            selectedId={selectedMcuId}
            onChange={handleMcuChange}
            onPick={handleMcuPick}
            loading={mcuLoading}
            notice={mcuNotice}
          />
          <div className="project-tools">
            <span>工程</span>
            <button type="button" onClick={saveProject}>保存</button>
            <button type="button" onClick={() => projectFileRef.current?.click()}>载入</button>
            <button type="button" onClick={resetProject}>重置</button>
            <input
              ref={projectFileRef}
              type="file"
              accept=".json,.pinplan.json,application/json"
              aria-label="载入工程文件"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) openProjectFile(file);
                event.target.value = "";
              }}
            />
            {/* 「导出 → 嘉立创 扇出网络标签」触发的模板选择框。放在这里而不是
                导出下拉里，是因为下拉一点就收起，里面的 input 会跟着卸载。 */}
            <input
              ref={fanoutFileRef}
              type="file"
              accept=".csv,.txt,text/csv"
              aria-label="选择 EDA 导出的扇出网络标签表格"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) fillFanoutTemplate(file);
                event.target.value = "";
              }}
            />
          </div>
          <div className="source-badge">
            <span>官方数据源</span>
            <strong>{mcu.source.document} Rev {mcu.source.revision}</strong>
          </div>
        </div>
      </header>
      {projectNotice && (
        <p className={`project-notice project-notice-${projectNotice.kind}`} aria-live="polite">
          {projectNotice.text}
          <button type="button" onClick={() => setProjectNotice(null)} aria-label="关闭提示">×</button>
        </p>
      )}

      <div className="workspace">
        <aside className="control-panel">
          <div className="control-panel-scroll">
            {/* 助手本体在右侧抽屉里，这里只留入口——见 RequirementsAssistant 顶部注释 */}
            <button type="button" className="assistant-entry" onClick={() => setAssistantOpen(true)}>
              <span className="assistant-entry-kicker">AI WORKFLOW</span>
              <strong>工程需求助手</strong>
              <small>{assistantSummary || "用一句话描述板子要接的模块，自动生成接口需求"}</small>
            </button>
            <PeripheralSidebar
              catalog={peripheralCatalog}
              activePeripheral={activePeripheral}
              onSelect={selectPeripheral}
              onToggleRequest={togglePeripheralRequest}
              pinnedInstances={pinnedInstances}
              defaultOpenSection={mcuRecord.uiProfile === "ti-mspm0" ? "communications" : "connectivity"}
            />
            <section>
              <div className="section-heading">
                <h2>接口需求</h2>
              </div>
              <p>一行一路接口，接线方式、外设实例和方位偏好逐路独立设置。</p>
              <div className="request-list">
                {requests.map((request, index) => (
                  <RequestRow
                    key={request.id}
                    mcu={mcu}
                    request={request}
                    index={index}
                    typeOrder={requestTypes}
                    onChange={(next) => updateRequests(requests.map((item) => (item.id === request.id ? next : item)))}
                    onRemove={() => updateRequests(requests.filter((item) => item.id !== request.id))}
                  />
                ))}
                {requests.length === 0 && <p className="muted">还没有接口需求，先添加一路。</p>}
              </div>
              <div className="request-add">
                <span>添加</span>
                {requestTypes.map((type) => (
                  <button key={type} type="button" onClick={() => updateRequests([...requests, createRequest(type)])}>
                    {DEFINITIONS[type].label}
                  </button>
                ))}
              </div>
            </section>
          </div>

          {/*
            常驻操作条。左栏的内容长度是没有上限的（外设导航一类就能上千像素），
            把唯一的出口按钮留在文档流末尾等于要求用户先滚三屏才能求解。
            预算徽标一并搬过来：它是"还能不能再加一路"的唯一提示，滚走了就等于没有。
          */}
          <div className="control-panel-actions">
            <div className="action-summary">
              <span className={`section-count${plannedPinCount > gpioBudget ? " is-over" : ""}`}>
                {requests.length} 路 · {plannedPinCount} / {gpioBudget} 脚
              </span>
              <div className="action-disclosures">
                <button
                  type="button"
                  className={`action-disclosure${rulesOpen ? " is-open" : ""}`}
                  aria-expanded={rulesOpen}
                  onClick={() => setRulesOpen((open) => !open)}
                >
                  分配规则
                </button>
                <button
                  type="button"
                  className={`action-disclosure${legendOpen ? " is-open" : ""}`}
                  aria-expanded={legendOpen}
                  onClick={() => setLegendOpen((open) => !open)}
                >
                  图例
                </button>
              </div>
            </div>
            {rulesOpen && (
              <div className="action-rules">
                <Toggle checked={options.protectDebug} onChange={(value) => updateOptions({ protectDebug: value })}>保护调试引脚</Toggle>
                <Toggle checked={options.protectOscillator} onChange={(value) => updateOptions({ protectOscillator: value })}>保护晶振引脚</Toggle>
              </div>
            )}
            {legendOpen && (
              <div className="legend" aria-label="颜色说明">
                {[...new Set(requests.map((request) => request.type))].map((type) => (
                  <span key={type}>
                    <i className={`legend-${DEFINITIONS[type].protocol}`} />{DEFINITIONS[type].label}
                  </span>
                ))}
                <span><i className="legend-protected" />保护</span>
                <span><i className="legend-excluded" />排除</span>
              </div>
            )}
            <button
              type="button"
              className={`primary-button solve-button${isStale ? " is-stale" : ""}`}
              onClick={() => runAllocation()}
              disabled={pending}
            >
              {pending ? "搜索中…" : isStale ? "重新生成方案" : "生成方案"}
            </button>
          </div>
        </aside>

        <section className="pinout-panel">
          <div className="pinout-toolbar">
            <div>
              <span>{mcu.package}</span>
              <strong>{mcu.pinCount} PIN · {mcu.packageSize}</strong>
            </div>
            <label>
              <span className="sr-only">搜索引脚或功能</span>
              <input value={search} onChange={(event) => { setHighlightedPeripheral(null); setSearch(event.target.value); }} placeholder="搜索 PA5、SPI1_SCK、ADC..." />
            </label>
          </div>
          <PackageView
            mcuData={mcu}
            pins={mcu.pins}
            selectedPin={selectedPin}
            onSelect={selectPackagePin}
            excludedPins={excludedPins}
            assignedPins={assignedPins}
            search={search}
            stale={isStale}
            highlightedPeripheral={highlightedPeripheral}
            onClearPeripheralHighlight={() => setHighlightedPeripheral(null)}
          />
        </section>

        <aside className="detail-panel">
          {/*
            检视区。外设详情原先长在左栏里，选中一个 SPI 就在导航和接口需求之间
            塞进最多 400px——恰恰是反复点外设的时候，下面的东西被顶得最远。
            它和引脚详情本就是同一类东西（"当前选中对象的全部信息"），
            挪到右栏互斥切换，两边都不再被对方撑长。
          */}
          <div className="detail-tabs" role="tablist" aria-label="检视对象">
            <button
              type="button"
              role="tab"
              aria-selected={detailFocus === "pin"}
              className={detailFocus === "pin" ? "is-active" : ""}
              onClick={() => setDetailFocus("pin")}
            >
              引脚{selectedPin ? ` · ${selectedPin.name}` : ""}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={detailFocus === "peripheral"}
              className={detailFocus === "peripheral" ? "is-active" : ""}
              onClick={() => setDetailFocus("peripheral")}
            >
              外设{activePeripheral ? ` · ${activePeripheral.label}` : ""}
            </button>
          </div>
          {detailFocus === "peripheral" ? (
            <PeripheralInspector
              mcuData={mcu}
              peripheral={activePeripheral}
              pinnedInstances={pinnedInstances}
              onToggleFixed={toggleFixed}
              onSelectPin={selectPeripheralPin}
            />
          ) : (
            <PinInspector
              mcu={mcu}
              pin={selectedPin}
              excluded={selectedPin ? excludedPins.has(selectedPin.number) : false}
              onToggleExclude={() => selectedPin && toggleExclude(selectedPin)}
            />
          )}
          <div className="result-divider" />
          <SolutionPanel
            result={result}
            pending={pending}
            stale={isStale}
            onRerun={() => runAllocation()}
            activeIndex={activeIndex}
            setActiveIndex={setActiveIndex}
            lockedGroups={lockedGroups}
            onToggleLock={toggleLock}
            onExport={exportSolution}
          />
          {result?.solutions?.length > 0 && (
            <>
              <div className="result-divider" />
              <DiffPanel
                solutions={result.solutions}
                activeIndex={activeIndex}
                baseline={baseline}
                requests={requests}
                onLoadBaseline={loadBaselineFile}
                onClearBaseline={() => setBaseline(null)}
              />
            </>
          )}
        </aside>
      </div>

      <RequirementsAssistant
        mcuId={selectedMcuId}
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        onApply={applyAssistantAnalysis}
      />
      <Tour open={tourOpen} onClose={closeTour} />
      <PersonalCenter
        open={centerOpen}
        onClose={() => setCenterOpen(false)}
        preferences={preferences}
        onPreferencesChange={updatePreferences}
        themeMode={themeMode}
        resolvedTheme={resolvedTheme}
        onThemeChange={handleThemeChange}
        aiConfigured={Boolean(readAiConfig().endpoint)}
        currentMcuId={selectedMcuId}
        onPickRecent={(item) => {
          setCenterOpen(false);
          /* 固化器件走普通切换；按需器件要重新问服务器要一次数据 */
          if (item.runtime) handleMcuPick({ id: item.id, vendor: item.vendor, part: item.part, package: item.packageName });
          else handleMcuChange(item.id);
        }}
      />
    </main>
  );
}

export default App;
