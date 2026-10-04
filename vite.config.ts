import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as { version: string };

/**
 * 开发时 API 打到哪一台服务端。`npm run dev` 用 tsx watch 起的服务默认就在这一台端口上,
 * 与 `PORT` 环境变量保持一致 —— 目标地址与下面两个头的端口必须是**同一个值**,
 * 否则本机边界闸门会因为"判定端口 ≠ 请求头端口"把开发请求整批拒掉。
 */
const DEV_API_PORT = Number(process.env.PORT ?? 5184);
const DEV_API_ORIGIN = `http://localhost:${DEV_API_PORT}`;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5183,
    proxy: {
      "/api": {
        target: DEV_API_ORIGIN,
        changeOrigin: true,
        /**
         * 服务端有一道本机边界闸门(`server/src/local-guard.ts`):`Origin`/`Referer` 带了就必须
         * 落在回环的**同一个端口**上。开发时页面在 5183,浏览器发来的 `Origin` 是
         * `http://localhost:5183`,而请求实际打到 5184 —— 端口不符就会被拒。
         * 这一跳是本机自己的代理,不是外站,但判定只看头、不看意图,所以由代理把这两个头
         * 写成它真正转去的那个地址(只影响 dev;`changeOrigin` 已经改了 Host,这里补齐同源的那两头)。
         */
        headers: { origin: DEV_API_ORIGIN, referer: `${DEV_API_ORIGIN}/` },
      },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 900,
  },
});
