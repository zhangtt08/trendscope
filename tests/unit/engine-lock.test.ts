/**
 * 引擎锁单元测试。
 *
 * 背景:四个分析端点原先各维护自己的 `running` Set,且只在"后台跑"分支检查,
 * 于是 `wait:true` 完全不拿锁、`/full-refresh` 直接调引擎函数绕过所有锁。
 * 用 HTTP 竞态很难稳定复现(单次 run 只要十几毫秒),所以直接锁语义。
 */
import { describe, it, expect, afterEach } from "vitest";
import { beginRun, endRun, busyEngines, conflictMessage } from "../../server/src/services/engineLock";

afterEach(() => {
  for (const e of busyEngines()) endRun([e]);
});

describe("engineLock", () => {
  it("同一引擎不可重复占用", () => {
    expect(beginRun(["content"])).toEqual({ ok: true });
    expect(beginRun(["content"])).toEqual({ ok: false, conflicts: ["content"] });
  });

  it("不同引擎互不阻塞", () => {
    expect(beginRun(["content"])).toEqual({ ok: true });
    expect(beginRun(["opportunity"])).toEqual({ ok: true });
    expect(busyEngines().sort()).toEqual(["content", "opportunity"]);
  });

  it("批量申请是原子的:任一冲突则全部不占用", () => {
    expect(beginRun(["trend"])).toEqual({ ok: true });
    const res = beginRun(["content", "trend", "opportunity"]);
    expect(res.ok).toBe(false);
    expect(res.conflicts).toEqual(["trend"]);
    // content / opportunity 不应被顺手占住
    expect(busyEngines()).toEqual(["trend"]);
  });

  it("释放后可再次占用,重复释放不报错", () => {
    beginRun(["intelligence"]);
    endRun(["intelligence"]);
    expect(beginRun(["intelligence"])).toEqual({ ok: true });
    endRun(["intelligence"]);
    endRun(["intelligence"]);
    expect(busyEngines()).toEqual([]);
  });

  it("full-refresh 一次占住四个引擎,任一在跑时整体被拒", () => {
    expect(beginRun(["content", "trend", "intelligence", "opportunity"])).toEqual({ ok: true });
    const again = beginRun(["content", "trend", "intelligence", "opportunity"]);
    expect(again.ok).toBe(false);
    expect(again.conflicts).toHaveLength(4);
    expect(conflictMessage(again.conflicts)).toContain("正在运行中");
  });
});
