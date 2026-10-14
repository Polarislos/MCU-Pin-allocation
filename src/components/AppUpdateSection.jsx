import { useEffect, useState } from "react";

/*
  个人中心里的"软件更新"一节，只在桌面版里出现。

  状态全在主进程（electron/main.mjs），这里只是镜像：打开时取一次快照，
  之后靠 updater:state 推送。启动时的自动检查也会推过来，所以面板打开时
  看到的可能已经是"有新版本"。
*/

const STATUS_TEXT = {
  idle: "尚未检查",
  checking: "正在检查…",
  latest: "已是最新版本",
  available: "发现新版本",
  downloading: "正在下载…",
  downloaded: "已下载，重启后安装",
  error: "检查失败",
  unsupported: "开发模式下不检查更新",
};

function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond) return "";
  if (bytesPerSecond > 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  return `${Math.round(bytesPerSecond / 1024)} KB/s`;
}

export default function AppUpdateSection({ open }) {
  const updater = typeof window !== "undefined" ? window.appUpdater : null;
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!updater) return undefined;
    return updater.onState((next) => setState((current) => ({ ...current, ...next })));
  }, [updater]);

  useEffect(() => {
    if (updater && open) updater.getState().then(setState);
  }, [updater, open]);

  if (!updater || !state) return null;

  const { status } = state;
  const busy = status === "checking" || status === "downloading";

  return (
    <section>
      <h3>软件更新</h3>
      <div className="pref-row">
        <div>
          <strong>当前版本 {state.currentVersion}</strong>
          <small>
            {STATUS_TEXT[status] || status}
            {status === "available" && state.version ? `：${state.version}` : ""}
            {status === "downloading" ? ` ${Math.round(state.percent || 0)}% ${formatSpeed(state.bytesPerSecond)}` : ""}
          </small>
        </div>
        <div className="update-actions">
          {status === "available" && (
            <button type="button" onClick={() => updater.download()}>下载更新</button>
          )}
          {status === "downloaded" && (
            <button type="button" onClick={() => updater.install()}>重启并安装</button>
          )}
          {status !== "unsupported" && status !== "available" && status !== "downloaded" && (
            <button type="button" disabled={busy} onClick={() => updater.check()}>检查更新</button>
          )}
          <button type="button" onClick={() => updater.openReleases()}>发布页</button>
        </div>
      </div>
      {status === "downloading" && (
        <progress className="update-progress" max="100" value={state.percent || 0} />
      )}
      {status === "available" && state.notes && <pre className="update-notes">{state.notes}</pre>}
      {status === "error" && <p className="sheet-note">{state.error}</p>}
    </section>
  );
}
