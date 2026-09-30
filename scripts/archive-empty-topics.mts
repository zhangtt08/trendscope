/**
 * 维护脚本:把"成员数为 0"的空话题转为 inactive,并先做一次可核对的快照备份。
 *
 * 为什么需要:清库事故之后话题表里留下了几条 0 成员的空壳(其中一条名字还是
 * "url id body" —— 事故期垃圾内容被关键词命名的产物)。它们不该出现在活跃话题、
 * 趋势与机会排名里,看起来像假数据。
 *
 * 为什么是归档而不是删除:0 成员话题里可能有人工命名(naming_source=manual),
 * 那是使用者的判断,不是算法产物;置为 inactive 可以一句话还原,删除不行。
 *
 * 用法:node --experimental-sqlite scripts/archive-empty-topics.mts [db 路径] [--dry-run]
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";

const file = process.argv[2] ?? "data/trendscope.db";
const dryRun = process.argv.includes("--dry-run");

if (!existsSync(file)) {
  console.error(`找不到数据库文件:${file}`);
  process.exitCode = 1;
} else {
  const db = new DatabaseSync(file);
  const targets = db
    .prepare(
      `SELECT id, name, member_count, naming_source, status
         FROM topics
        WHERE COALESCE(member_count, 0) = 0 AND status = 'active'
        ORDER BY id`,
    )
    .all() as Record<string, unknown>[];

  console.log(`库:${file}`);
  console.log(`话题总数:${db.prepare("SELECT COUNT(*) c FROM topics").get().c}`);
  console.log(`待归档(0 成员且仍为 active):${targets.length}`);
  for (const t of targets) console.log(`  #${String(t.id)} ${String(t.name)} [${String(t.naming_source)}]`);

  if (dryRun) {
    console.log("试运行:未做任何修改");
  } else if (targets.length === 0) {
    console.log("没有需要归档的话题");
  } else {
    mkdirSync("data/backup", { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshot = `data/backup/pre-archive-empty-topics-${stamp}.db`;
    db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    const check = new DatabaseSync(snapshot, { readOnly: true });
    const copied = check.prepare("SELECT COUNT(*) c FROM topics").get().c;
    check.close();
    if (copied !== db.prepare("SELECT COUNT(*) c FROM topics").get().c) {
      console.error(`备份行数不一致(${String(copied)}),放弃修改`);
      process.exitCode = 1;
    } else {
      const now = new Date().toISOString();
      const info = db
        .prepare(`UPDATE topics SET status='inactive', archived_at=?, updated_at=? WHERE COALESCE(member_count,0)=0 AND status='active'`)
        .run(now, now);
      console.log(`已归档 ${info.changes} 条;还原:UPDATE topics SET status='active', archived_at=NULL WHERE id IN (...)`);
      console.log(`快照:${snapshot}`);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
  }
  db.close();
}
