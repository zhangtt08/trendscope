/**
 * 一次性收口(不是产品功能,是这次真机演练留下的尾巴):
 *  1. 演练任务采回的 10 行抖音热榜,来源被 runtime 的 default 分支记成了 json,
 *     而它们确实是浏览器采的 —— 修成 playwright,让"这条数据怎么来的"说实话;
 *  2. 演练任务本身改由应用的 DELETE /tasks/:id 删除(它会保留历史 Run)。
 * 动手前先 VACUUM INTO 落一份快照,改完打印前后计数。
 */
import Database from "better-sqlite3";
import { resolve } from "node:path";

const DB = resolve(process.cwd(), "data/trendscope.db");
const db = new Database(DB);
db.pragma("busy_timeout = 8000");

const snap = resolve(process.cwd(), "data/backup/pre-fix-browser-provenance-" + new Date().toISOString().replace(/[:.]/g, "-") + ".db");
db.prepare("VACUUM INTO ?").run(snap);
console.log("快照:", snap);

const WHERE = "platform = 'douyin' AND source_type = 'json' AND url LIKE '%/hot/%'";
const before = db.prepare(`SELECT COUNT(*) AS c FROM content_items WHERE ${WHERE}`).get() as { c: number };
console.log("待改的行(浏览器采回但记成 json):", before.c);

const ids = (
  db.prepare(`SELECT id FROM content_items WHERE ${WHERE} ORDER BY id`).all() as { id: number }[]
).map((r) => r.id);

const upd = db.prepare(`UPDATE content_items SET source_type = 'playwright' WHERE id = ?`);
const tx = db.transaction((list: number[]) => {
  let n = 0;
  for (const id of list) n += upd.run(id).changes;
  return n;
});
const changed = tx(ids);
console.log("已改为 playwright:", changed);

const after = db.prepare(`SELECT COUNT(*) AS c FROM content_items WHERE source_type = 'playwright'`).get() as { c: number };
console.log("现在标为浏览器采集的总行数:", after.c);
db.close();
console.log("演练任务的删除走应用自己的 DELETE /tasks/:id(它会保留历史 Run,taskName 是反规范化存的)");
