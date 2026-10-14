/*
  桌面版入口。

  ── 为什么主进程里还要起一个 http 服务 ──────────────────────────────
  页面用了 ES 模块和 type=module 的 Worker，file:// 打不开；按需器件又要
  /api/mcu 在本机读 CubeMX / SysConfig 库。所以和 start-pin-planner.ps1
  的思路一样：起一个只监听 127.0.0.1 的服务，静态文件 + 现有的 mcu 中间件。
  端口用 0 让系统分配，不会再和别的程序抢 4173。

  ── 更新 ────────────────────────────────────────────────────────────
  electron-updater 读 GitHub Release 里的 latest.yml，比对版本号、校验
  sha512、按 blockmap 差量下载。不自动下载：启动时查到新版本先问一句，
  个人中心里也能手动检查。只在打包后的应用里启用——开发时没有 app-update.yml。
*/
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import updaterPkg from "electron-updater";
import { createMcuMiddleware } from "../tools/vite-mcu-server.mjs";

const { autoUpdater } = updaterPkg;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = path.join(ROOT, "dist");
const DEV_URL = process.env.ELECTRON_DEV_URL;
const ICON = path.join(ROOT, "scripts", "pin-planner.ico");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

let mainWindow = null;

/* ── 本地服务 ────────────────────────────────────────────────────── */

async function serveStatic(request, response) {
  const { pathname } = new URL(request.url, "http://127.0.0.1");
  let file = path.join(DIST, decodeURIComponent(pathname));
  /* 拼出来的路径必须还在 dist 里，挡掉 ../ 越界 */
  if (file !== DIST && !file.startsWith(DIST + path.sep)) {
    response.statusCode = 403;
    return response.end();
  }
  const info = await stat(file).catch(() => null);
  if (!info || info.isDirectory()) file = path.join(DIST, "index.html"); // SPA 回退
  const body = await readFile(file);
  response.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
  response.end(body);
}

function startServer() {
  const mcu = createMcuMiddleware({ cacheDir: path.join(app.getPath("userData"), "mcu-cache"), mode: "desktop" });
  const server = createServer((request, response) => {
    mcu(request, response, () => {
      serveStatic(request, response).catch((error) => {
        response.statusCode = 500;
        response.end(String(error));
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/`));
  });
}

/* ── 窗口 ────────────────────────────────────────────────────────── */

async function createWindow() {
  const url = DEV_URL || await startServer();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    icon: ICON,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, "electron", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  /* 页面里的外链（数据手册、GitHub）交给系统浏览器，不在应用里开新窗口 */
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  await mainWindow.loadURL(url);
}

/* ── 更新 ────────────────────────────────────────────────────────── */

const updatesEnabled = app.isPackaged;
let updateState = { status: updatesEnabled ? "idle" : "unsupported" };
let promptedVersion = null;

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  mainWindow?.webContents.send("updater:state", updateState);
}

function releaseNotesText(notes) {
  if (!notes) return "";
  const text = Array.isArray(notes) ? notes.map((item) => item.note).join("\n") : String(notes);
  return text.replace(/<[^>]+>/g, "").trim().slice(0, 1200);
}

function setupUpdater() {
  if (!updatesEnabled) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => setUpdateState({ status: "checking", error: null }));
  autoUpdater.on("update-not-available", () => setUpdateState({ status: "latest", checkedAt: Date.now() }));
  autoUpdater.on("update-available", (info) => {
    setUpdateState({
      status: "available",
      checkedAt: Date.now(),
      version: info.version,
      releaseDate: info.releaseDate,
      notes: releaseNotesText(info.releaseNotes),
    });
    /* 启动检查查到新版本时问一次；同一个版本不反复弹 */
    if (promptedVersion !== info.version && mainWindow) {
      promptedVersion = info.version;
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "发现新版本",
        message: `MCU 引脚规划器 ${info.version} 已发布（当前 ${app.getVersion()}）`,
        detail: releaseNotesText(info.releaseNotes) || "可以在个人中心查看更新详情。",
        buttons: ["下载更新", "稍后"],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => { if (response === 0) startDownload(); });
    }
  });
  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.setProgressBar(progress.percent / 100);
    setUpdateState({ status: "downloading", percent: progress.percent, bytesPerSecond: progress.bytesPerSecond });
  });
  autoUpdater.on("update-downloaded", (info) => {
    mainWindow?.setProgressBar(-1);
    setUpdateState({ status: "downloaded", version: info.version, percent: 100 });
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "更新已下载",
      message: `${info.version} 已下载完成`,
      detail: "重启后完成安装。也可以稍后再装，退出应用时会自动安装。",
      buttons: ["立即重启", "稍后"],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => { if (response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on("error", (error) => {
    mainWindow?.setProgressBar(-1);
    setUpdateState({ status: "error", error: error?.message || String(error) });
  });
}

function checkForUpdates() {
  if (!updatesEnabled) return Promise.resolve(updateState);
  return autoUpdater.checkForUpdates().then(() => updateState, (error) => {
    setUpdateState({ status: "error", error: error?.message || String(error) });
    return updateState;
  });
}

function startDownload() {
  if (!updatesEnabled || updateState.status !== "available") return;
  setUpdateState({ status: "downloading", percent: 0 });
  autoUpdater.downloadUpdate().catch((error) => setUpdateState({ status: "error", error: error?.message || String(error) }));
}

ipcMain.handle("updater:getState", () => ({ ...updateState, currentVersion: app.getVersion() }));
ipcMain.handle("updater:check", () => checkForUpdates());
ipcMain.handle("updater:download", () => startDownload());
ipcMain.handle("updater:install", () => {
  if (updateState.status === "downloaded") autoUpdater.quitAndInstall();
});
ipcMain.handle("app:openExternal", (_event, target) => {
  if (/^https:\/\/github\.com\//i.test(target)) shell.openExternal(target);
});

/* ── 生命周期 ─────────────────────────────────────────────────────── */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    setupUpdater();
    try {
      await createWindow();
    } catch (error) {
      dialog.showErrorBox("MCU 引脚规划器启动失败", error?.stack || String(error));
      app.quit();
      return;
    }
    /* 等界面起来再查，网络慢时不拖累启动 */
    setTimeout(checkForUpdates, 3000);
  });

  app.on("window-all-closed", () => app.quit());
}
