import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { mcuOnDemand } from "./tools/vite-mcu-server.mjs";

export default defineConfig({
  /* mcuOnDemand 提供 /api/mcu：选择器里 3000+ 个器件的引脚数据不打包，
     选中时由本地服务器现场从 CubeMX / SysConfig 库转换。见
     tools/vite-mcu-server.mjs 顶部关于"静态部署会退化"的说明。 */
  plugins: [react(), mcuOnDemand()],
  server: {
    host: "127.0.0.1",
    port: 4173,
  },
});
