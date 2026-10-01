#!/usr/bin/env node
/**
 * TrendScope · 一条命令起服(薄封装,不含任何业务逻辑)
 *
 * 服务本来就是项目自带的那一个(Express,127.0.0.1:5184,`npm start`),
 * 这里只补三件 Agent 侧需要的事:
 *   1. 先看 5184 是不是已经活着(用户平时是双击 start-trendscope.bat 或用桌面壳在跑的);
 *   2. 没活就用项目自己的启动方式拉起来(detached,或 --foreground 跟着终端走);
 *   3. 就绪等待 —— **首次 /api/health 在这台机器上实测要几十秒**(1.3GB 库冷缓存),
 *      所以超时给到 120s 并一路打印已等待时间,而不是 10 秒就报"起服失败"这种假故障。
 *
 * 用法: node agent/serve.mjs [--port 5184] [--foreground] [--stop-hint]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(PROJECT_ROOT, "dist-server", "index.js");

function ascii(s) {
  return String(s).replace(/[^\x09\x0a\x0d\x20-\x7e]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
const say = (s) => process.stdout.write(ascii(s) + "\n");

/** port.txt 是启动脚本用的同一个来源,不要在这里另立一套端口约定。 */
function pickPort(argv) {
  const cli = argv.find((a) => a.startsWith("--port="));
  if (cli) return Number(cli.split("=")[1]);
  const env = Number(process.env.PORT);
  if (Number.isFinite(env) && env > 0) return env;
  const file = path.join(PROJECT_ROOT, "port.txt");
  if (existsSync(file)) {
    const n = Number(readFileSync(file, "utf8").trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5184;
}

async function health(port, timeoutMs = 2000) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function waitReady(port, deadlineMs) {
  const t0 = Date.now();
  let lastReport = 0;
  while (Date.now() - t0 < deadlineMs) {
    const h = await health(port, 30_000);
    if (h) return { body: h, ms: Date.now() - t0 };
    const waited = Math.round((Date.now() - t0) / 1000);
    if (waited > 0 && waited - lastReport >= 5) {
      lastReport = waited;
      say(`  等待中… ${waited}s(库冷缓存时首次健康检查本身就要几十秒)`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const foreground = argv.includes("--foreground");
  const port = pickPort(argv);
  const base = `http://127.0.0.1:${port}`;

  const already = await health(port, 2500);
  if (already) {
    say(`服务已在运行:${base}`);
    say(`  version=${already.data?.version ?? "?"} agent_api=${already.data?.agent_api ?? "?"} uptime_ms=${already.data?.uptime_ms ?? "?"}`);
    printEndpoints(base);
    return 0;
  }

  if (!existsSync(ENTRY)) {
    say(`起服失败:找不到 ${path.relative(PROJECT_ROOT, ENTRY).replace(/\\/g, "/")}`);
    say("  那是项目的服务端构建产物。先构建:");
    say("    npm run build:server      (只编服务端,约 5s)");
    say("  或直接双击 start-trendscope.bat,它会自己判断要不要重新构建。");
    return 1;
  }

  say(`服务未运行,用项目自带方式拉起:node dist-server/index.js(PORT=${port})`);
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: foreground ? "inherit" : "ignore",
    detached: !foreground,
  });
  if (!foreground) child.unref();

  const ready = await waitReady(port, 120_000);
  if (!ready) {
    say(`拉起超时(120s)。查看服务输出可以前台再跑一次:node agent/serve.mjs --foreground`);
    say("端口被占时服务会自己报错退出;项目文档 docs/PROJECT_STATE.md 也记了这个坑。");
    return 1;
  }
  const endpointFile = path.join(__dirname, ".endpoint");
  writeFileSync(endpointFile, base, "utf8");
  say(`服务就绪(${ready.ms}ms):${base}`);
  say(`  已把实际地址写入 agent/.endpoint(MCP 桥优先读它)`);
  printEndpoints(base);
  if (!foreground) say("  进程在后台运行;停止:node agent/serve.mjs --stop-hint 里写的办法,或直接重启电脑。");
  return 0;
}

function printEndpoints(base) {
  say("Agent 契约四个端点:");
  say(`  GET  ${base}/api/health`);
  say(`  GET  ${base}/api/agent/tools`);
  say(`  GET  ${base}/api/agent/manifest`);
  say(`  POST ${base}/api/agent/tool   body {"tool":"trendscope.overview","input":{}}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 同 tools.mjs:不硬 process.exit(),让 fetch 的 socket 收尾完再自然退出,
  // 否则 Windows 上会撞 libuv 的 UV_HANDLE_CLOSING 断言。
  main().then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (e) => {
      say(`起服异常:${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}

export { main as serveOnce };
