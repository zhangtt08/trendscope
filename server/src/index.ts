/**
 * Server bootstrap(§49/§53/§54/§59/§60)。
 *
 * 启动即完成:migrate(永不删库)→ FTS 回填 → 中断任务清理 → 演示库自动装载 → 监听。
 * 退出即完成:停调度器 → 停 HTTP(含 keep-alive 连接)→ WAL checkpoint → 关连接。
 * 这一步不是可选的整洁癖:WAL 模式下不 checkpoint 就复制主库文件,会丢掉尚未落盘的数据。
 */
import path from "node:path";
import type { Server } from "node:http";
import { loadDotEnv } from "./env";
import { openDb, migrate, pendingMigrations, resolveDbPath, isDemoMode } from "./db/client";
import { createBackup } from "./services/backup";
import { createShutdown } from "./shutdown";
import { createApp, listenLocal } from "./app";
import { DEFAULT_PORT } from "./local-guard";
import { startAutoAnalysis } from "./analysis/autoAnalysis";
import { maybeCascadeAfterCollection } from "./collection/hotCascade";
import { CollectionRuntime } from "./services/collection/runtime";
import { CollectionScheduler } from "./services/collection/scheduler";
import { ensureFtsBackfilled } from "./services/searchIndexService";
import { getDataHealth } from "./services/healthService";
import { getDashboardStats } from "./services/statsService";
import { getAnalysisStatus } from "./analysis/status";
import { getDemoStatus, loadDemoData } from "./services/demoService";
import { reapInterruptedRuns } from "./analysis/repository";
import { appVersion } from "./version";

// 端口只有一个来源:环境变量 PORT,缺省 DEFAULT_PORT。同一个值既交给 listen,也交给本机边界
// 的 Host/Origin 判定 —— 判定端口与实际监听端口分叉时,合法请求会被自己的闸门拒掉。
const RAW_PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const PORT = Number.isInteger(RAW_PORT) && RAW_PORT > 0 && RAW_PORT < 65536 ? RAW_PORT : DEFAULT_PORT;

async function main(): Promise<void> {
  const dot = loadDotEnv();
  if (dot.loaded) {
    console.log(
      `[trendscope] 已读取 .env:${path.basename(dot.file)} 生效 ${dot.applied.length} 项` +
        (dot.skipped.length ? `,${dot.skipped.length} 项已被真实环境变量覆盖` : "") +
        (dot.malformed ? `,${dot.malformed} 行无法解析已忽略` : ""),
    );
  }
  const file = resolveDbPath();
  const { sqlite, db } = openDb(file);
  // §56:检测到有待执行迁移时,先给自己留一个还原点再动手。备份失败不拦启动
  // (本项目迁移全部是新增表/索引,且拦停会让人连自己的数据都打不开),
  // 但会把话说到最重:此时不要继续升级,先手工备份。
  const pending = pendingMigrations(sqlite);
  if (pending.length > 0) {
    await preMigrationBackup(sqlite, pending);
  }
  const applied = migrate(sqlite);
  const fts = ensureFtsBackfilled(db);
  const reaped = await reapInterruptedRuns(db);
  console.log(
    `[trendscope] 数据库就绪 —— 新执行 ${applied} 个迁移,搜索索引 ${fts.rebuilt ? "已重建" : "已是最新"}(${fts.indexed} 条)` +
      (reaped ? `,清理 ${reaped} 条中断的分析运行记录` : ""),
  );
  console.log(`[trendscope] 数据文件:${file}${isDemoMode() ? "(演示库)" : ""}`);
  console.log(`[trendscope] 版本 ${appVersion()} · Node ${process.versions.node}`);

  const runtime = new CollectionRuntime(db, {
    onRunFinished: (info) => {
      startAutoAnalysis(db, { accepted: info.accepted, status: info.status });
      // 热榜采回新内容后,再往深处走一层:标题 → 站内检索 → 真正的创作内容。
      // 内部自带节流与"缺凭证就零写入",异常绝不能回渗到采集流程。
      void maybeCascadeAfterCollection(db, runtime, info).catch((e: unknown) => {
        console.warn("[热点派生] 本轮跳过:", e instanceof Error ? e.message : String(e));
      });
    },
  });
  const scheduler = new CollectionScheduler(db, runtime);
  scheduler.start();

  const app = createApp(db, runtime, {
    dbFile: file,
    // 闸门判定用的端口 = 下面真正 listen 的那一个,同一份常量,不分叉。
    localGuard: { port: PORT },
    // 用户导入(CSV/JSON/手工)与采集同等待遇:库里多了新内容就补一次分析
    onImported: (summary) => {
      startAutoAnalysis(db, { accepted: summary.imported, status: "completed" });
    },
  });
  // 只绑本机回环。`app.listen(PORT)` 不写 host 时 Node 默认绑 0.0.0.0 —— 那就是把可写接口
  // 摊给整个局域网(2026-10-05 在本机实测到过)。绑定地址与 Host/Origin 判定是两层,都要在。
  const server: Server = listenLocal(app, PORT, (bound) => {
    console.log(`[trendscope] 服务已启动:http://${bound.address}:${bound.port}(只监听本机回环,局域网不可达)`);
    if (isDemoMode()) {
      void seedDemo(db);
    }
    // 首屏预热。实测:本机 1.3 GB 的库上,第一次 GET /api/health 要 **35 秒**(冷文件缓存,
    // 若干条全库聚合查询逐页把数据读进来),热了以后是 0.1 秒。那 35 秒原本砸在用户打开软件
    // 的第一次点击上 —— 界面只能干转。listen 之后再后台跑一遍同样的查询,把代价挪到人看不见
    // 的时候。跑在 setImmediate 之后,不推迟 listen;失败只 warn:预热没成功不等于服务坏了。
    startPreWarm(db);
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(
        `[trendscope] 启动失败:本机回环上的端口 ${PORT} 已被占用(多半是还有一个旧实例在跑)。\n` +
          `            服务只监听 127.0.0.1,所以这不是"网络问题",换端口即可:\n` +
          `            cmd 里 set PORT=5199 && npm start;PowerShell 里 $env:PORT='5199';npm start\n` +
          `            或先停掉旧实例:npm run doctor 会告诉你端口状态(它报的是 127.0.0.1:${PORT})。`,
      );
      process.exit(1);
    }
    console.error("[trendscope] 监听出错:", e);
    process.exit(1);
  });

  // 退出流程集中在 shutdown.ts:那里有测试覆盖(端口释放、WAL 落盘、重复信号不二次执行)。
  const shutdown = createShutdown({ server, sqlite, stopScheduler: () => scheduler.stop() });
  shutdown.install();
}

async function preMigrationBackup(sqlite: ReturnType<typeof openDb>["sqlite"], pending: string[]): Promise<void> {
  // 全新库连表都还没有,不能直接 select content_items
  const hasTable = sqlite
    .prepare("select 1 from sqlite_master where type='table' and name='content_items'")
    .get();
  const rows = hasTable ? (sqlite.prepare("select count(*) c from content_items").get() as { c: number }).c : 0;
  if (!rows) {
    console.log(`[trendscope] 首次建库(${pending.length} 个迁移),库内还没有数据,跳过迁移前备份。`);
    return;
  }
  try {
    const b = await createBackup(sqlite, {
      destDir: path.join(path.dirname(resolveDbPath()), "backup"),
      prefix: "pre-migration",
    });
    console.log(
      `[trendscope] 待执行 ${pending.length} 个迁移(${pending.join(", ")}) —— 已先自动备份:${b.file}(${b.tables} 表 / ${b.rows} 行 / integrity ${b.integrity})`,
    );
  } catch (e) {
    console.error(
      `[trendscope] 迁移前自动备份失败:${e instanceof Error ? e.message : e}`,
    );
    console.error("[trendscope] 迁移仍会继续(全部为新增表/索引)。如需绝对安全,请先手工执行 npm run db:backup 并保留产物。");
  }
}

async function preWarmDashboard(db: ReturnType<typeof openDb>["db"]): Promise<void> {
  // 只跑首屏真的会读的那几个查询,不写任何数据 —— 这是"把等待从人面前挪走",不是预热缓存作假。
  const steps: [string, () => Promise<unknown>][] = [
    ["数据健康 /api/health", async () => getDataHealth(db)],
    ["数据总览 /api/stats", async () => getDashboardStats(db)],
    ["分析状态 /api/analysis/status", async () => getAnalysisStatus(db)],
  ];
  const t0 = Date.now();
  for (const [label, run] of steps) {
    const s = Date.now();
    try {
      await run();
      console.log(`[trendscope] 首屏预热:${label} —— ${Date.now() - s}ms`);
    } catch (e) {
      console.warn(`[trendscope] 首屏预热:${label} 失败(不影响服务):`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[trendscope] 首屏预热完成,共 ${Date.now() - t0}ms(之后界面第一次打开就不会再等这几十秒)`);
}

/**
 * 服务已经在监听了,所以这一段完全在请求路径之外。
 * 让它失败也影响不到服务本身。
 */
function startPreWarm(db: ReturnType<typeof openDb>["db"]): void {
  setImmediate(() => {
    void preWarmDashboard(db).catch((e) => console.warn("[trendscope] 首屏预热整体失败:", e));
  });
}

async function seedDemo(db: ReturnType<typeof openDb>["db"]): Promise<void> {
  try {
    const status = await getDemoStatus(db);
    if (status.contentTotal > 0) {
      console.log(`[trendscope] 演示库已有 ${status.contentTotal} 条内容,跳过自动装载。`);
      return;
    }
    const r = await loadDemoData(db);
    console.log(`[trendscope] 演示数据已装载:${r.loaded} 条内容(${r.batches.length} 个批次)。这些内容全部标记为演示数据。`);
  } catch (e) {
    console.warn("[trendscope] 演示数据装载失败(不影响服务启动):", e instanceof Error ? e.message : e);
  }
}

main().catch((e) => {
  console.error("[trendscope] 启动失败:", e);
  process.exit(1);
});
