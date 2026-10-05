/**
 * 启动时的"动手之前先给自己留一份还原点"这一步(§56),从 index.ts 里抽出来单独成模块。
 *
 * 为什么要抽出来:这段逻辑原来只在 `index.ts` 的 `main()` 里,而 `index.ts` 一被 import 就会
 * 开真实库、跑迁移、起监听 —— 谁都没法测它。实测的后果是**备份失败不拦迁移**
 * (`catch` 里只打印两句就继续 `migrate()`),也就是说"迁移前已自动备份"这句话
 * 在备份根本没成功的情况下照样说得出口。使用者的库有 3.9 GB,一旦某次迁移真的需要还原,
 * 而那份 pre-migration 备份从来没存在过 —— 那时才发现,已经太晚了。
 *
 * 现在的形状:备份写不出来就 **中止**,一个迁移都不执行,并把"要还原点什么"说清楚。
 * 这一条不许被"为了让软件能启动"绕开:闸门的作用是在动手之前留下退路。
 */
import path from "node:path";
import type Database from "better-sqlite3";
import { createBackup, type BackupSummary } from "../services/backup";
import { migrate, pendingMigrations, resolveDbPath } from "./client";

/** 迁移前备份写不出来 → 迁移必须中止。带上"要往哪里写"和原始错,才谈得上可操作。 */
export class MigrationBlockedError extends Error {
  readonly pending: string[];
  readonly targetDir: string;
  readonly original: string;

  constructor(message: string, info: { pending: string[]; targetDir: string; original: unknown }) {
    super(message);
    this.name = "MigrationBlockedError";
    this.pending = info.pending;
    this.targetDir = info.targetDir;
    this.original = info.original instanceof Error ? info.original.message : String(info.original);
  }
}

export interface PrepareOptions {
  /** 迁移前备份落到哪。默认与库文件同级的 `backup/`(和生产、db:backup 同一个落点)。 */
  backupDir?: string;
  /** 时间戳来源:备份文件名由它推出来,测试要能把目标文件钉住。 */
  now?: () => Date;
  /** 迁移文件目录(默认与 `migrate()` 同一个解析顺序)。 */
  migrationsDir?: string;
  /** 正常进展写在这里(不是 console.log 本身,方便测试与桌面壳收口)。 */
  log?: (msg: string) => void;
}

/** 库里有没有东西:全新库连表都还没有,没必要为它做"迁移前备份"。 */
function hasData(sqlite: Database.Database): boolean {
  const hasTable = sqlite
    .prepare("select 1 from sqlite_master where type='table' and name='content_items'")
    .get();
  if (!hasTable) return false;
  const rows = (sqlite.prepare("select count(*) c from content_items").get() as { c: number }).c;
  return rows > 0;
}

/**
 * 有待执行迁移就先做迁移前备份;**备份失败抛 MigrationBlockedError**,由调用方中止启动。
 * 没有待执行迁移、或库里根本没有数据时返回 null(这两种情况没有东西要保护)。
 */
export async function ensurePreMigrationBackup(
  sqlite: Database.Database,
  opts: PrepareOptions = {},
): Promise<BackupSummary | null> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const pending = pendingMigrations(sqlite, opts.migrationsDir);
  if (pending.length === 0) return null;

  if (!hasData(sqlite)) {
    log(`[准备数据库] 首次建库(${pending.length} 个迁移),库内还没有数据,跳过迁移前备份。`);
    return null;
  }

  const targetDir = opts.backupDir ?? path.join(path.dirname(resolveDbPath()), "backup");
  try {
    const summary = await createBackup(sqlite, {
      destDir: targetDir,
      prefix: "pre-migration",
      ...(opts.now ? { now: opts.now() } : {}),
    });
    log(
      `[准备数据库] 待执行 ${pending.length} 个迁移(${pending.join(", ")}) —— 已先自动备份:${summary.file}` +
        `(${summary.tables} 表 / ${summary.rows} 行 / integrity ${summary.integrity})`,
    );
    return summary;
  } catch (e) {
    const original = e instanceof Error ? e.message : String(e);
    throw new MigrationBlockedError(
      `库里有 ${(sqlite.prepare("select count(*) c from content_items").get() as { c: number }).c} 条内容,` +
        `而迁移前备份写不出来 —— 目标目录:${targetDir}(失败原因:${original})。` +
        `已中止启动,**一个迁移都没有执行**,数据库文件没有被改动。`,
      { pending, targetDir, original },
    );
  }
}

/**
 * 启动时的完整数据步骤:迁移前备份 → 执行迁移。
 * 顺序是这条链的全部意义 —— 备份抛错时 `migrate()` 根本不会被调用。
 */
export async function prepareDatabase(sqlite: Database.Database, opts: PrepareOptions = {}): Promise<number> {
  await ensurePreMigrationBackup(sqlite, opts);
  return migrate(sqlite, opts.migrationsDir);
}
