/**
 * WAL 安全的数据库备份 + 自校验(§55/§57/§58)。
 *
 * 为什么不能直接 copyFile:WAL 模式下最近写入可能还在 `*-wal` 里,只复制主库文件
 * 会得到一个"少了最后一段"的库 —— 看起来成功,打开才发现数据不在。
 * 这里用 SQLite 自己的在线备份 API,并立刻对副本做完整性与表/行数对账。
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface BackupSummary {
  file: string;
  bytes: number;
  tables: number;
  rows: number;
  integrity: string;
}

export class BackupError extends Error {}

function snapshot(db: Database.Database): { tables: string[]; counts: Record<string, number>; total: number } {
  const tables = (
    db
      .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
      .all() as { name: string }[]
  ).map((r) => r.name);
  const counts: Record<string, number> = {};
  let total = 0;
  for (const t of tables) {
    // FTS5 影子表不允许直接查询计数以外的操作,但 select count 是允许的
    try {
      const n = Number((db.prepare(`select count(*) c from "${t}"`).get() as { c: number }).c);
      counts[t] = n;
      total += n;
    } catch {
      counts[t] = -1;
    }
  }
  return { tables, counts, total };
}

/**
 * 备份到一个新文件。用 SQLite 的在线备份 API:它会把仍在 WAL 里的最近写入一起带走,
 * 并且不对源库做 checkpoint —— 源库可能正被另一个进程使用。
 */
export async function createBackup(
  sqlite: Database.Database,
  opts: { destDir: string; prefix?: string; now?: Date },
): Promise<BackupSummary> {
  const before = snapshot(sqlite);
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const prefix = opts.prefix ?? "trendscope";
  fs.mkdirSync(opts.destDir, { recursive: true });
  const file = path.join(opts.destDir, `${prefix}-${stamp}.db`);
  if (fs.existsSync(file)) fs.rmSync(file);
  await sqlite.backup(file);

  const copy = new Database(file, { readonly: true });
  try {
    const after = snapshot(copy);
    const integrity = String(copy.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw new BackupError(`备份 integrity_check 返回 ${integrity}`);
    const missing = before.tables.filter((t) => !after.tables.includes(t));
    if (missing.length) throw new BackupError(`备份缺少表:${missing.join("、")}`);
    const mismatch = before.tables.filter((t) => after.counts[t] >= 0 && after.counts[t] !== before.counts[t]);
    if (mismatch.length) {
      throw new BackupError(
        `备份行数与源不一致:${mismatch.map((t) => `${t} ${before.counts[t]}→${after.counts[t]}`).join("、")}`,
      );
    }
    return { file, bytes: fs.statSync(file).size, tables: after.tables.length, rows: after.total, integrity };
  } finally {
    copy.close();
  }
}

/** 供 doctor 使用:最近的备份文件列表(倒序)。 */
export function listBackups(destDir: string, limit = 5): { file: string; mtime: string; bytes: number }[] {
  if (!fs.existsSync(destDir)) return [];
  return fs
    .readdirSync(destDir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const st = fs.statSync(path.join(destDir, f));
      return { file: path.join(destDir, f), mtime: st.mtime.toISOString(), bytes: st.size };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
    .slice(0, limit);
}
