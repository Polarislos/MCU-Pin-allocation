import React from "react";
import ReactDOM from "react-dom/client";
import App, { bootstrapMcuId } from "./App.jsx";
import { ensureMcuLoaded } from "./lib/mcuCatalog.js";
import "./styles.css";

/* 运行时导入来自本机 CubeMX / SysConfig，任何未预料的数据差异都不应
   再把整个页面变成空白。把错误变成可读的恢复页，用户至少能重试或
   把具体错误反馈出来。 */
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app-error-screen">
        <div className="app-error-card">
          <span className="product-kicker">MCU PIN PLANNER</span>
          <h1>器件页面加载失败</h1>
          <p>{this.state.error.message || "发生了未预期的界面错误"}</p>
          <button type="button" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      </main>
    );
  }
}

/* 引脚表是懒加载的，所以先把这一次要用的那颗片子取回来再挂载。
   App 内部对"当前这颗片子"是同步取值的——先加载好，组件树里就不用到处
   铺加载态；换片子时的等待由 handleMcuChange 单独处理。 */
await ensureMcuLoaded(bootstrapMcuId());

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
