/**
 * 安装体检:npm run doctor(§48)。
 *
 * 目的很具体:用户拿到这个项目后,遇到"起不来/连不上/数据像丢了"时,
 * 有一条命令能自己判断是环境哪里不对 —— 而不是去读源码或来问开发者。
 * 只读检查,不写库、不改配置;密钥只看"有没有配",永远不看值。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { appVersion } from "./version";

// 与应用本身保持一致:一切路径都以"当前工作目录"为项目根(npm start/npm run doctor
// 都要求在项目目录里执行)。用 __dirname 会在 tsx 直跑时把根算到 server/src 上,
// 于是体检报告的是不存在的路径,甚至可能在源码目录里建出多余的 db 文件。

export type CheckLevel = "PASS" | "WARN" | "FAIL";
export interface CheckResult {
  name: string;
  level: CheckLevel;
  detail: string;
  hint?: string;
}

const SUPPORTED_NODE = ">=20.19 <25";

function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0]);
}

function portFree(port: number): Promise<{ free: boolean; error?: string }> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e: NodeJS.ErrnoException) => resolve({ free: false, error: e.code }));
    srv.once("listening", () => {
      srv.close(() => resolve({ free: true }));
    });
    srv.listen(port, "127.0.0.1");
  });
}

export async function runChecks(opts: { port?: number } = {}): Promise<CheckResult[]> {
  const port = opts.port ?? Number(process.env.PORT ?? 5184);
  const out: CheckResult[] = [];

  out.push({ name: "应用版本", level: "PASS", detail: `package.json version ${appVersion()}` });

  // 1) Node 版本
  const v = process.versions.node;
  const major = nodeMajor();
  const minor = Number(v.split(".")[1] ?? 0);
  const okNode = major === 20 ? minor >= 19 : major === 21 ? false : major >= 22 && major < 25;
  out.push({
    name: "Node 版本",
    level: okNode ? "PASS" : major >= 25 || major === 21 ? "WARN" : "FAIL",
    detail: `当前 ${v};支持范围 ${SUPPORTED_NODE}`,
    hint: okNode ? undefined : "用符合范围的 Node 重试(本项目已验证 Node 24.x)",
  });

  // 2) 原生依赖
  try {
    // 这里必须用 require 而不是顶层 import:native 模块加载失败时,
    // import 会让 doctor 自己先崩,而用户最需要的是这条检查给出人话。
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    const ver = (db.prepare("select sqlite_version() v").get() as { v: string }).v;
    db.close();
    out.push({ name: "SQLite 原生模块", level: "PASS", detail: `better-sqlite3 可用 · SQLite ${ver}(ABI ${process.versions.modules})` });
  } catch (e) {
    out.push({
      name: "SQLite 原生模块",
      level: "FAIL",
      detail: `加载失败:${e instanceof Error ? e.message : String(e)}`,
      hint: "通常是 Node 版本变更后没有重装依赖:删除 node_modules 再 npm install",
    });
  }

  // 3) 数据目录可写
  const ROOT = process.cwd();
  const dataDir = path.join(ROOT, "data");
  const dbFile = process.env.TRENDSCOPE_DB?.trim() || path.join(dataDir, isDemoFlag() ? "trendscope-demo.db" : "trendscope.db");
  let writeOk = true;
  try {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const probe = path.join(path.dirname(dbFile), ".doctor-write-probe");
    fs.writeFileSync(probe, "x");
    fs.rmSync(probe);
  } catch (e) {
    writeOk = false;
    out.push({
      name: "数据目录可写",
      level: "FAIL",
      detail: `${path.dirname(dbFile)} 不可写:${e instanceof Error ? e.message : String(e)}`,
      hint: "换一个有写权限的目录运行,或把项目从只读位置(如压缩包内、Program Files)移出",
    });
  }
  if (writeOk) {
    out.push({ name: "数据文件位置", level: "PASS", detail: `${dbFile}${fs.existsSync(dbFile) ? "(已存在)" : "(首次启动自动创建)"}` });
  }

  // 4) 迁移状态
  try {
    // 这里必须用 require 而不是顶层 import:native 模块加载失败时,
    // import 会让 doctor 自己先崩,而用户最需要的是这条检查给出人话。
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const exists = fs.existsSync(dbFile);
    const db = new Database(dbFile, { readonly: exists });
    const dir = path.join(ROOT, "drizzle");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
    const applied = exists
      ? new Set(
          (db.prepare("select hash from __drizzle_migrations").all() as { hash: string }[]).map((r) => r.hash),
        )
      : new Set<string>();
    const pending = files.filter((f) => !applied.has(f));
    db.close();
    if (!exists) {
      out.push({ name: "迁移状态", level: "PASS", detail: `首次启动会自动创建库并执行 ${files.length} 个迁移` });
    } else if (pending.length) {
      out.push({
        name: "迁移状态",
        level: "PASS",
        detail: `${pending.length} 个迁移待执行(${pending.join(", ")}) —— 启动时自动执行,并先自动备份`,
      });
    } else {
      out.push({ name: "迁移状态", level: "PASS", detail: `已是最新(${files.length} 个迁移全部执行)` });
    }
  } catch (e) {
    out.push({
      name: "迁移状态",
      level: "FAIL",
      detail: `无法读取迁移记录:${e instanceof Error ? e.message : String(e)}`,
      hint: "如果数据库损坏,先用 data/backup/ 里的最近一份还原",
    });
  }

  // 5) 密钥状态(只报有无)
  const secrets: [string, string][] = [
    ["ZHIHU_ACCESS_SECRET", "知乎官方采集"],
    ["EMBEDDING_API_KEY", "语义向量(不配置则用本地词法基线)"],
    ["STUDIO_API_KEY", "AI 选题方案(不配置仍有确定性证据摘要)"],
  ];
  const cliForStudio = process.env.STUDIO_CLI_COMMAND?.trim() ?? "";
  for (const [name, what] of secrets) {
    let set = Boolean(process.env[name]?.trim());
    // 选题能力有两种合法来源:外部 Key,或本机已登录的 CLI(个人项目常没有 Key)
    if (name === "STUDIO_API_KEY" && !set && cliForStudio) {
      out.push({
        name: `密钥 ${name}`,
        level: "PASS",
        detail: `未配置,但已启用本机 AI 命令 ${cliForStudio} —— ${what}`,
        hint: `不想用本机 CLI 时,清空 .env 里的 STUDIO_CLI_COMMAND 即可`,
      });
      continue;
    }
    out.push({
      name: `密钥 ${name}`,
      level: set ? "PASS" : "WARN",
      detail: `${set ? "已配置" : "未配置"} —— ${what}`,
      hint: set ? undefined : `需要时在项目目录 .env 写 ${name}=...(参见 .env.example),改完需重启`,
    });
  }

  // 6) 端口
  const p = await portFree(port);
  out.push({
    name: `端口 ${port}`,
    level: p.free ? "PASS" : "WARN",
    detail: p.free ? "可用" : `已被占用(${p.error ?? "EADDRINUSE"})`,
    hint: p.free ? undefined : `换个端口启动:PORT=5199 npm start;或先停掉占用该端口的旧实例`,
  });

  // 7) 构建产物
  const hasServer = fs.existsSync(path.join(ROOT, "dist-server", "index.js"));
  const hasClient = fs.existsSync(path.join(ROOT, "dist", "index.html"));
  out.push({
    name: "构建产物",
    level: hasServer && hasClient ? "PASS" : "FAIL",
    detail: hasServer && hasClient ? "dist-server 与 dist 均就绪" : `dist-server:${hasServer} dist:${hasClient}`,
    hint: hasServer && hasClient ? undefined : "先运行 npm run build",
  });

  // 8) 备份
  try {
    const backupDir = path.join(path.dirname(dbFile), "backup");
    const list = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => f.endsWith(".db")) : [];
    const newest = list
      .map((f) => ({ f, m: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    out.push({
      name: "备份可用性",
      level: newest ? "PASS" : "WARN",
      detail: newest
        ? `${list.length} 份备份,最近一份 ${newest.f}(${new Date(newest.m).toLocaleString()})`
        : "还没有任何备份文件",
      hint: newest ? undefined : "npm run db:backup(有数据后建议定期执行)",
    });
  } catch {
    out.push({ name: "备份可用性", level: "WARN", detail: "无法读取备份目录" });
  }

  return out;
}

function isDemoFlag(): boolean {
  return process.env.TRENDSCOPE_DEMO === "1" || process.env.TRENDSCOPE_DEMO === "true";
}

export function summarize(results: CheckResult[]): { line: string; failed: number; warned: number } {
  const failed = results.filter((r) => r.level === "FAIL").length;
  const warned = results.filter((r) => r.level === "WARN").length;
  const verdict = failed ? "FAIL" : warned ? "PASS(含提醒)" : "PASS";
  return {
    line: `${verdict} —— ${results.length} 项检查:${results.length - failed - warned} 通过 / ${warned} 提醒 / ${failed} 失败`,
    failed,
    warned,
  };
}
