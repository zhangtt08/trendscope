/**
 * 样式表自身的完整性。
 *
 * 起因(2026-09-29):`global.css` 里有一条中文注释漏了结束符,浏览器把它后面的一整段规则
 * 当注释吃掉了 —— `.section-head` / `.section-title` 等全部失效,页面排版静默退化,
 * 类型检查与构建都不会报错,只有肉眼看页面才发现。这类缺陷必须机器可判。
 */
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...cssFiles(full));
    else if (e.name.endsWith(".css")) out.push(full);
  }
  return out;
}

describe("样式表注释与括号闭合", () => {
  const files = cssFiles(path.resolve(root, "src"));

  it("至少扫到样式文件(路径变了要立刻知道,不要静默空跑)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    it(rel + ":注释成对闭合", () => {
      const css = readFileSync(f, "utf8");
      let open = 0;
      let line = 1;
      let openedAt = 0;
      for (let i = 0; i < css.length; i++) {
        if (css[i] === "\n") line++;
        if (css[i] === "/" && css[i + 1] === "*") {
          expect(open, rel + ":" + line + " 处注释在未闭合时又开了新注释").toBe(0);
          open = 1;
          openedAt = line;
          i++;
        } else if (css[i] === "*" && css[i + 1] === "/") {
          expect(open, rel + ":" + line + " 出现了没有对应开头的注释结束").toBe(1);
          open = 0;
          i++;
        }
      }
      expect(open, rel + " 末尾仍有未闭合的注释(从第 " + openedAt + " 行开始)").toBe(0);
    });

    it(rel + ":花括号成对", () => {
      // 去掉注释后再数,避免把注释里的 { 算进来
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
      expect([...code].filter((c) => c === "{").length).toBe([...code].filter((c) => c === "}").length);
    });
  }

  it("关键排版规则真的存在(被注释吃掉时这条会红)", () => {
    const css = readFileSync(path.resolve(root, "src/styles/global.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      " ",
    );
    for (const sel of [".section-head {", ".section-title {", ".content {", ".card {", "table.ts {"]) {
      expect(css, "缺少 " + sel).toContain(sel);
    }
  });
});
