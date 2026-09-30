import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as { version: string };

export default defineConfig({
  esbuild: { jsx: "automatic" },
  // 与 vite.config.ts 保持同一版本注入,否则测试里渲染 App 会引用未定义标识
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    // 计时类断言(perf-6b 的 30s 预算等)必须量到算法本身,而不是 CPU 争抢。
    // 并行时 5000×512 那组实测从 ~10s 被挤到 37s —— 同一份代码,纯因其它文件
    // 抢核而"失败"。串行总时长 84s(并行 41s),换来可复现的绿。
    // 注意:这是测试拓扑调整,**没有放宽任何阈值**,30s 预算一字未改。
    fileParallelism: false,
  },
});
