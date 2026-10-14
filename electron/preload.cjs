/*
  页面和主进程之间只开这几个口子。浏览器版里没有 window.appUpdater，
  界面据此隐藏"软件更新"一节——两种形态共用同一份前端代码。
  sandbox 模式下 preload 只能是 CommonJS。
*/
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("appUpdater", {
  getState: () => ipcRenderer.invoke("updater:getState"),
  check: () => ipcRenderer.invoke("updater:check"),
  download: () => ipcRenderer.invoke("updater:download"),
  install: () => ipcRenderer.invoke("updater:install"),
  openReleases: () => ipcRenderer.invoke("app:openExternal", "https://github.com/Polarislos/MCU-Pin-allocation/releases"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("updater:state", listener);
    return () => ipcRenderer.removeListener("updater:state", listener);
  },
});

contextBridge.exposeInMainWorld("desktopShell", {
  pickFolder: (title) => ipcRenderer.invoke("dialog:pickFolder", title),
});
