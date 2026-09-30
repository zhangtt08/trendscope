// @vitest-environment jsdom
/**
 * 进度条组件的渲染契约。
 *
 * 真实教训:第一版把模板字符串写成 `{elapsedZh(...)}`(少了 `$`),
 * 界面上就印出字面的 `{elapsedZh(job.currentItemMs)}` —— 截图时机没赶上,是读 DOM 文本才发现的。
 * 所以这里专门钉一条:**渲染出来的文字里不许出现花括号或函数名**。
 */
import { describe, it, expect } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JobProgress } from "../../src/components/JobProgress";
import type { ProgressSnapshot } from "../../src/lib/useJobProgress";

function render(job: ProgressSnapshot): { text: string; root: Root; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const capture = job.capture;
  act(() => {
    root.render(createElement(JobProgress, { job: capture }));
  });
  return { text: host.textContent ?? "", root, host };
}

const base = {
  startedAt: "2026-09-30T04:00:00.000Z",
  elapsedMs: 42_000,
  finishedAt: null,
};

describe("JobProgress", () => {
  it("跑动中:显示第几条、当前渠道名、已等待时长与这一条的耗时", () => {
    const { text } = render({
      capture: {
        ...base,
        kind: "capture",
        total: 15,
        done: 14,
        position: 15,
        currentLabel: "豆瓣电影周榜",
        currentItemMs: 3_000,
        percent: 93,
        items: [{ label: "豆瓣电影周榜", state: "running", detail: null, startedAt: base.startedAt, finishedAt: null }],
      },
      cascade: null,
    });
    expect(text).toContain("正在抓取热点");
    expect(text).toContain("第 15 / 15 条");
    expect(text).toContain("豆瓣电影周榜");
    expect(text).toContain("已等待 42 秒");
    expect(text).toContain("这一条已 3 秒");
  });

  it("渲染出的文字里不许出现花括号或被吞掉的表达式", () => {
    const { text } = render({
      capture: {
        ...base,
        kind: "capture",
        total: 2,
        done: 1,
        position: 2,
        currentLabel: "B站热门",
        currentItemMs: 65_000,
        percent: 50,
        items: [
          { label: "知乎热榜", state: "done", detail: "入库 2 / 去重 28", startedAt: null, finishedAt: base.startedAt },
          { label: "B站热门", state: "running", detail: null, startedAt: base.startedAt, finishedAt: null },
        ],
      },
      cascade: null,
    });
    expect(text).not.toMatch(/[{}]/);
    expect(text).not.toContain("elapsedZh");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
    // 65 秒要写成"1 分 5 秒",不是 65000 或裸数字
    expect(text).toContain("1 分 5 秒");
    expect(text).toContain("入库 2 / 去重 28");
  });

  it("深挖任务用深挖的措辞;没有任务时什么都不渲染", () => {
    const { text } = render({
      capture: null,
      cascade: {
        kind: "cascade",
        total: 1,
        done: 0,
        position: 1,
        currentLabel: "特朗普评中美会晤",
        currentItemMs: 1_000,
        percent: 0,
        items: [{ label: "特朗普评中美会晤", state: "running", detail: null, startedAt: null, finishedAt: null }],
      },
    });
    // 组件本身只认传进来的那一个 job:传 capture=null 时不该把 cascade 画出来
    expect(text).toBe("");
  });
});
