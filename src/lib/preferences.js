/*
  本地偏好。

  这个工具没有后端也没有账号，所谓"个人中心"就是把散落在各处的本地状态收到
  一处：主题、默认器件、求解器默认开关、最近用过的器件。AI 云端配置和工程
  自动存档各有各的键，不在这里重复管理——个人中心只负责把它们**展示**出来
  并提供清理入口。

  ── 为什么单独一个模块 ──────────────────────────────────────────────
  这些值原来散在 App.jsx 的 useState 初值、theme.js、和几处 localStorage 直读里。
  加个人中心时如果继续各写各的，"清除本地数据"就不可能做对——总会漏掉一两个键。
  所以键名在这里集中登记，STORAGE_KEYS 是唯一的真相来源。

  ── 写入失败不算错误 ────────────────────────────────────────────────
  隐私模式下 localStorage 直接抛异常。偏好不是关键路径，读不到就用默认值、
  写不进就只在本次会话生效，不该让整个页面挂掉。
*/

const PREFS_KEY = "mcu-pin-planner:preferences";

/* 本工具写入 localStorage 的**全部**键。清除数据和个人中心的用量统计都以此为准，
   新增任何持久化状态都要登记到这里。 */
export const STORAGE_KEYS = {
  preferences: PREFS_KEY,
  theme: "mcu-pin-planner:theme",
  aiConfig: "mcu-pin-planner.ai-config.v1",
  project: "mcu-pin-planner.project.v1",
};

const DEFAULTS = {
  /* null = 跟随目录的默认器件。存了 id 就下次打开直接用它。 */
  defaultMcuId: null,
  /* 新建需求时的求解器开关。与工程文件里存的那份是两回事：这是"新工程从
     什么状态开始"，工程文件存的是"这个工程当时是什么状态"。 */
  solverDefaults: { protectDebug: true, protectOscillator: true },
  /* 最近用过的器件，最新的在前 */
  recentMcus: [],
  /* 新手教程是否已经看过（看过就不再自动弹） */
  tourSeen: false,
};

const RECENT_LIMIT = 8;

function readRaw() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "null") || {};
  } catch {
    return {};
  }
}

export function readPreferences() {
  const stored = readRaw();
  return {
    ...DEFAULTS,
    ...stored,
    /* 嵌套对象要单独合并，否则旧版本存的残缺结构会把默认值整个顶掉 */
    solverDefaults: { ...DEFAULTS.solverDefaults, ...(stored.solverDefaults || {}) },
    recentMcus: Array.isArray(stored.recentMcus) ? stored.recentMcus : [],
  };
}

export function writePreferences(patch) {
  const next = { ...readPreferences(), ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch { /* 存不下就只在本次会话生效 */ }
  return next;
}

/*
  记一次器件使用。

  存的是快照而不是 id：按需器件不在固化目录里，下次开页面时 getMcuById() 找不到
  它，只有 id 的话最近列表就只能显示一串编号。快照里带上重新取回它所需的
  vendor / part / package，点一下就能再次加载。
*/
export function rememberMcu(record) {
  if (!record?.id) return readPreferences();
  const entry = {
    id: record.id,
    partNumber: record.partNumber,
    package: record.package,
    vendor: record.vendor,
    /* 按需器件重新加载要用的原始查询字段 */
    runtime: Boolean(record.runtime),
    part: record.partNumber,
    packageName: record.packageName || record.package,
    at: Date.now(),
  };
  const rest = readPreferences().recentMcus.filter((item) => item.id !== entry.id);
  return writePreferences({ recentMcus: [entry, ...rest].slice(0, RECENT_LIMIT) });
}

export function forgetMcu(id) {
  return writePreferences({ recentMcus: readPreferences().recentMcus.filter((item) => item.id !== id) });
}

/* 各键占了多少字节。个人中心据此显示"工程存档 12 KB"这类信息，
   让人知道清除会丢什么。 */
export function storageUsage() {
  const usage = {};
  for (const [name, key] of Object.entries(STORAGE_KEYS)) {
    try {
      const value = localStorage.getItem(key);
      usage[name] = value ? new Blob([value]).size : 0;
    } catch {
      usage[name] = 0;
    }
  }
  return usage;
}

/* 按类别清除。整体清空要显式传全部键名，避免"清一下偏好"顺手把工程也删了。 */
export function clearStorage(names) {
  for (const name of names) {
    try {
      localStorage.removeItem(STORAGE_KEYS[name]);
    } catch { /* 清不掉就算了 */ }
  }
}
