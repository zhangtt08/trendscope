/**
 * npm run check:responsive —— 真实浏览器里的窄屏溢出检查。
 *
 * 为什么要有这一项:CSS 排版缺陷(注释没闭合、flex 子项没设 min-width:0、表格没套
 * .table-wrap)在类型检查、构建和单元测试里都看不出来,只有把页面真的渲染出来量一次
 * 才知道。这一脚本用本机已装的 Chrome / Edge 的 headless 模式做这件事,不引新依赖。
 *
 * 原理:在同源页面里放一个固定宽度的 iframe 装应用 —— iframe 内的媒体查询按
 * iframe 自己的宽度生效,于是能真实模拟 411 / 768 / 1024 视口;再把溢出元素报出来。
 *
 * 用法:npm run check:responsive [--port 5184]
 *   需要应用已在跑(它是只读检查,不写库)。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PORT = (() => {
  const i = process.argv.indexOf("--port");
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : "5184";
})();
const BASE = `http://127.0.0.1:${PORT}`;
/**
 * 路由直接从侧栏导航里取,不再手抄一份清单。
 * 手抄的那份里写了 `/content` —— 它需要 :id,单独访问会被 `<Route path="*">` 重定向回
 * /dashboard,于是这项检查连着两轮把"9 个页面"测成了 8 个,内容浏览器/重复治理从未被量过。
 */
const NAV_SRC = readFileSync(path.join(ROOT, "src/App.tsx"), "utf8");
const ROUTES = [...new Set([...NAV_SRC.matchAll(/\{\s*to:\s*"([^"]*)"/g)].map((m) => m[1]))].filter((r) => r.startsWith("/"));
const WIDTHS = [411, 768, 1024];

// 与浏览器采集同一口径:用本机已装的 Chromium 系浏览器,不下载依赖。
// 只认 Chrome 的话,只有 Edge 的机器上这项检查会直接退出 —— 而它不在 14 项闸门里,没人会发觉。
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));

if (!CHROME) {
  console.error("找不到 Chrome / Edge —— 这项检查需要本机浏览器,不下载依赖。");
  process.exitCode = 1;
} else if (ROUTES.length < 10) {
  // 清单是从 App.tsx 的导航数组取的:取不到就意味着导航写法变了,一项都没测 —— 必须报错而不是"通过 0 项"
  console.error(`从 src/App.tsx 只解析出 ${ROUTES.length} 条路由(应当覆盖侧栏全部入口)—— 解析规则失效,拒绝以"通过"收场。`);
  process.exitCode = 1;
} else if (!existsSync(path.join(ROOT, "dist/index.html"))) {
  console.error("dist/ 还没构建:先 npm run build");
  process.exitCode = 1;
} else {
  mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  const probeSrc = path.join(ROOT, "scripts/responsive-probe.html");
  const probeDst = path.join(ROOT, "dist/probe.html");
  const template = readFileSync(probeSrc, "utf8");
  writeFileSync(probeDst, template, "utf8");

  const failures: string[] = [];
  try {
    for (const width of WIDTHS) {
      for (const route of ROUTES) {
        const url = `${BASE}/probe.html?w=${width}#${route}`;
        const r = spawnSync(
          CHROME,
          ["--headless=new", "--disable-gpu", "--window-size=1200,1000", `--virtual-time-budget=14000`, "--dump-dom", url],
          { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
        );
        const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(r.stdout ?? "");
        if (!m) {
          failures.push(`${width}px ${route} → 探针没有返回结果(页面没加载?)`);
          continue;
        }
        const text = m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        const docSW = Number(/docScrollWidth=(\d+)/.exec(text)?.[1] ?? "-1");
        const inner = Number(/innerWidth=(\d+)/.exec(text)?.[1] ?? "-1");
        const landed = /finalHash=(\S*)/.exec(text)?.[1] ?? "";
        const heading = /heading=(.*)/.exec(text)?.[1]?.trim() ?? "";
        const scrollContainers = /(overflowing=\d+)/.exec(text)?.[1] ?? "";
        if (docSW < 0 || inner < 0) {
          failures.push(`${width}px ${route} → 读不到视口/宽度`);
        } else if (!landed.startsWith(route)) {
          // 路径写错 / 已被重定向:量到的是别的页面,这一项等于没测
          failures.push(`${width}px ${route} → 实际停在 ${landed || "?"}(「${heading}」),这一页没被量到`);
        } else if (docSW > inner + 1) {
          failures.push(`${width}px ${route} → 页面横向溢出:scrollWidth ${docSW} > 视口 ${inner}`);
        } else {
          console.log(
            `  ${String(width).padStart(4)}px  ${route.padEnd(14)} ok  ${heading.padEnd(12)} scrollWidth=${docSW}  ${scrollContainers}`,
          );
        }
      }
    }
  } finally {
    rmSync(probeDst, { force: true });
  }

  if (failures.length) {
    console.error(`\n窄屏检查失败 ${failures.length} 项:`);
    for (const f of failures) console.error("  ✗ " + f);
    process.exitCode = 1;
  } else {
    console.log(`\n窄屏检查通过:${WIDTHS.length} 个宽度 × ${ROUTES.length} 条路由,无页面级横向溢出。`);
    process.exitCode = 0;
  }
}
