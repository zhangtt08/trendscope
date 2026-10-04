#!/usr/bin/env node
/**
 * npm run verify:release —— Release 1.0 交付闸门(可重复、机器判定)。
 *
 * 只放能被机器证明的验收项:交付元数据、配置模板、静态扫描(界面中英混杂 / 原生弹窗 /
 * 密钥外泄)、类型检查、构建、测试、体检、数据库健康、评估不回退、文档齐备。
 * 需要人眼判断的(文案是否好读、结论是否有用)不在这里,记在 docs/RELEASE_NOTES_1.0.md。
 *
 * 退出码:任一 FAIL → 1;否则 0(SKIP 说明原因,不算失败)。
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const ROOT = process.cwd();
type Level = "PASS" | "FAIL" | "SKIP";
interface Row {
  name: string;
  level: Level;
  detail: string;
}
const rows: Row[] = [];

function record(name: string, level: Level, detail: string) {
  rows.push({ name, level, detail });
  const mark = level === "PASS" ? "OK  " : level === "FAIL" ? "FAIL" : "SKIP";
  console.log(`[${mark}] ${name.padEnd(24)} ${detail}`);
}

/**
 * vitest 把结果汇总写在 **stderr** 上,只收 stdout 会解析不到"Tests N passed" ——
 * 这里强制合并两条流,保证汇总能被断言(而不是靠"退出码 0 就算过")。
 *
 * `env` 是给"必须与真实使用者数据隔离"的那几项用的:体检会在库目录里落一个写探针,
 * 绝不能拿 `data/`(这里是使用者 3.9 GB 的真实库)当试验田。
 */
function run(cmd: string, ms = 900_000, env?: NodeJS.ProcessEnv): { ok: boolean; out: string } {
  try {
    const out = execSync(`${cmd} 2>&1`, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: ms,
      ...(env ? { env } : {}),
    });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`.slice(0, 6000) };
  }
}

/** vitest 会带 ANSI 颜色码,数字被夹在转义序列里就匹配不到汇总 —— 先去色再解析。 */
const ANSI = new RegExp("[\u001b\u009b][[\u0030-\u003f]*(?:[\u0040-\u005a]|[\u0061-\u007a])", "g");
function plain(text: string): string {
  return text.replace(ANSI, "");
}

function tail(text: string, n = 3): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(" / ");
}

function walk(dir: string, ext: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", "dist", "dist-server", ".git", "coverage", "data", "screenshots"].includes(e.name)) walk(p, ext, out);
    } else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
const NL = String.fromCharCode(10);
const CJK = "[一-鿿]";

/** 构建产物 → 它是由哪些源码构建出来的。判"新鲜不新鲜"必须按这套输入,不能一把抓。 */
const ARTIFACTS: { name: string; file: string; inputs: { dir?: string; exts?: string[]; files?: string[] }[] }[] = [
  {
    name: "dist-server",
    file: "dist-server/index.js",
    inputs: [{ dir: "server/src", exts: [".ts", ".tsx"] }, { files: ["package.json", "tsconfig.server.json"] }],
  },
  {
    name: "dist",
    file: "dist/index.html",
    inputs: [
      { dir: "src", exts: [".tsx", ".ts", ".css"] },
      { dir: "public", exts: [] },
      { files: ["index.html", "vite.config.ts", "package.json", "tsconfig.json"] },
    ],
  },
];

/** 收集某个产物的全部构建输入(目录里按扩展名递归 + 散在根上的配置文件)。 */
function inputsOf(spec: (typeof ARTIFACTS)[number]["inputs"]): string[] {
  const out: string[] = [];
  for (const i of spec) {
    if (i.dir) {
      const exts = i.exts && i.exts.length ? i.exts : [""];
      for (const ext of exts) {
        for (const f of walk(path.join(ROOT, i.dir), ext)) out.push(f);
      }
    }
    for (const f of i.files ?? []) out.push(path.join(ROOT, f));
  }
  return out;
}

/** 一组文件里最新的 mtime(文件不存在算 0,交给调用方报"缺产物"而不是"新鲜")。 */
function newestOf(files: string[]): { file: string; mtime: number } {
  let best = { file: "", mtime: 0 };
  for (const f of files) {
    let m = 0;
    try {
      m = fs.statSync(f).mtimeMs;
    } catch {
      continue;
    }
    if (m > best.mtime) best = { file: f, mtime: m };
  }
  return best;
}

function staleness(): { name: string; artifact: string; artifactMtime: number; source: string; sourceMtime: number }[] {
  const stale: { name: string; artifact: string; artifactMtime: number; source: string; sourceMtime: number }[] = [];
  for (const spec of ARTIFACTS) {
    const artifact = path.join(ROOT, spec.file);
    const src = newestOf(inputsOf(spec.inputs));
    if (!fs.existsSync(artifact)) {
      stale.push({ name: spec.name, artifact: spec.file, artifactMtime: 0, source: rel(src.file), sourceMtime: src.mtime });
      continue;
    }
    const am = fs.statSync(artifact).mtimeMs;
    if (src.mtime > am) {
      stale.push({
        name: spec.name,
        artifact: spec.file,
        artifactMtime: am,
        source: rel(src.file),
        sourceMtime: src.mtime,
      });
    }
  }
  return stale;
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
void minutes; // 保留给"落后多少分钟"这类报告用,当前各条按秒报

/* ============================ 交付物实跑要用到的那几件 ============================
 * 这一节必须**真起构建产物**:前面每一项测的都是源码,而用户双击运行的那一台是
 * `node dist-server/index.js`。绑定地址、闸门接线、契约四端点的形状,只有把这一台真起来
 * 才量得到(2026-10-05 实测:源码改了、产物没重建,或者闸门被 SPA 兜底挤到后面,
 * 全都在这条上现形)。
 *
 * 隔离:库文件、备份目录全在临时目录里(`TRENDSCOPE_DB` 是本仓唯一认这个的入口),
 * 端口是临时挑的空闲端口,绝不用 `data/` —— 这里是使用者 3.9 GB 的真实库。
 * 子进程由本脚本起、也由本脚本停(不是任何人的实例)。
 */
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function freePort(): Promise<number> {
  const srv = net.createServer();
  return new Promise((res, rej) => {
    srv.once("error", rej);
    srv.once("listening", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => res(port));
    });
    srv.listen(0, "127.0.0.1");
  });
}

interface HttpReply {
  status: number;
  contentType: string;
  text: string;
  json: any | null;
  error?: string;
}

/** 真发一条 HTTP 请求;`hostHeader` 逐字决定 Host(闸门判的就是它,不能用 fetch 的默认值)。 */
function hit(
  port: number,
  opts: { method?: string; path?: string; hostHeader?: string; connectHost?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpReply> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      Host: opts.hostHeader ?? `127.0.0.1:${port}`,
      ...(opts.headers ?? {}),
    };
    if (opts.body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
      headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    }
    const req = http.request(
      {
        host: opts.connectHost ?? "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/api/health",
        headers,
        timeout: 20_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON 就是要抓的形状 */
          }
          resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? ""), text, json });
        });
      },
    );
    req.on("error", (e) =>
      resolve({ status: 0, contentType: "", text: "", json: null, error: (e as NodeJS.ErrnoException).code }),
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, contentType: "", text: "", json: null, error: "ETIMEDOUT" });
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

interface Booted {
  child: ReturnType<typeof spawn>;
  out: () => string;
  port: number;
  dbFile: string;
}

/** 起那一台**已经构建好的**服务(不是 tsx 直跑源码),等它真的能连上。 */
async function bootBuilt(port: number, dbFile: string, token: string): Promise<Booted> {
  const child = spawn(process.execPath, ["dist-server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), TRENDSCOPE_DB: dbFile, TRENDSCOPE_LOCAL_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let acc = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => (acc += c));
  child.stderr?.on("data", (c: string) => (acc += c));
  const booted: Booted = { child, out: () => acc, port, dbFile };

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(`子进程提前退出(code=${child.exitCode}):${acc.slice(-800)}`);
    }
    const r = await hit(port, { path: "/api/health" });
    if (r.status === 200) return booted;
    await sleep(500);
  }
  child.kill();
  throw new Error(`120 秒内没有就绪:${acc.slice(-800)}`);
}

/**
 * 停掉**本脚本自己起的**那一个子进程,并等它真的退出。
 * Windows 上等退出是有必要的:进程还活着时它握着临时目录里的库文件,
 * 紧接着 `rmSync` 会 EPERM(实测)。等不到也只记录,绝不让收尾把闸门炸掉。
 */
async function stopBooted(b: Booted): Promise<string | null> {
  if (b.child.exitCode !== null && b.child.exitCode !== undefined) return null;
  const exited = new Promise<string>((res) => b.child.once("exit", (code) => res(String(code))));
  const timeout = new Promise<string>((res) => setTimeout(() => res("timeout"), 15_000));
  try {
    b.child.kill();
  } catch {
    /* 已经退了 */
  }
  const how = await Promise.race([exited, timeout]);
  return how === "timeout" ? `子进程 15 秒内没退出(端口 ${b.port})` : null;
}

/** 收尾删临时目录:被占住时按 maxRetries 重试,删不掉也只报告,不抛。 */
function removeTmp(dir: string): string | null {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
    return fs.existsSync(dir) ? `临时目录没删干净:${dir}` : null;
  } catch (e) {
    return `临时目录删除失败(不影响结论):${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------- 1. 交付元数据(版本只有一个来源:package.json) ----------
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    version: string;
    engines?: { node?: string };
    scripts: Record<string, string>;
  };
  const missing = ["start", "demo", "doctor", "db:backup", "verify:release"].filter((s) => !pkg.scripts?.[s]);
  const ok = pkg.version === "1.0.0" && Boolean(pkg.engines?.node) && missing.length === 0;
  record(
    "包元数据",
    ok ? "PASS" : "FAIL",
    ok
      ? `version ${pkg.version} · engines.node ${pkg.engines?.node} · 关键脚本齐全`
      : `version=${pkg.version} engines=${pkg.engines?.node ?? "缺"} 缺脚本=${missing.join(",") || "无"}`,
  );
}

// ---------- 2. .env.example(§61:只列约定内的变量,且不给真实值) ----------
{
  const file = path.join(ROOT, ".env.example");
  const ALLOWED = [
    "ZHIHU_ACCESS_SECRET",
    "EMBEDDING_API_KEY",
    "EMBEDDING_BASE_URL",
    "EMBEDDING_MODEL",
    "STUDIO_API_KEY",
    "STUDIO_BASE_URL",
    "STUDIO_MODEL",
    // 没有外部 Key 时的合法替代:复用本机已登录的 AI 命令(值不是密钥)
    "STUDIO_CLI_COMMAND",
    "WEIBO_COOKIE",
    "TRENDSCOPE_HOT_CASCADE",
    // 本机边界的可选共享令牌(默认留空 = 不启用;闸门要求非 GET 带 x-agent-token)
    "TRENDSCOPE_LOCAL_TOKEN",
  ];
  if (!fs.existsSync(file)) {
    record(".env.example", "FAIL", "文件不存在");
  } else {
    const text = fs.readFileSync(file, "utf8");
    const keys = [...text.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]);
    const extra = keys.filter((k) => !ALLOWED.includes(k));
    const absent = ALLOWED.filter((k) => !keys.includes(k));
    const secretWithValue = [...text.matchAll(/^([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN)[A-Z0-9_]*)=(\S.*)$/gm)].map((m) => m[1]);
    const ok = extra.length === 0 && absent.length === 0 && secretWithValue.length === 0;
    record(
      ".env.example",
      ok ? "PASS" : "FAIL",
      ok
        ? `${keys.length} 个键与约定一致;密钥类键留空`
        : `多出=${extra.join(",") || "无"} 缺少=${absent.join(",") || "无"} 带真实值=${secretWithValue.join(",") || "无"}`,
    );
  }
}

// ---------- 3. .gitignore(§62) ----------
{
  const file = path.join(ROOT, ".gitignore");
  if (!fs.existsSync(file)) {
    record(".gitignore", "FAIL", "文件不存在");
  } else {
    const text = fs.readFileSync(file, "utf8");
    const need = [".env", ".db-wal", "node_modules", "dist"];
    const miss = need.filter((n) => !text.includes(n));
    record(
      ".gitignore",
      miss.length === 0 ? "PASS" : "FAIL",
      miss.length ? `缺少覆盖:${miss.join(", ")}` : "已覆盖 .env / WAL 临时文件 / 依赖 / 构建产物",
    );
  }
}

// ---------- 4. 静态扫描:中英混杂 / 原生弹窗 / 密钥回显 ----------
{
  /**
   * 口径:一条用户可见文案里同时出现中文与"未被认可的英文词"即算混杂(§78)。
   * 认可的是必须由用户照抄的标识(命令、路径、环境变量名、版本号)与少量技术名词。
   */
  const ALLOW = new Set(["json", "sqlite", "node", "utf", "video", "webview", "token"]);
  const JSX_TEXT = new RegExp(">" + "\\s*([^<>{}]*" + CJK + "[^<>{}]*)" + "<", "gs");
  const ATTR_TEXT = new RegExp("(?:placeholder|title|aria-label)=\"([^\"]*" + CJK + "[^\"]*)\"", "g");
  const CMD = new RegExp("npm\\s+run\\s+[a-z:]+", "gi");
  const FILEPATH = new RegExp("[A-Za-z0-9_.\\-]+\\.(db|json|csv|md)", "gi");
  const DATADIR = new RegExp("data/[^\\s)]+", "gi");
  const VER = new RegExp("v[0-9]+(\\.[0-9]+)*", "gi");
  const UPPER = new RegExp("[A-Z][A-Z0-9_]{2,}", "g");
  const LATIN4 = new RegExp("[A-Za-z]{4,}", "g");
  const WS = new RegExp("\\s+", "g");
  // 注释不是用户可见文案(里面出现 code 名、环境变量名反而是好事),扫描前先剥掉。
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  const files = walk(path.join(ROOT, "src"), ".tsx");
  const mixed: string[] = [];
  const modals: string[] = [];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, "utf8"));
    const chunks: string[] = [];
    for (const m of src.matchAll(JSX_TEXT)) chunks.push(m[1]);
    for (const m of src.matchAll(ATTR_TEXT)) chunks.push(m[1]);
    for (const raw of chunks) {
      const stripped = raw
        .replace(CMD, " ")
        .replace(FILEPATH, " ")
        .replace(DATADIR, " ")
        .replace(VER, " ")
        .replace(UPPER, " ")
        .replace("TRENDSCOPE", " ");
      const bad = (stripped.match(LATIN4) ?? []).filter((w) => !ALLOW.has(w.toLowerCase()));
      if (bad.length) mixed.push(`${rel(f)}: ${bad.join(",")} · ${raw.replace(WS, " ").trim().slice(0, 60)}`);
    }
    if (src.includes("window.prompt(")) modals.push(`${rel(f)}: window.prompt`);
  }

  const SECRET_NAME = new RegExp("[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN)[A-Z0-9_]*", "g");
  const RESP = new RegExp("res\\.json\\([\\s\\S]{0,600}?\\);", "g");
  const secretEcho: string[] = [];
  for (const f of walk(path.join(ROOT, "server/src"), ".ts")) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(RESP)) {
      const keys = [...new Set(m[0].match(SECRET_NAME) ?? [])].filter((k) => k.length > 3);
      if (keys.length) secretEcho.push(`${rel(f)}: ${keys.join(",")}`);
    }
  }

  const uniq = [...new Set(mixed)];
  const ok = uniq.length === 0 && modals.length === 0 && secretEcho.length === 0;
  record(
    "静态扫描",
    ok ? "PASS" : "FAIL",
    ok
      ? `${files.length} 个组件:无中英混杂文案、无 window.prompt;接口不回显密钥类变量`
      : `混杂 ${uniq.length} 处(${uniq.slice(0, 2).join(" | ")});原生弹窗 ${modals.length} 处;密钥回显 ${secretEcho.length} 处`,
  );
}

// ---------- 5. 类型检查 ----------
{
  const r = run("npm run typecheck", 300_000);
  record("类型检查", r.ok ? "PASS" : "FAIL", r.ok ? "前端与服务端 tsconfig 均 0 错误" : tail(r.out, 4));
}

// ---------- 6. 产物新鲜度(在重新构建**之前**量) ----------
//
// 为什么必须在前面:这一项原本的写法是"跑 npm run build,产物在就算过"。可交付的是那两份目录,
// 而 `npm run build` 无论如何都会重写它们 —— 于是"磁盘上那份 dist/ 是三个月前构建的"这件事
// 永远不会被说出来,静默重建一次就把证据抹掉了。这里按 mtime 逐产物比它自己的构建输入:
// 产物早于最新输入 = 这一份不是当前源码构建出来的 = 红,并把"差在哪一个文件"指出来。
{
  const stale = staleness();
  if (stale.length === 0) {
    const detail = ARTIFACTS.map((s) => {
      const am = fs.statSync(path.join(ROOT, s.file)).mtimeMs;
      const src = newestOf(inputsOf(s.inputs));
      return `${s.name} 比最新输入(${rel(src.file)})晚 ${Math.round((am - src.mtime) / 1000)} 秒`;
    }).join(" · ");
    record("产物新鲜度", "PASS", detail);
  } else {
    record(
      "产物新鲜度",
      "FAIL",
      `要交付的目录比它的构建输入旧:${stale.map((s) => `${s.name}(缺 ${s.source} 之后的改动)`).join("、")}` +
        ` —— 下一项会重新构建;构建完请复跑本闸门,交付的那一份才对应得上现在这份源码。`,
    );
  }
}

// ---------- 7. 构建 ----------
{
  const r = run("npm run build", 600_000);
  const built = fs.existsSync(path.join(ROOT, "dist", "index.html")) && fs.existsSync(path.join(ROOT, "dist-server", "index.js"));
  record("构建", r.ok && built ? "PASS" : "FAIL", r.ok && built ? "dist/ 与 dist-server/ 均已产出" : tail(r.out, 4));
}

// ---------- 8. 构建之后再来一次同样的判据 ----------
//
// 这一条管的是"构建声称成功、产物却根本没被重写"那种形状(tsc 增量缓存、vite 静默跳过、
// 输出目录指错)。上一条红是因为旧的没重建,这一条红是因为重建了却没比过源码 —— 两个方向都要有人守。
{
  const stale = staleness();
  record(
    "产物已刷新",
    stale.length === 0 ? "PASS" : "FAIL",
    stale.length === 0
      ? `两份产物都晚于各自的最新输入 —— 构建确实重写了它们`
      : `构建声称成功,但产物仍然落后于输入:${stale.map((s) => `${s.name} < ${s.source}`).join("、")}`,
  );
}

// ---------- 9. 交付物实跑:真起 dist-server、真发 HTTP ----------
{
  const problems: string[] = [];
  let checks = 0;
  const expect = (cond: boolean, label: string) => {
    checks += 1;
    if (!cond) problems.push(label);
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trendscope-verify-"));
  const REAL_DATA = path.resolve(ROOT, "data");
  let booted: Booted | null = null;
  let tokened: Booted | null = null;

  try {
    if (!fs.existsSync(path.join(ROOT, "dist-server", "index.js")) || !fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
      throw new Error("dist-server/ 或 dist/ 不存在 —— 先 npm run build");
    }
    const dbFile = path.join(tmp, "verify.db");
    // 隔离判据:落点必须在临时目录里,且绝不能落在 <ROOT>/data 下(那是使用者的真实库)。
    expect(!path.resolve(dbFile).startsWith(REAL_DATA + path.sep), "隔离判据:库文件落到了 data/ 里");

    const port = await freePort();
    booted = await bootBuilt(port, dbFile, "");
    const log = booted.out();

    // (a) 绑定地址:日志里报的是从 socket 回读的那一个,不是写死的 localhost
    expect(log.includes(`http://127.0.0.1:${port}`), `启动日志没报出实际绑定地址 http://127.0.0.1:${port}`);
    // (b) 隔离:子进程自报的数据文件必须在临时目录里
    const selfReported = (log.match(/数据文件[:：]\s*(\S+)/) ?? [])[1] ?? "";
    expect(selfReported.startsWith(path.resolve(tmp)), `子进程自报的库文件不在临时目录里:${selfReported || "(没读到)"}`);

    // (c) 只绑回环:同一个端口的另一个回环地址连不上(绑 0.0.0.0 时这里会连通)
    const offLoop = await hit(port, { connectHost: "127.0.0.2" });
    expect(offLoop.status === 0, `127.0.0.2:${port} 竟然拿到了 ${offLoop.status} —— 说明不是只绑回环`);

    // (d) 本机回环的合法请求仍然工作
    const health = await hit(port, { path: "/api/health" });
    expect(health.status === 200 && health.json?.ok === true, `合法本机 GET /api/health → ${health.status}`);

    // (e) 契约四端点的形状(personal-agent-hub《AGENT_API_STANDARD.md》v1)
    const manifest = await hit(port, { path: "/api/agent/manifest" });
    expect(
      manifest.status === 200 &&
        manifest.json?.ok === true &&
        manifest.json?.data?.project === "trendscope" &&
        manifest.json?.data?.base_url === `http://127.0.0.1:${port}` &&
        Array.isArray(manifest.json?.data?.tools),
      `GET /api/agent/manifest 形状不符(${manifest.status} ${String(manifest.text).slice(0, 80)})`,
    );
    const tools = await hit(port, { path: "/api/agent/tools" });
    const toolRows = tools.json?.data;
    expect(
      tools.status === 200 &&
        Array.isArray(toolRows) &&
        toolRows.length > 0 &&
        toolRows.every(
          (t: any) =>
            typeof t?.name === "string" &&
            typeof t?.description === "string" &&
            t?.input_schema &&
            typeof t?.risk === "string",
        ),
      `GET /api/agent/tools 形状不符(${tools.status})`,
    );
    const call = await hit(port, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "trendscope.overview", input: {} }),
    });
    expect(
      call.status === 200 &&
        call.json?.ok === true &&
        call.json?.tool === "trendscope.overview" &&
        typeof call.json?.ms === "number" &&
        typeof call.json?.risk === "string" &&
        call.json?.data &&
        typeof call.json?.data === "object",
      `POST /api/agent/tool 成功形状不符(${call.status} ${String(call.text).slice(0, 80)})`,
    );
    const badCall = await hit(port, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "trendscope.does_not_exist", input: {} }),
    });
    expect(
      badCall.status === 400 &&
        badCall.json?.ok === false &&
        badCall.json?.error?.code === "unknown_tool" &&
        Array.isArray(badCall.json?.error?.available),
      `POST /api/agent/tool 失败形状不符(${badCall.status})`,
    );
    expect(
      health.json?.data &&
        typeof health.json?.data?.agent_api === "number" &&
        typeof health.json?.data?.uptime_ms === "number" &&
        typeof health.json?.data?.version === "string" &&
        typeof health.json?.totalContent === "number",
      "GET /api/health 缺契约信封或界面在读的扁平字段",
    );

    // (f) 闸门端到端:伪造 Host / 跨站 Origin / rebinding 三种形状都要被拒,而且是 JSON
    const forged = await hit(port, { hostHeader: "evil.example.com" });
    expect(
      forged.status === 403 && forged.contentType.includes("application/json") && forged.json?.error?.code === "forbidden_host",
      `伪造 Host 没有被拒(${forged.status} ${forged.contentType})`,
    );
    const evilOrigin = await hit(port, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "trendscope.overview", input: {} }),
    });
    expect(
      evilOrigin.status === 403 && evilOrigin.json?.error?.code === "forbidden_origin",
      `跨站 Origin 的 POST 没有被拒(${evilOrigin.status})`,
    );
    const rebind = await hit(port, {
      method: "POST",
      path: "/api/agent/tool",
      hostHeader: `rebind.example.test:${port}`,
      headers: { Origin: `http://rebind.example.test:${port}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(
      rebind.status === 403 && rebind.json?.error?.code === "forbidden_host",
      `DNS rebinding 的形状(Host 与 Origin 同为外域)没被拒(${rebind.status})`,
    );
    // (g) 闸门先于 SPA 兜底:界面路径上的越界请求也是 JSON,不是一整个 index.html
    const spaForged = await hit(port, { path: "/topics", hostHeader: "evil.example.com" });
    expect(
      spaForged.status === 403 && spaForged.contentType.includes("application/json"),
      `SPA 路径上的伪造 Host 没有回 JSON 403(${spaForged.status} ${spaForged.contentType})`,
    );
    const spaLocal = await hit(port, { path: "/" });
    expect(spaLocal.status === 200 && spaLocal.contentType.includes("text/html"), `本机访问首页不通(${spaLocal.status})`);

    // (h) 可选共享令牌:第二次起服务(另一份临时库),验证"设了就要带头"这条端到端成立
    const port2 = await freePort();
    const dbFile2 = path.join(tmp, "tokened.db");
    tokened = await bootBuilt(port2, dbFile2, "release-verify-token");
    const noToken = await hit(port2, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(
      noToken.status === 403 && noToken.json?.error?.code === "token_required",
      `设了令牌却没有令牌的 POST 没被拒(${noToken.status})`,
    );
    expect(noToken.text.includes("release-verify-token") === false, "错误体里泄露了令牌值");
    const withToken = await hit(port2, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { "Content-Type": "application/json", "x-agent-token": "release-verify-token" },
      body: JSON.stringify({ tool: "trendscope.overview", input: {} }),
    });
    expect(withToken.status === 200 && withToken.json?.ok === true, `带对令牌的 POST 没通过(${withToken.status})`);
    const getToken = await hit(port2, { path: "/api/health" });
    expect(getToken.status === 200, `设了令牌后本机 GET 也应放行(${getToken.status})`);

    // (i) 两份临时库都各自建起来了,且真实 data/ 没有被写过(目录里只有使用者原有的那三件)
    expect(fs.existsSync(dbFile) && fs.existsSync(dbFile2), "临时库没有产出 —— 起的服务读的不是隔离落点");
  } catch (e) {
    problems.push(`起不来或中途失败:${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // 先等子进程真退出,再删临时目录 —— 顺序反了 Windows 会 EPERM(文件还被握着)。
    const notGone = (await Promise.all([booted, tokened].map((b) => (b ? stopBooted(b) : null)))).filter(Boolean);
    const cleanup = removeTmp(tmp);
    for (const note of [...notGone, cleanup].filter(Boolean)) console.log(`  [提醒] ${note}`);
  }

  record(
    "交付物实跑",
    problems.length === 0 ? "PASS" : "FAIL",
    problems.length === 0
      ? `${checks} 条真 HTTP 断言全过:只绑回环(127.0.0.2 连不上)、契约四端点形状、伪造 Host/跨站 Origin/rebinding 三种越界都被拒成 JSON、令牌那道设了才查、库落在临时目录`
      : `${problems.length}/${checks} 条不过 —— ${problems.slice(0, 4).join(" ; ")}`,
  );
}

// ---------- 10. 测试 ----------
{
  const r = run("npm test", 1_800_000);
  const SUM = new RegExp("Tests\\s+(\\d+) passed(?: \\| (\\d+) failed)?\\s*\\((\\d+)\\)");
  const FILES = new RegExp("Test Files\\s+(\\d+) passed(?: \\| (\\d+) failed)?\\s*\\((\\d+)\\)");
  const out = plain(r.out);
  const m = out.match(SUM);
  const files = out.match(FILES);
  const detail = m
    ? `${m[1]} 通过 / 共 ${m[3]}${m[2] ? ` · ${m[2]} 失败` : ""}${files ? ` · ${files[3]} 个文件` : ""}`
    : `无法解析 vitest 汇总:${tail(out, 3)}`;
  record("测试", r.ok && m && !m[2] ? "PASS" : "FAIL", detail);
}

// ---------- 11. 体检 ----------
//
// 给体检一份**临时库**:`doctor` 的"数据目录可写"那一项会在库目录里落一个写探针再删掉,
// 而默认落点是 `data/` —— 这里是使用者 3.9 GB 的真实库,验收闸门不该拿它当试验田。
// 真实库本身的完整性由下一条(只读)负责,两件事都在,各自测各自的那一件。
{
  const doctorTmp = fs.mkdtempSync(path.join(os.tmpdir(), "trendscope-doctor-"));
  const r = run("npm run doctor", 180_000, { ...process.env, TRENDSCOPE_DB: path.join(doctorTmp, "doctor.db") });
  fs.rmSync(doctorTmp, { recursive: true, force: true });
  record("npm run doctor", r.ok ? "PASS" : "FAIL", r.ok ? `临时库隔离 —— ${tail(r.out, 1)}` : tail(r.out, 3));
}

// ---------- 12. 数据库健康(完整性 / 表 / 迁移记录) ----------
{
  const dbFile = process.env.TRENDSCOPE_DB?.trim() || path.join(ROOT, "data", "trendscope.db");
  if (!fs.existsSync(dbFile)) {
    record("数据库健康", "SKIP", `${rel(dbFile)} 尚不存在 —— 全新安装首次启动会自动建库并跑迁移`);
  } else {
    const sqlite = new Database(dbFile, { readonly: true });
    try {
      const integrity = String(sqlite.pragma("integrity_check", { simple: true }));
      const tables = (sqlite.prepare("select count(*) c from sqlite_master where type='table'").get() as { c: number }).c;
      const mig = (sqlite.prepare("select count(*) c from __drizzle_migrations").get() as { c: number }).c;
      const wal = String(sqlite.pragma("journal_mode", { simple: true }));
      record(
        "数据库健康",
        integrity === "ok" ? "PASS" : "FAIL",
        integrity === "ok"
          ? `integrity ok · ${tables} 张表 · ${mig} 条迁移记录 · journal=${wal} · ${path.basename(dbFile)}`
          : `integrity=${integrity}`,
      );
    } catch (e) {
      record("数据库健康", "FAIL", e instanceof Error ? e.message : String(e));
    } finally {
      sqlite.close();
    }
  }
}

// ---------- 14. 评估不回退 ----------
{
  const t = run("npm run eval:topics", 300_000);
  const grab = (label: string) => Number((t.out.match(new RegExp(label + ":\\s*([0-9.]+)%")) ?? [])[1]);
  const f1 = grab("Pairwise F1");
  const purity = grab("Purity");
  const noise = grab("Noise");
  const cohesion = grab("Average Cohesion");
  const ok = t.ok && f1 >= 99.95 && purity >= 99.95 && noise <= 14.35 && cohesion >= 63.15;
  record(
    "eval:topics",
    ok ? "PASS" : "FAIL",
    `F1=${f1}% 纯度=${purity}% 噪声=${noise}% 一致性=${cohesion}%(门槛 ≥100 / ≥100 / ≤14.3 / ≥63.2)`,
  );

  const o = run("npm run eval:opportunity", 300_000);
  const EXPECT = "A=71.1 > C=60.1 > F=52.7 > B=47.3 > E=40.2 > D=17.7";
  const RANK = new RegExp("(A=[0-9.]+ > C=[0-9.]+ > F=[0-9.]+ > B=[0-9.]+ > E=[0-9.]+ > D=[0-9.]+)");
  const rank = (o.out.match(RANK) ?? [])[1] ?? "";
  const sc = plain(o.out).match(/scored=(\d+)\/(\d+)/);
  const ok2 = o.ok && rank === EXPECT && sc !== null && sc[1] === sc[2];
  record(
    "eval:opportunity",
    ok2 ? "PASS" : "FAIL",
    ok2 ? `排序与基线一致(${EXPECT}),${sc?.[1]}/${sc?.[2]} 全部打分` : `实际排序「${rank || "未解析"}」 scored=${sc ? sc[1] + "/" + sc[2] : "未解析"}`,
  );

  const s = run("npm run eval:scoring", 300_000);
  const sOut = plain(s.out);
  const sFail = (sOut.match(/(^|\n)\s*FAIL(\s|$)/g) ?? []).length;
  const sSummary = sOut.match(/(PASS|全部|合计)[^\n]{0,60}/g)?.slice(-1)[0] ?? tail(s.out, 1);
  record("eval:scoring", s.ok && sFail === 0 ? "PASS" : "FAIL", s.ok ? `无 FAIL 行(${String(sSummary).slice(0, 70)})` : tail(s.out, 3));

  const st = run("npm run eval:studio", 300_000);
  const stLine = plain(st.out).match(/eval:studio —— (\d+) 项检查,失败 (\d+) 项/);
  record(
    "eval:studio",
    st.ok && stLine && stLine[2] === "0" ? "PASS" : "FAIL",
    stLine ? `${stLine[1]} 项护栏检查,失败 ${stLine[2]} 项(证据指纹 / DATA 标注 / 结构闸门 / 幻觉检出 / 确定性回退)` : tail(st.out, 3),
  );
}

// ---------- 15. 交付文档 ----------
{
  const need = ["README.md", "CHANGELOG.md", path.join("docs", "RELEASE_NOTES_1.0.md"), ".env.example", ".gitignore"];
  const miss = need.filter((n) => !fs.existsSync(path.join(ROOT, n)));
  record("交付文档", miss.length === 0 ? "PASS" : "FAIL", miss.length ? `缺少:${miss.join(", ")}` : need.join(" · "));
}

const failed = rows.filter((r) => r.level === "FAIL");
const skipped = rows.filter((r) => r.level === "SKIP");
console.log(`${NL}合计 ${rows.length} 项:${rows.length - failed.length - skipped.length} 通过 · ${skipped.length} 跳过 · ${failed.length} 失败`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name} —— ${f.detail}`);
  process.exit(1);
}
console.log("全部闸门通过 —— 交付说明见 docs/RELEASE_NOTES_1.0.md。");
