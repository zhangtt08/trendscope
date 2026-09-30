/**
 * 演示模式(Release 1.0 · WP2 §34/§35)。
 *
 * 规矩只有一条,但它是硬的:**演示数据永远不与用户真实数据同库**。
 * 演示模式由 `TRENDSCOPE_DEMO=1` + 独立的 `data/trendscope-demo.db` 决定,
 * 因此"重置演示数据"这条路径在物理上不可能碰到正式库 ——
 * 不依赖"记得加 WHERE 条件"这种迟早会出错的防护。
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { DEMO_DB_FILENAME, isDemoMode, resolveDbPath } from "../db/client";
import { FixtureAdapter, listFixtures, loadFixture } from "../adapters/fixture";
import { PLATFORM_TIMEZONES, isValidTimezone } from "../domain/timezone";
import type { NormalizeContext } from "../adapters/types";
import { runImport, startBatch } from "./importService";

const fixtureAdapter = new FixtureAdapter();

export interface DemoStatus {
  demoMode: boolean;
  /** 面向界面的数据文件路径:默认目录里显示 data/<文件>,自定义路径显示绝对路径
   * (原先写死演示库名,导致正式实例的侧栏显示 demo 库 —— 现在取当前实例真实路径) */
  dbDisplay: string;
  contentTotal: number;
  fixtureRows: number;
  replayRows: number;
  availableFixtures: { name: string; file: string; rowCount: number }[];
}

export class DemoUserError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function countWhere(db: DB, table: string, sourceType: string | null): Promise<number> {
  const q = sourceType
    ? `select count(*) as c from ${table} where source_type = '${sourceType}'`
    : `select count(*) as c from ${table}`;
  const rows = (await db.get(sql.raw(q))) as { c: number | bigint } | null;
  return Number(rows?.c ?? 0);
}

export async function getDemoStatus(db: DB, activeDbFile?: string): Promise<DemoStatus> {
  const [fixtures, contentTotal, fixtureRows, replayRows] = await Promise.all([
    Promise.resolve(listFixtures()),
    countWhere(db, "content_items", null),
    countWhere(db, "content_items", "fixture"),
    countWhere(db, "content_items", "replay"),
  ]);
  // 侧栏/演示横幅报的是"这个实例正在用的文件"。参数来自启动时已打开的连接,
  // 缺省才回落到环境变量推导路径 —— 否则正式实例会显示演示库名。
  const dbPath = path.resolve(activeDbFile ?? resolveDbPath());
  const dataDir = path.resolve(process.cwd(), "data") + path.sep;
  return {
    demoMode: isDemoMode(),
    dbDisplay: dbPath.startsWith(dataDir) ? `data/${path.basename(dbPath)}` : dbPath,
    contentTotal,
    fixtureRows,
    replayRows,
    availableFixtures: fixtures,
  };
}

/** 把所有内置 fixture 载入当前库(演示模式专用;正式库请走导入中心的显式操作)。 */
export async function loadDemoData(db: DB, opts: { force?: boolean } = {}): Promise<{ loaded: number; batches: string[] }> {
  if (!isDemoMode() && !opts.force) {
    throw new DemoUserError(409, "当前不是演示库:演示数据装载只允许作用于 data/trendscope-demo.db。");
  }
  const batches: string[] = [];
  let loaded = 0;
  for (const f of listFixtures()) {
    const env = loadFixture(f.file);
    const tz =
      env.sourceTimezone && isValidTimezone(env.sourceTimezone)
        ? env.sourceTimezone
        : (PLATFORM_TIMEZONES[env.platform] ?? "Asia/Shanghai");
    const ctx: NormalizeContext = {
      sourceType: "fixture",
      mapping: env.mapping ?? undefined,
      platformOverride: env.platform,
      sourceTimezone: tz,
      tzProvenance: "adapter_default",
    };
    const batchId = await startBatch(db, {
      name: `演示数据:${env.name}`,
      sourceType: "fixture",
      platform: env.platform,
      options: { demo: true, sourceTimezone: tz },
    });
    const summary = await runImport(db, fixtureAdapter, env.rows, ctx, batchId);
    loaded += summary.imported;
    batches.push(`#${batchId} ${env.name}`);
  }
  return { loaded, batches };
}

/**
 * 清空时要跳过:迁移记录、SQLite 内部表、以及 FTS5 虚拟表与它的影子表
 * (后者由 fts5 模块自己管理,直接 delete 会报 "may not be modified")。
 * 虚拟表名是查出来的,不是写死的 —— 换 FTS 表名不会悄悄失效。
 */
function virtualTables(db: DB): Set<string> {
  const rows = db.all(
    sql.raw("select name from sqlite_master where type='table' and sql like 'CREATE VIRTUAL TABLE%'"),
  ) as { name: string }[];
  const skip = new Set<string>(["__drizzle_migrations"]);
  for (const r of rows ?? []) {
    skip.add(r.name);
    for (const suffix of ["_data", "_idx", "_docsize", "_config", "_content"]) skip.add(r.name + suffix);
  }
  return skip;
}

/** 清空演示库的全部业务数据。仅在演示模式下可用。 */
export async function resetDemoData(db: DB): Promise<{ clearedTables: string[]; reloaded: number }> {
  if (!isDemoMode()) {
    throw new DemoUserError(409, "当前不是演示库,拒绝清空数据。重置演示数据请使用 npm run demo(独立演示库)。");
  }
  const tables = (await db.all(sql.raw("select name from sqlite_master where type='table'"))) as { name: string }[];
  const skip = virtualTables(db);
  const cleared: string[] = [];
  // better-sqlite3 是同步驱动:drizzle 的 async 事务回调里的 await 会跑到事务边界之外,
  // defer_foreign_keys 因此失效(实测仍是 SQLITE_CONSTRAINT_FOREIGNKEY)。整库清空本来就不需要
  // 参照完整性 —— 但清完之后必须把约束重新打开并校验,不能一路关着。
  await db.run(sql`pragma foreign_keys = OFF`);
  try {
    for (const t of tables) {
      if (skip.has(t.name) || t.name.startsWith("sqlite_")) continue;
      await db.run(sql.raw(`delete from "${t.name}"`));
      cleared.push(t.name);
    }
  } finally {
    await db.run(sql`pragma foreign_keys = ON`);
  }
  const violations = (await db.all(sql.raw("pragma foreign_key_check"))) as unknown[];
  if (violations.length > 0) {
    throw new DemoUserError(500, `演示库重置后外键校验不通过(${violations.length} 处),请检查数据目录状态。`);
  }
  const { loaded } = await loadDemoData(db, { force: true });
  return { clearedTables: cleared, reloaded: loaded };
}

/** 演示库是否已经存在(用于首次提示)。 */
export function demoDbExists(): boolean {
  return fs.existsSync(path.resolve(process.cwd(), "data", DEMO_DB_FILENAME));
}
