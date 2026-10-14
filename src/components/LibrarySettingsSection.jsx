import { useState } from "react";
import { LIBRARY_NAMES, saveLibraryPaths } from "../lib/mcuCatalog.js";

/*
  个人中心里的"器件库"一节。

  选择器里三千多颗按需器件的引脚数据，靠本地服务读本机装的 CubeMX / SysConfig
  现场转换。默认路径找不到时（装在别的盘、改过安装目录），在这里指定。
  桌面版有"浏览…"（window.desktopShell），浏览器版只能手填——两条路都走同一个
  /api/libraries，校验在服务端做：找不到库的路径不会被保存。
*/

const HINTS = {
  st: "STM32CubeMX 安装目录或其下的 db 目录，如 C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeMX",
  ti: "SysConfig 安装目录或 C:\\ti，如 C:\\ti\\sysconfig_1.28.0",
};

function LibraryRow({ vendor, entry, onSaved }) {
  const [draft, setDraft] = useState(entry?.configured || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const shell = typeof window !== "undefined" ? window.desktopShell : null;

  async function save(value) {
    setBusy(true);
    setError(null);
    try {
      const status = await saveLibraryPaths({ [vendor]: value });
      setDraft(status[vendor]?.configured || "");
      onSaved(status);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  }

  async function browse() {
    const picked = await shell.pickFolder(`选择 ${LIBRARY_NAMES[vendor]} 的安装目录`);
    if (!picked) return;
    setDraft(picked);
    save(picked);
  }

  return (
    <li className="library-row">
      <div className="library-row-head">
        <strong>{LIBRARY_NAMES[vendor]}</strong>
        <span className={entry?.ok ? "library-ok" : "library-missing"}>
          {entry?.ok ? (entry.configured ? "已指定" : "自动检测到") : "未找到"}
        </span>
      </div>
      <small className="library-path">{entry?.ok ? entry.path : (entry?.error || "").split("\n")[0]}</small>
      <div className="library-row-edit">
        <input
          value={draft}
          placeholder={HINTS[vendor]}
          aria-label={`${LIBRARY_NAMES[vendor]} 路径`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && draft.trim()) save(draft); }}
        />
        {shell && <button type="button" disabled={busy} onClick={browse}>浏览…</button>}
        <button type="button" disabled={busy || !draft.trim()} onClick={() => save(draft)}>保存</button>
        {entry?.configured && (
          <button type="button" disabled={busy} onClick={() => save(null)}>自动检测</button>
        )}
      </div>
      {error && <p className="library-error">{error}</p>}
    </li>
  );
}

export default function LibrarySettingsSection({ status, onStatusChange }) {
  if (!status) return null;
  return (
    <section>
      <h3>器件库</h3>
      {!status.server ? (
        <p className="sheet-note">当前部署没有本地服务，按需器件不可用，只能使用内置的几颗型号。</p>
      ) : (
        <>
          <p className="sheet-note">
            选型页里的型号要从本机的厂商库现场转换引脚数据。没装的话只能用内置型号
            和 STM32C5 系列；装在非默认位置的，在这里指定一次即可。
          </p>
          <ul className="library-list">
            {["st", "ti"].map((vendor) => (
              <LibraryRow key={vendor} vendor={vendor} entry={status[vendor]} onSaved={onStatusChange} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
