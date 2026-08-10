import { useEffect, useMemo, useState } from "react";
import { STORAGE_KEYS, clearStorage, forgetMcu, storageUsage } from "../lib/preferences.js";
import { MCU_CATALOG, catalogLabel } from "../lib/mcuCatalog.js";

/*
  个人中心：本地偏好与记录。

  这个工具没有后端也没有账号，所以这里不是"用户资料"，而是把散落各处的本地
  状态收到一个地方——主题、默认器件、求解器默认开关、最近用过的器件、AI 云端
  配置的状态、以及这些东西占了多少浏览器存储。

  ── 为什么值得单独做一页 ────────────────────────────────────────────
  这些设置原来分别藏在顶栏、助手面板和"重置"按钮里，用户很难知道"我到底在这台
  机器上留下了什么"。尤其是 AI 配置里可能存着 API Key——它存在哪、要怎么删，
  必须有个明确的地方能看到。

  ── 清除是分类的 ────────────────────────────────────────────────────
  不提供一个笼统的"清除全部"就完事。工程存档和 API Key 的性质完全不同，
  混在一个按钮里会让人不敢点，或者点了才发现删多了。
*/

function formatBytes(bytes) {
  if (!bytes) return "空";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatWhen(timestamp) {
  if (!timestamp) return "";
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export default function PersonalCenter({
  open,
  onClose,
  preferences,
  onPreferencesChange,
  themeMode,
  resolvedTheme,
  onThemeChange,
  aiConfigured,
  onPickRecent,
  currentMcuId,
}) {
  const [usage, setUsage] = useState({});
  const [confirming, setConfirming] = useState(null);

  /* 用量是打开面板那一刻的快照，不需要实时——但每次打开都要重新量，
     否则清除之后数字还停在旧值，看起来像没删掉。 */
  useEffect(() => { if (open) setUsage(storageUsage()); }, [open]);

  const total = useMemo(() => Object.values(usage).reduce((sum, size) => sum + size, 0), [usage]);

  if (!open) return null;

  function update(patch) {
    onPreferencesChange(patch);
  }

  function doClear(names, label) {
    if (confirming !== label) return setConfirming(label);
    clearStorage(names);
    setUsage(storageUsage());
    setConfirming(null);
    if (names.includes("preferences")) onPreferencesChange(null); // 交给上层重读默认值
    return undefined;
  }

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="个人中心">
      <button type="button" className="sheet-scrim" aria-label="关闭" onClick={onClose} />
      <div className="sheet">
        <header className="sheet-head">
          <div>
            <span className="product-kicker">PERSONAL</span>
            <h2>个人中心</h2>
          </div>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="关闭">×</button>
        </header>

        <p className="sheet-intro">
          所有内容只保存在这台机器的浏览器里，不上传任何地方。共占用 {formatBytes(total)}。
        </p>

        <section>
          <h3>外观</h3>
          <div className="pref-row">
            <div>
              <strong>主题</strong>
              <small>自动档按本地时间切换：18:00–06:00 用暗色</small>
            </div>
            <div className="theme-switch" role="group" aria-label="主题">
              {[["auto", `自动·${resolvedTheme === "dark" ? "暗" : "亮"}`], ["light", "亮"], ["dark", "暗"]].map(([id, label]) => (
                <button key={id} type="button" aria-pressed={themeMode === id} onClick={() => onThemeChange(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section>
          <h3>默认设置</h3>
          <div className="pref-row">
            <div>
              <strong>启动时使用的器件</strong>
              <small>只能选已固化进目录的——按需器件要连本地服务器才取得回来</small>
            </div>
            <select
              value={preferences.defaultMcuId || ""}
              onChange={(event) => update({ defaultMcuId: event.target.value || null })}
            >
              <option value="">跟随内置默认</option>
              {MCU_CATALOG.map((item) => (
                <option key={item.id} value={item.id}>{catalogLabel(item)}</option>
              ))}
            </select>
          </div>
          <div className="pref-row">
            <div>
              <strong>新工程的求解器开关</strong>
              <small>只影响新建和重置，不改已打开的工程</small>
            </div>
            <div className="pref-checks">
              <label>
                <input
                  type="checkbox"
                  checked={preferences.solverDefaults.protectDebug}
                  onChange={(event) => update({
                    solverDefaults: { ...preferences.solverDefaults, protectDebug: event.target.checked },
                  })}
                />
                保护调试引脚
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferences.solverDefaults.protectOscillator}
                  onChange={(event) => update({
                    solverDefaults: { ...preferences.solverDefaults, protectOscillator: event.target.checked },
                  })}
                />
                保护晶振引脚
              </label>
            </div>
          </div>
        </section>

        <section>
          <h3>最近使用的器件</h3>
          {preferences.recentMcus.length === 0 ? (
            <p className="sheet-empty">还没有记录。切换器件后会出现在这里。</p>
          ) : (
            <ul className="recent-list">
              {preferences.recentMcus.map((item) => (
                <li key={item.id} className={item.id === currentMcuId ? "is-current" : ""}>
                  <button type="button" onClick={() => onPickRecent(item)} disabled={item.id === currentMcuId}>
                    <strong>{item.partNumber}</strong>
                    <span>{item.package}</span>
                    <em>{item.id === currentMcuId ? "当前" : formatWhen(item.at)}{item.runtime ? " · 按需" : ""}</em>
                  </button>
                  <button
                    type="button"
                    className="recent-forget"
                    aria-label={`从记录中移除 ${item.partNumber}`}
                    onClick={() => { forgetMcu(item.id); onPreferencesChange(null); }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3>本地数据</h3>
          <ul className="storage-list">
            <li>
              <div><strong>偏好设置</strong><small>主题、默认器件、最近记录</small></div>
              <span>{formatBytes(usage.preferences + usage.theme)}</span>
              <button type="button" onClick={() => doClear(["preferences", "theme"], "prefs")}>
                {confirming === "prefs" ? "确认清除？" : "清除"}
              </button>
            </li>
            <li>
              <div>
                <strong>工程自动存档</strong>
                <small>上次的需求、方案和锁定组</small>
              </div>
              <span>{formatBytes(usage.project)}</span>
              <button type="button" onClick={() => doClear(["project"], "project")}>
                {confirming === "project" ? "确认清除？" : "清除"}
              </button>
            </li>
            <li>
              <div>
                <strong>AI 云端配置</strong>
                <small>{aiConfigured ? "已配置，含接口地址与 API Key" : "未配置"}</small>
              </div>
              <span>{formatBytes(usage.aiConfig)}</span>
              <button type="button" onClick={() => doClear(["aiConfig"], "ai")} disabled={!usage.aiConfig}>
                {confirming === "ai" ? "确认清除？" : "清除"}
              </button>
            </li>
          </ul>
          <p className="sheet-note">
            工程也可以导出成 <code>.pinplan.json</code> 文件长期保存，不受这里清除的影响。
            按需器件的转换缓存在服务器上（<code>.cache/mcus/</code>），不在浏览器里。
          </p>
        </section>
      </div>
    </div>
  );
}

export { STORAGE_KEYS };
