/**
 * 进度存储的契约:界面上那句"第 3 / 15 条 · 已等待 42 秒"完全来自这里,
 * 所以数字算错 = 骗人。钉住四件:
 *  1. 百分比只按真实走完的条数算;
 *  2. 当前条与它的耗时只在有东西在跑时才有值;
 *  3. 越界下标不许污染任何一条;
 *  4. 抓取与深挖各占一个槽 —— 自动深挖启动时,不能把用户正在看的抓取进度顶掉
 *     (共用一个槽时真发生过:进度条显示"深挖 3/3 已完成",而抓取还在第 2 条)。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  beginJob,
  endJob,
  jobSnapshot,
  markFinished,
  markRunning,
  progressSnapshot,
  resetJobs,
} from "../../server/src/services/hotProgress";

describe("hotProgress", () => {
  beforeEach(() => resetJobs());

  it("没有任务时两类进度都是空", () => {
    const s = progressSnapshot();
    expect(s.capture).toBeNull();
    expect(s.cascade).toBeNull();
  });

  it("beginJob 之后全部是排队中,百分比 0", () => {
    beginJob("capture", ["知乎热榜", "B站热门"]);
    const s = jobSnapshot("capture")!;
    expect(s.total).toBe(2);
    expect(s.done).toBe(0);
    expect(s.percent).toBe(0);
    expect(s.position).toBe(0);
    expect(s.currentLabel).toBeNull();
    expect(s.items.map((i) => i.state)).toEqual(["pending", "pending"]);
  });

  it("markRunning 才产生「正在做第几条」与这一条的已耗时", () => {
    beginJob("capture", ["A", "B", "C"]);
    markRunning("capture", 1);
    const s = jobSnapshot("capture")!;
    expect(s.position).toBe(2);
    expect(s.currentLabel).toBe("B");
    expect(s.currentItemMs).toBeGreaterThanOrEqual(0);
    expect(s.items[1].startedAt).not.toBeNull();
    expect(s.done).toBe(0);
    expect(s.percent).toBe(0);
  });

  it("百分比 = 走完 / 总数;跳过与失败都算走完", () => {
    beginJob("capture", ["A", "B", "C", "D"]);
    markRunning("capture", 0);
    markFinished("capture", 0, "done", "入库 5 条");
    markFinished("capture", 1, "skipped", "缺少 WEIBO_COOKIE");
    markFinished("capture", 2, "failed", "HTTP 500");
    const s = jobSnapshot("capture")!;
    expect(s.done).toBe(3);
    expect(s.percent).toBe(75);
    expect(s.items[0].detail).toBe("入库 5 条");
    expect(s.items[2].state).toBe("failed");
    expect(s.finishedAt).toBeNull();
  });

  it("endJob 之后百分比到 100 且 finishedAt 有值", () => {
    beginJob("cascade", ["词一"]);
    markRunning("cascade", 0);
    markFinished("cascade", 0, "done", "入库 3 条");
    endJob("cascade");
    const s = jobSnapshot("cascade")!;
    expect(s.kind).toBe("cascade");
    expect(s.percent).toBe(100);
    expect(s.finishedAt).not.toBeNull();
    expect(s.currentLabel).toBeNull();
  });

  it("两类任务互不顶替:深挖跑完不影响正在跑的抓取进度", () => {
    beginJob("capture", ["A", "B", "C"]);
    markRunning("capture", 1);
    beginJob("cascade", ["词一", "词二"]);
    markRunning("cascade", 0);
    markFinished("cascade", 0, "done", "入库 2 条");
    markFinished("cascade", 1, "done", "入库 1 条");
    endJob("cascade");

    const both = progressSnapshot();
    expect(both.cascade?.percent).toBe(100);
    expect(both.cascade?.finishedAt).not.toBeNull();
    // 抓取那边仍然停在原地:槽位是分开的
    expect(both.capture?.position).toBe(2);
    expect(both.capture?.currentLabel).toBe("B");
    expect(both.capture?.percent).toBe(0);
    expect(both.capture?.finishedAt).toBeNull();
  });

  it("越界下标不许改动任何东西", () => {
    beginJob("capture", ["A"]);
    markRunning("capture", 5);
    markFinished("capture", -1, "done");
    markFinished("capture", 9, "failed");
    const s = jobSnapshot("capture")!;
    expect(s.items[0].state).toBe("pending");
    expect(s.done).toBe(0);
  });
});
