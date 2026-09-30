/**
 * Database client + migration runner.
 * Migrations are the ONLY way the schema evolves — no delete-database upgrades.
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema>;

export const DEMO_DB_FILENAME = "trendscope-demo.db";

export function dataDir(): string {
  return path.resolve(process.cwd(), "data");
}

/** 演示模式:由 npm run demo 设置,只影响这一个开关下的库文件。 */
export function isDemoMode(): boolean {
  return process.env.TRENDSCOPE_DEMO === "1" || process.env.TRENDSCOPE_DEMO === "true";
}

/**
 * 库文件位置(§52):默认 data/trendscope.db;演示模式默认 data/trendscope-demo.db;
 * TRENDSCOPE_DB 可显式指定(安装检查、干净安装验证与演示重置都依赖它)。
 */
export function resolveDbPath(): string {
  const explicit = process.env.TRENDSCOPE_DB?.trim();
  if (explicit) return path.resolve(explicit);
  // 防护:测试与脚本进程绝不能落到使用者的真实库上。
  // 真实事故:一次测试以仓库根目录为 cwd 解析到 data/trendscope.db,往使用者的库里
  // 灌了 5350 条示例数据。库路径必须由调用方显式给出,否则宁可失败。
  if (isTestProcess()) {
    throw new Error(
      "测试/脚本进程拒绝使用默认库路径:请显式设置 TRENDSCOPE_DB 指向临时库(绝不写 data/trendscope.db)",
    );
  }
  return path.join(dataDir(), isDemoMode() ? DEMO_DB_FILENAME : "trendscope.db");
}

/** vitest 会注入 VITEST / VITEST_POOL_ID;NODE_ENV=test 兜底其他测试入口 */
function isTestProcess(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.VITEST_POOL_ID !== undefined ||
    process.env.NODE_ENV === "test"
  );
}

export function openDb(dbPath?: string): { sqlite: Database.Database; db: DB } {
  const file = dbPath ?? resolveDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  // WAL + synchronous=NORMAL 是 SQLite 官方推荐的配对:进程崩溃仍然安全,
  // 只有"操作系统崩溃/断电"时才可能丢掉最后几个事务。默认 FULL 会让每一行导入
  // 都 fsync 一次(实测示例库 5300 行 ≈ 15 秒),对本地个人工具不值得。
  // 迁移前仍有自动备份(data/backup/),`npm run db:backup` 可手动落盘。
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

/**
 * Applies pending .sql migrations from the drizzle/ folder, tracked in
 * __drizzle_migrations. Idempotent; safe on every boot.
 */
/** 待执行的迁移文件名(用于启动前自动备份的判断;不改变任何数据)。 */
export function pendingMigrations(sqlite: Database.Database, migrationsDir?: string): string[] {
  const dir = resolveMigrationsDir(migrationsDir);
  if (!dir || !fs.existsSync(dir)) return [];
  ensureTracker(sqlite);
  const applied = new Set(
    (sqlite.prepare("SELECT hash FROM __drizzle_migrations").all() as { hash: string }[]).map((r) => r.hash),
  );
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !applied.has(f))
    .sort();
}

function ensureTracker(sqlite: Database.Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS __drizzle_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       hash TEXT NOT NULL UNIQUE,
       applied_at TEXT NOT NULL
     )`,
  );
}

function resolveMigrationsDir(migrationsDir?: string): string | null {
  return (
    migrationsDir ??
    firstExisting([
      path.resolve(process.cwd(), "drizzle"),
      path.resolve(__dirname, "../../drizzle"),
      path.resolve(__dirname, "../../../drizzle"),
      path.resolve(__dirname, "../drizzle"),
    ])
  );
}

export function migrate(sqlite: Database.Database, migrationsDir?: string): number {
  const dir =
    migrationsDir ??
    firstExisting([
      path.resolve(process.cwd(), "drizzle"),
      path.resolve(__dirname, "../../drizzle"),
      path.resolve(__dirname, "../../../drizzle"),
      path.resolve(__dirname, "../drizzle"),
    ]) ??
    path.resolve(process.cwd(), "drizzle");

  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS __drizzle_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       hash TEXT NOT NULL UNIQUE,
       applied_at TEXT NOT NULL
     )`,
  );

  if (!fs.existsSync(dir)) return 0;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied = new Set(
    (
      sqlite
        .prepare("SELECT hash FROM __drizzle_migrations")
        .all() as { hash: string }[]
    ).map((r) => r.hash),
  );

  let count = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    const sqlText = fs.readFileSync(path.join(dir, f), "utf-8");
    const run = sqlite.transaction(() => {
      sqlite.exec(sqlText);
      sqlite
        .prepare("INSERT INTO __drizzle_migrations (hash, applied_at) VALUES (?, ?)")
        .run(f, new Date().toISOString());
    });
    try {
      run();
    } catch (e) {
      // 迁移中途失败会整事务回滚(不会留下半个 schema),但用户看到的只是一句 SQL 错误。
      // 说清是哪一份、以及"数据没有被改动、可以用备份还原",才是可操作的报错。
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `执行迁移 ${f} 失败(该迁移已整体回滚,已有数据未被修改):${msg}` +
          " —— 可先用 npm run db:backup -- --verify-only 检查备份,或用 data/backup/ 中最近一份还原。",
      );
    }
    count += 1;
  }
  return count;
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** In-memory DB with fresh migrations — for tests. */
export function createTestDb(): { sqlite: Database.Database; db: DB } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  migrate(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
