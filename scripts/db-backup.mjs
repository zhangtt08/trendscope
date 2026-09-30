#!/usr/bin/env node
/**
 * WAL-safe database backup + optional checkpoint.
 *
 * Why this exists: the DB runs in WAL mode, so recent writes live only in
 * `trendscope.db-wal` until SQLite checkpoints them. Copying `trendscope.db`
 * by hand (cp / Explorer / a zip of the single file) therefore captures a
 * STALE database — the previous "pre-migration backups" in data/backup were
 * made that way and were missing every Stage 6B–9 table.
 *
 * This uses SQLite's online backup API, which reads through the WAL and
 * produces one consistent, self-contained file, then verifies it.
 *
 * Usage:
 *   npm run db:backup                     # verify + back up
 *   npm run db:backup -- --checkpoint     # also fold the WAL back into the main file
 *   npm run db:backup -- --verify-only
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA = path.resolve(process.cwd(), "data");
const SRC = path.join(DATA, "trendscope.db");
const BACKUP_DIR = path.join(DATA, "backup");
const args = process.argv.slice(2);
const doCheckpoint = args.includes("--checkpoint");
const verifyOnly = args.includes("--verify-only");

function fail(msg) {
  console.error(`FAIL — ${msg}`);
  process.exit(1);
}
if (!fs.existsSync(SRC)) fail(`找不到数据库 ${SRC}(在仓库根目录运行,或先 npm start 一次)`);

/** 表清单 + 行数,用于备份前后逐项对比。 */
function snapshot(db) {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const counts = {};
  for (const n of names) counts[n] = db.prepare(`SELECT count(*) c FROM "${n}"`).get().c;
  return { tableCount: names.length, rows: names.reduce((a, n) => a + counts[n], 0), counts };
}

const src = new Database(SRC, { readonly: true });
const before = snapshot(src);
const journal = src.pragma("journal_mode", { simple: true });
const walBytes = fs.existsSync(SRC + "-wal") ? fs.statSync(SRC + "-wal").size : 0;

console.log("源库");
console.log(`  路径        ${SRC}`);
console.log(`  journal     ${journal},wal=${walBytes} bytes`);
console.log(`  表 / 行数   ${before.tableCount} / ${before.rows}`);
for (const t of ["content_items", "topics", "content_score_snapshots", "topic_intelligence_current", "topic_opportunity_current"]) {
  console.log(`  ${t.padEnd(28)} ${before.counts[t] ?? "(缺表)"}`);
}
if (walBytes > 0) {
  console.log(`  注意:${walBytes} bytes 尚未检查点 —— 只复制 .db 单文件会丢掉这部分数据,必须用本脚本。`);
}
const integrity = src.pragma("integrity_check", { simple: true });
if (integrity !== "ok") fail(`源库 integrity_check 返回 ${integrity}`);
console.log("  integrity   ok");
src.close();

if (verifyOnly) {
  console.log("\nVERIFY ONLY — 未写备份。");
  process.exit(0);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const dest = path.join(BACKUP_DIR, `trendscope-${stamp}.db`);
if (fs.existsSync(dest)) fail(`备份目标已存在:${dest}`);

// 在线备份:读穿 WAL,产出自包含单文件
const live = new Database(SRC);
await live.backup(dest);
live.close();

const check = new Database(dest, { readonly: true });
const after = snapshot(check);
const okIntegrity = check.pragma("integrity_check", { simple: true });
const migrations = check
  .prepare("SELECT hash FROM __drizzle_migrations ORDER BY id")
  .all()
  .map((r) => r.hash);
check.close();

console.log("\n备份");
console.log(`  文件        ${dest}`);
console.log(`  大小        ${fs.statSync(dest).size} bytes`);
console.log(`  表 / 行数   ${after.tableCount} / ${after.rows}`);
console.log(`  integrity   ${okIntegrity}`);
console.log(`  迁移记录    ${migrations.length} 条(${migrations[migrations.length - 1] ?? "none"} 最新)`);

if (okIntegrity !== "ok") fail("备份 integrity_check 未通过");
if (after.tableCount !== before.tableCount || after.rows !== before.rows) {
  fail(`备份与源不一致:表 ${before.tableCount}→${after.tableCount},行 ${before.rows}→${after.rows}`);
}
console.log("\nBACKUP OK — 备份与源逐项一致(表数与总行数相同,integrity ok)。");

if (doCheckpoint) {
  const db = new Database(SRC);
  const beforeWal = fs.existsSync(SRC + "-wal") ? fs.statSync(SRC + "-wal").size : 0;
  // TRUNCATE:把 WAL 内容写回主库文件并把 WAL 截断为 0
  const row = db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  const afterWal = fs.existsSync(SRC + "-wal") ? fs.statSync(SRC + "-wal").size : 0;
  const [busy, log, checkpointed] = Array.isArray(row)
    ? [row[0].busy, row[0].log, row[0].checkpointed]
    : [undefined, undefined, undefined];
  console.log("\nCHECKPOINT");
  console.log(`  busy=${busy} wal 前=${beforeWal} 后=${afterWal} bytes`);
  if (busy === 1) console.log("  仍有 reader 占用,WAL 未完全折叠 —— 停掉 npm start / dev 后重试。");
  else if (afterWal > 0) console.log(`  提示:WAL 仍有 ${afterWal} bytes(通常是空头部),主库文件已自包含。`);
  else console.log(`  已折叠 ${checkpointed ?? ""} 页,主库文件现在自包含。`);
}
