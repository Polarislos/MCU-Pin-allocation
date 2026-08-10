/*
  主题：亮 / 暗 / 跟随时间。

  三种取值存在 localStorage：
    "auto"（默认）按本地时间自动切换，"light" / "dark" 是用户手动锁定。

  ── 为什么按时间而不是 prefers-color-scheme ────────────────────────
  需求就是"根据系统时间选"。这与系统的深色偏好是两回事：不少人系统常年浅色，
  但夜里看这种高密度的引脚图仍然刺眼。所以自动档只看钟点，不读系统偏好——
  两者混在一起会让"为什么现在是暗的"变得没法解释。

  ── 边界在哪 ────────────────────────────────────────────────────
  18:00–06:00 判为夜间。取整点边界而不是日出日落：日出日落要地理位置，
  为一个配色去要定位权限不值当，而且用户随时可以手动锁定。
*/

const STORAGE_KEY = "mcu-pin-planner:theme";
export const THEME_MODES = ["auto", "light", "dark"];

const NIGHT_FROM = 18;
const NIGHT_UNTIL = 6;

export function isNight(date = new Date()) {
  const hour = date.getHours();
  return hour >= NIGHT_FROM || hour < NIGHT_UNTIL;
}

/* 自动档解析成实际配色。手动档原样返回。 */
export function resolveTheme(mode, date = new Date()) {
  if (mode === "light" || mode === "dark") return mode;
  return isNight(date) ? "dark" : "light";
}

export function readThemeMode() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return THEME_MODES.includes(stored) ? stored : "auto";
  } catch {
    /* 隐私模式下 localStorage 会抛错。主题不是关键功能，退回自动档即可。 */
    return "auto";
  }
}

export function writeThemeMode(mode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch { /* 存不下就只在本次会话生效 */ }
}

/*
  把配色写到根元素上。

  CSS 里是 :root[data-theme="dark"]，所以亮色不需要标记——但仍然显式写上
  data-theme="light"，这样"当前到底是哪一套"在 DevTools 里一眼可见，
  排查时不用去猜是"亮色"还是"属性没设上"。
*/
export function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  /* 表单控件、滚动条这些浏览器原生部件跟着走，否则暗色页面上会出现
     一条刺眼的白色滚动条。 */
  root.style.colorScheme = theme;
}

/*
  自动档要在跨过边界时自己切过去——有人会把这个页面开一整天。

  只在自动档下起效，回调收到的是解析后的配色。定时器对齐到下一个整点而不是
  每分钟轮询：一天只醒 24 次，且不会因为漂移错过边界。
*/
export function watchAutoTheme(onChange) {
  let timer = null;
  const tick = () => {
    onChange(resolveTheme("auto"));
    const now = new Date();
    const next = new Date(now);
    next.setHours(now.getHours() + 1, 0, 0, 0);
    timer = setTimeout(tick, Math.max(1000, next - now));
  };
  tick();
  return () => clearTimeout(timer);
}
