/**
 * 演示模式启动器:npm run demo
 *
 * 用一个**独立的演示库**(data/trendscope-demo.db)启动应用,并自动装载内置示例数据。
 * 这样"体验完整产品链路"与"用户自己的数据"物理隔离:演示重置永远删不到正式库,
 * 而界面顶部会一直显示"演示模式"标记,不会让示例数字冒充真实热门内容。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist-server", "index.js");

if (!fs.existsSync(entry)) {
  console.error("[demo] 找不到构建产物 dist-server/index.js。请先运行:npm run build");
  process.exit(1);
}

process.env.TRENDSCOPE_DEMO = "1";
process.env.TRENDSCOPE_DB = process.env.TRENDSCOPE_DB || path.join(root, "data", "trendscope-demo.db");
if (!process.env.PORT) process.env.PORT = "5185";

console.log("[demo] 演示模式 —— 独立演示库:" + process.env.TRENDSCOPE_DB);
console.log("[demo] 演示模式默认端口:" + process.env.PORT + "(与正式实例 5184 不冲突,可同时运行)");
await import(pathToFileURL(entry).href);
