#!/usr/bin/env node
/**
 * npm run doctor —— 安装/启动体检(§48)。只读检查,不写库。
 * 退出码:有 FAIL → 1;只有 WARN 或全 PASS → 0(方便脚本判断"能不能装")。
 */
import { runChecks, summarize } from "../server/src/doctor";

// 体检与冒烟必须和应用程序读同一份 .env,否则用户按 README 配好密钥后这里仍报"未配置"
import { loadDotEnv } from "../server/src/env";
loadDotEnv();

const results = await runChecks();
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const mark = r.level === "PASS" ? " PASS" : r.level === "WARN" ? " WARN" : " FAIL";
  console.log(`${mark}  ${r.name.padEnd(width)}  ${r.detail}`);
  if (r.hint) console.log(`        ${" ".repeat(width)}  → ${r.hint}`);
}
const s = summarize(results);
console.log("");
console.log(`doctor: ${s.line}`);
process.exit(s.failed > 0 ? 1 : 0);
