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
import { LOCAL_BIND_HOST } from "./local-guard";
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

/**
 * 探一个端口在**某个具体地址**上是否空闲。
 *
 * 为什么判据里必须带地址:同一个端口号,绑在 `127.0.0.1` 与绑在 `0.0.0.0` 是两件完全不同的事
 * —— 前者只有本机能连,后者整个局域网都进得来。过去这一行写死 `127.0.0.1` 探测却把结果报成
 * "端口 5184 可用",而当时服务实际监听的是 `0.0.0.0`(Node 不带 host 参数时的默认值),
 * 于是体检说的是"回环上没人",用户读成"这台机器上没人"。
 * 现在探测地址与应用绑定地址同源(都取 `LOCAL_BIND_HOST`),报告里也必须把这个地址写出来。
 */
function probePort(
  port: number,
  host: string,
): Promise<{ free: boolean; host: string; error?: string }> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e: NodeJS.ErrnoException) => resolve({ free: false, host, error: e.code }));
    srv.once("listening", () => {
      srv.close(() => resolve({ free: true, host }));
    });
    srv.listen(port, host);
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

  // 6) 端口 —— 报的是**应用实际会绑的那个地址**,而且不许把"回环上没人"说成"这端口空闲"
  //
  // 实测(本机 Windows,2026-10-05):已经有一个进程在 `0.0.0.0:P` 上监听时,
  // 再探 `127.0.0.1:P` 会拿到"空闲"。旧体检就是这么报的 —— 于是它说"端口可用",
  // 而那时应用绑的是 0.0.0.0(Node 不带 host 的默认值),真启动会撞 EADDRINUSE;
  // 更要紧的是:那个占着端口的进程对整个局域网开放,界面与 Agent 都可能打到它身上。
  // 现在两条探测都要做,并且报告里必须写清楚是哪一个地址空闲、被占用的是哪一个地址。
  const bindHost = LOCAL_BIND_HOST;
  const onBind = await probePort(port, bindHost);
  const onAll = await probePort(port, "0.0.0.0");
  if (!onBind.free) {
    out.push({
      name: `端口 ${bindHost}:${port}`,
      level: "WARN",
      detail: `已被占用(${onBind.error ?? "EADDRINUSE"})` +
        (onAll.free ? ` —— 占用者只占 ${bindHost}:${port}` : ` —— 而且有一个进程在监听 0.0.0.0:${port},整个局域网都进得来`),
      hint:
        `换一个端口启动:PORT=5199 npm start(之后要访问的就是 ${bindHost}:5199);` +
        `或先确认是不是旧实例还在跑 —— 只停你自己起的那一个。`,
    });
  } else if (!onAll.free) {
    out.push({
      name: `端口 ${bindHost}:${port}`,
      level: "WARN",
      detail:
        `${bindHost}:${port} 本身能绑,但端口 ${port} 上已经有一个监听 **所有网卡** 的进程(0.0.0.0:${port})。` +
        `它对整个局域网开放,界面与 Agent 都可能打到它而不是本服务 —— 最常见的原因是还有一个升级前的旧实例在跑。`,
      hint:
        `先确认那一个是谁(它不是本机回环服务);要么把它停掉(只停你自己起的),要么用 PORT= 换一个端口,` +
        `本服务只会绑 ${bindHost},不会对外开放。`,
    });
  } else {
    out.push({
      name: `端口 ${bindHost}:${port}`,
      level: "PASS",
      detail: `空闲 —— ${bindHost}:${port} 与 0.0.0.0:${port} 两侧都没有人占,服务起来后只有本机能连`,
    });
  }

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
