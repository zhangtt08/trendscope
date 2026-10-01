#!/usr/bin/env node
/**
 * TrendScope · Agent 能力注册表(ESM 入口)
 *
 * 实现只有一份:`server/src/agent/tools.ts`(编译产物 `dist-server/agent/tools.js`)。
 * 这个文件**不重写任何 handler** —— 把 handler 复制一份到 .mjs 里,迟早会出现
 * "Agent 看到的数字和界面看到的数字不一样"这种最难查的缺陷。这里做的只有三件事:
 *   1. 把编译产物里的注册表原样透出(listTools / getManifest / callTool);
 *   2. 决定走哪条路服务未启动时怎么兜底(见 callTool 的注释);
 *   3. 给命令行一个可自查的入口(--list / --manifest / --call / --selftest)。
 *
 * 用法:
 *   node agent/tools.mjs --list
 *   node agent/tools.mjs --manifest
 *   node agent/tools.mjs --call trendscope.overview
 *   node agent/tools.mjs --call trendscope.search_contents '{"keyword":"AI","pageSize":3}'
 *   node agent/tools.mjs --selftest            # 逐个跑只读工具,确认没有假数据
 *
 * 端口与启动:见 agent/README.md 与 agent/launch.json(服务仍是不动产的 5184,不另起进程)。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_BASE = process.env.AGENT_DEFAULT_BASE || "http://127.0.0.1:5184";

/* ------------------------------------------------------------------ *
 * 注册表加载
 * ------------------------------------------------------------------ */

let cachedRegistry = null;

/** 读编译产物里的真实注册表;没构建时给出可执行出路,而不是抛一句 MODULE_NOT_FOUND。 */
export function loadRegistry() {
  if (cachedRegistry) return cachedRegistry;
  const built = path.join(PROJECT_ROOT, "dist-server", "agent", "tools.js");
  if (!existsSync(built)) {
    throw new Error(
      `找不到编译产物 ${built}\n` +
        "  注册表的实现只有一份 TypeScript 源(server/src/agent/tools.ts),必须先编译:\n" +
        "    npm run build:server\n" +
        "  日常入口 start-trendscope.bat 会自动判断需不需要重新构建(它调 scripts/build-if-needed.ps1)。",
    );
  }
  cachedRegistry = require(built);
  return cachedRegistry;
}

export function listTools() {
  return loadRegistry().listAgentTools();
}

export function baseUrlCandidates() {
  const endpoint = path.join(__dirname, ".endpoint");
  return [
    process.env.AGENT_BASE_URL,
    existsSync(endpoint) ? readFileSync(endpoint, "utf8").trim() : null,
    DEFAULT_BASE,
  ].filter(Boolean);
}

/** 找一个活着的服务地址;都不活着返回 null(调用方据此决定走直连还是报错)。 */
export async function findLiveBase(timeoutMs = 1500) {
  for (const base of baseUrlCandidates()) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return base;
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

export async function getManifest() {
  const base = await findLiveBase();
  if (base) {
    const r = await fetch(`${base}/api/agent/manifest`, { signal: AbortSignal.timeout(5000) });
    const body = await r.json();
    return { ...body, _via: `${base}/api/agent/manifest` };
  }
  const reg = loadRegistry();
  return {
    ok: true,
    data: {
      project: reg.AGENT_PROJECT_ID,
      version: readPkgVersion(),
      base_url: DEFAULT_BASE,
      agent_api: reg.AGENT_API_VERSION,
      tools: reg.listAgentTools(),
    },
    _via: "本地注册表(服务未启动;起服请用 node agent/serve.mjs)",
  };
}

function readPkgVersion() {
  try {
    return JSON.parse(readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0-unknown";
  }
}

/* ------------------------------------------------------------------ *
 * 调用
 * ------------------------------------------------------------------ */

/**
 * 服务活着就走 HTTP(唯一正路:共用那一条常驻连接与那份进程内引擎锁);
 * 服务没起时只读工具可以直连本地库跑一遍(同一个 handler,同一份 SQL);
 * 非只读工具在直连模式下**拒绝执行** —— 绕开进程内引擎锁去写用户的库,
 * 正好是本项目用一整条 engineLock 模块要避免的那件事。
 */
export async function callTool(name, input = {}, opts = {}) {
  const reg = loadRegistry();
  const tool = reg.listAgentTools().find((t) => t.name === name);
  if (!tool) {
    throw new Error(
      `没有名为「${name}」的工具。可用:${reg.listAgentTools().map((t) => t.name).join(", ")}`,
    );
  }
  const base = opts.preferHttp === false ? null : await findLiveBase();
  if (base) {
    const started = Date.now();
    const r = await fetch(`${base}/api/agent/tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: name, input }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.ok === false) {
      const e = body?.error ?? {};
      const err = new Error(e.message || `HTTP ${r.status}`);
      err.code = e.code ?? "http_error";
      err.hint = e.hint;
      throw err;
    }
    return { ...body, _via: `${base}/api/agent/tool`, _ms: Date.now() - started };
  }

  if (tool.risk !== "read") {
    throw new Error(
      `工具「${name}」的风险等级是 ${tool.risk},而 TrendScope 服务当前没在运行。\n` +
        "  非只读工具必须经由常驻服务执行:引擎互斥锁(engineLock)是进程内的," +
        "另开一个连接直接写库会绕过它,可能与分析任务同时跑。\n" +
        "  起服:node agent/serve.mjs(或双击 start-trendscope.bat),然后重跑本命令。",
    );
  }

  const { openDb, resolveDbPath } = require(path.join(PROJECT_ROOT, "dist-server", "db", "client.js"));
  const { sqlite, db } = openDb(resolveDbPath());
  try {
    const t0 = Date.now();
    const r = await reg.executeAgentTool(name, input, {
      db,
      bootedAt: t0,
      baseUrl: DEFAULT_BASE,
    });
    return { ok: true, data: r.data, tool: r.tool, risk: r.risk, ms: Date.now() - t0, _via: "直连本地库(服务未启动)" };
  } finally {
    sqlite.close();
  }
}

/* ------------------------------------------------------------------ *
 * CLI(输出走 ASCII 转义:这台机器的控制台是 GBK,原样打中文会变成乱码)
 * ------------------------------------------------------------------ */

function ascii(s) {
  return String(s).replace(/[^\x09\x0a\x0d\x20-\x7e]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function out(s) {
  process.stdout.write(ascii(s) + "\n");
}

async function main(argv) {
  const flag = argv[0];
  if (!flag || flag === "--help" || flag === "-h") {
    out("用法: node agent/tools.mjs --list | --manifest | --call <tool> ['{json}'] | --selftest");
    return 0;
  }

  if (flag === "--list") {
    const tools = listTools();
    for (const t of tools) out(`${t.name}\t${t.risk}`);
    out(`(共 ${tools.length} 个工具,清单与 GET /api/agent/tools 同源)`);
    return 0;
  }

  if (flag === "--manifest") {
    const m = await getManifest();
    out(JSON.stringify(m, null, 2));
    return 0;
  }

  if (flag === "--call") {
    const name = argv[1];
    if (!name) {
      out("缺少工具名。例:node agent/tools.mjs --call trendscope.overview");
      return 2;
    }
    let input = {};
    if (argv[2]) {
      try {
        input = JSON.parse(argv[2]);
      } catch (e) {
        out(`input 不是合法 JSON:${e.message}`);
        return 2;
      }
    }
    try {
      const r = await callTool(name, input);
      out(JSON.stringify(r, null, 2));
      return 0;
    } catch (e) {
      out(`调用失败 [${e.code ?? "error"}] ${e.message}`);
      if (e.hint) out(`  出路:${e.hint}`);
      return 1;
    }
  }

  if (flag === "--selftest") {
    const tools = listTools().filter((t) => t.risk === "read");
    // 详情类工具要真实 id:先用同一条检索拿一个,再拿它去调详情 —— 自检才不算"必填字段缺失"
    // 这种自己造出来的失败(那是脚本的问题,不是工具的问题)。
    let sampleContentId = null;
    let sampleTopicId = null;
    try {
      const c = await callTool("trendscope.search_contents", { pageSize: 1 });
      sampleContentId = c.data?.rows?.[0]?.id ?? null;
    } catch { /* 库里没有内容就跳过详情 */ }
    try {
      const t = await callTool("trendscope.list_topics", { pageSize: 1 });
      sampleTopicId = t.data?.rows?.[0]?.topic_id ?? null;
    } catch { /* 没评分结果就跳过 */ }
    const inputs = {
      "trendscope.content_detail": sampleContentId ? { contentItemId: sampleContentId } : null,
      "trendscope.topic_detail": sampleTopicId ? { topicId: sampleTopicId } : null,
    };
    let failed = 0;
    let skipped = 0;
    for (const t of tools) {
      const input = inputs[t.name] ?? {};
      if (input === null) {
        skipped += 1;
        out(`SKIP ${t.name}  (本机库里还没有可用于这条工具的 id)`);
        continue;
      }
      const started = Date.now();
      try {
        const r = await callTool(t.name, input);
        const size = JSON.stringify(r.data ?? null).length;
        out(`PASS ${t.name}  ${Date.now() - started}ms  payload=${size}B`);
      } catch (e) {
        failed += 1;
        out(`FAIL ${t.name}  ${e.code ?? ""} ${e.message.split("\n")[0]}`);
      }
    }
    out(
      `只读工具自检:${tools.length - failed - skipped}/${tools.length - skipped} 通过` +
        `(跳过 ${skipped} 条;非只读工具不在自检范围内 —— 它们会花额度并写记录,必须 confirm)`,
    );
    return failed ? 1 : 0;
  }

  out(`不认识参数 ${flag};用 --help 看用法`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 用 exitCode 而不是 process.exit():Windows 上 fetch 的 socket 还在收尾时硬退出会撞
  // libuv 的 "UV_HANDLE_CLOSING" 断言(实测踩过),而事件循环本来就会自己排空。
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((e) => {
      out(`异常:${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    });
}
