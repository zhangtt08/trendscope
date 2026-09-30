/**
 * 重置演示库:npm run demo:reset
 *
 * 只允许删除 data/trendscope-demo.db(以及它的 -wal / -shm)。文件名不匹配就拒绝执行 ——
 * 这个检查存在的意义正是"任何时候敲错命令都不会毁掉真实数据"。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = "trendscope-demo.db";
const target = path.join(root, "data", DEMO);

if (path.basename(target) !== DEMO) {
  console.error(`[demo:reset] 拒绝执行:目标文件名必须是 ${DEMO}`);
  process.exit(1);
}

let removed = 0;
for (const suffix of ["", "-wal", "-shm"]) {
  const f = target + suffix;
  if (fs.existsSync(f)) {
    fs.rmSync(f);
    removed += 1;
    console.log(`[demo:reset] 已删除:${f}`);
  }
}

const main = path.join(root, "data", "trendscope.db");
console.log(
  removed
    ? `[demo:reset] 演示库已重置(${removed} 个文件)。下次 npm run demo 会重新建立并装载示例数据。`
    : "[demo:reset] 没有发现演示库,无需重置。",
);
console.log(`[demo:reset] 正式库未被触碰:${fs.existsSync(main) ? "存在" : "尚未创建"} —— ${main}`);
