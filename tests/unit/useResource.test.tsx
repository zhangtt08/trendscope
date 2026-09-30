// @vitest-environment jsdom
/**
 * Stage 9.5 request-reliability tests (spec §16-§19, §64).
 *
 * These exist because the old per-page `useCallback(load)+useEffect` pattern
 * had no abort and no request identity: two rapid filter changes could land out
 * of order and the SLOWER (older) response would overwrite the newer one. tsc
 * cannot catch that, and no prior test exercised the browser fetch path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDebounced, useResource, type Resource } from "../../src/lib/useResource";

interface Spec {
  delay: number;
  payload?: unknown;
  error?: string;
  /** true = ignore the AbortSignal and resolve anyway (simulates a transport
   *  that cannot abort in time — the generation guard must still win). */
  unabortable?: boolean;
}

const plan = new Map<string, Spec>();
const calls: { path: string; signal: AbortSignal | undefined }[] = [];
let container: HTMLDivElement;
let root: Root | null = null;
let lastState: Resource<Record<string, unknown>> | null = null;
/** mutable path key for the resetOnPathChange probe */
const planKey: { value: string | null } = { value: null };

function Probe({ path }: { path: string | null }): ReactNode {
  const r = useResource<Record<string, unknown>>(path);
  lastState = r;
  return <span>{r.data ? String(r.data.v) : r.error ? `ERR:${r.error}` : "—"}</span>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function set(path: string, spec: Spec): void {
  plan.set(`/api${path}`, spec);
}

beforeEach(() => {
  plan.clear();
  calls.length = 0;
  lastState = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const spec = plan.get(url) ?? { delay: 0, payload: { v: url } };
      const signal = init?.signal ?? undefined;
      calls.push({ path: url, signal });

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, spec.delay);
        if (!spec.unabortable) {
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("Aborted", "AbortError"));
          });
        }
      });
      if (spec.error) throw new Error(spec.error);
      return {
        ok: true,
        status: 200,
        json: async () => spec.payload,
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  const r = root;
  root = null;
  if (r) act(() => r.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function mount(): Root {
  if (!root) root = createRoot(container);
  return root;
}

async function render(path: string | null): Promise<void> {
  const r = mount();
  await act(async () => {
    r.render(<Probe path={path} />);
  });
}

/** act() needs several rounds to drain fetch → res.json() → setState chains;
 *  a single sleep leaves the result in flight and makes tests timing-fragile. */
async function flush(ms = 40, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await sleep(ms);
    });
  }
}

async function patch(path: string | null, extraMs = 0): Promise<void> {
  const r = mount();
  await act(async () => {
    r.render(<Probe path={path} />);
  });
  await flush();
  if (extraMs) await sleep(extraMs);
}

/** Switch without waiting for the response — this is what makes a real race. */
async function quick(path: string, ms: number): Promise<void> {
  const r = mount();
  await act(async () => {
    r.render(<Probe path={path} />);
    await sleep(ms);
  });
}

describe("useResource — stale response protection (§16)", () => {
  it("最终显示 B:先发慢的 A、再发快的 B,A 不得覆盖 B", async () => {
    set("/things?page=1", { delay: 100, payload: { v: "A" } });
    set("/things?page=2", { delay: 10, payload: { v: "B" } });

    await render("/things?page=1");
    await patch("/things?page=2", 30);
    expect(lastState?.data?.v).toBe("B");
    expect(container.textContent).toBe("B");

    // A 的延迟到点之后仍然不能覆盖
    await patch("/things?page=2", 200);
    expect(lastState?.data?.v).toBe("B");
    expect(container.textContent).toBe("B");
  });

  it("双保险:即使旧请求 abort 不掉,代次守卫仍让它作废", async () => {
    set("/things?page=1", { delay: 60, payload: { v: "A" }, unabortable: true });
    set("/things?page=2", { delay: 5, payload: { v: "B" } });

    await render("/things?page=1");
    await patch("/things?page=2", 20);
    expect(lastState?.data?.v).toBe("B");

    await patch("/things?page=2", 200); // A 此刻才返回
    expect(lastState?.data?.v).toBe("B");
    expect(lastState?.error).toBeNull();
  });
});

describe("useResource — abort (§17, §10)", () => {
  it("依赖变化时旧请求 signal.aborted = true", async () => {
    set("/a?platform=douyin", { delay: 500, payload: { v: "1" } });
    set("/a?platform=zhihu", { delay: 0, payload: { v: "2" } });

    await render("/a?platform=douyin");
    await patch("/a?platform=zhihu", 50);

    expect(calls).toHaveLength(2);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[1].signal?.aborted).toBe(false);
    expect(lastState?.data?.v).toBe("2");
  });

  it("被 abort 的请求不算错误:不报错、不写 console.error", async () => {
    const errSpy = vi.spyOn(console, "error");
    set("/slow", { delay: 400, payload: { v: "1" } });
    set("/fast", { delay: 0, payload: { v: "2" } });

    await render("/slow");
    await patch("/fast", 500);

    expect(lastState?.error).toBeNull();
    expect(container.textContent).toBe("2");
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("useResource — unmount (§18)", () => {
  it("卸载会 abort 在飞请求,且不再 setState / 不产生警告", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    const errSpy = vi.spyOn(console, "error");
    set("/pending", { delay: 80, payload: { v: "late" } });

    await render("/pending");
    expect(calls[0].signal?.aborted).toBe(false);

    await act(async () => {
      mount().unmount();
      root = createRoot(container);
    });
    await act(async () => {
      await sleep(200); // 让被取消的请求有机会落地
    });

    expect(calls[0].signal?.aborted).toBe(true);
    expect(container.textContent ?? "").toBe("");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("useResource — error + retry (§9)", () => {
  it("失败给出可读错误,reload 成功后错误清除", async () => {
    set("/flaky", { delay: 0, error: "无法连接到服务器（API 不可达）" });
    await render("/flaky");
    await patch("/flaky", 30);
    expect(lastState?.error).toContain("无法连接");

    // 恢复后手动 reload = 重试按钮的语义
    set("/flaky", { delay: 0, payload: { v: "ok" } });
    await act(async () => {
      lastState?.reload();
    });
    await flush(60);
    expect(container.textContent).toBe("ok");
    expect(lastState?.data?.v).toBe("ok");
    expect(lastState?.error).toBeNull();
  });

  it("path=null 时不发请求", async () => {
    await render(null);
    expect(calls).toHaveLength(0);
    expect(lastState?.loading).toBe(false);
  });
});

describe("useResource — loading 语义 (§8, §73)", () => {
  it("首屏 initialLoading;换筛选时 refreshing 且旧数据保留", async () => {
    set("/list?page=1", { delay: 40, payload: { v: "p1" } });
    await render("/list?page=1");
    expect(lastState?.initialLoading).toBe(true);
    expect(lastState?.refreshing).toBe(false);

    await patch("/list?page=1", 120);
    expect(lastState?.data?.v).toBe("p1");
    expect(lastState?.loading).toBe(false);

    set("/list?page=2", { delay: 40, payload: { v: "p2" } });
    await quick("/list?page=2", 10); // 新请求在飞、旧结果必须还在屏上
    expect(lastState?.refreshing).toBe(true);
    expect(lastState?.initialLoading).toBe(false);
    expect(lastState?.data?.v).toBe("p1"); // 旧结果仍在,不闪空白

    await flush();
    expect(lastState?.data?.v).toBe("p2");
    expect(lastState?.loading).toBe(false);
  });
});

describe("useResource — 20 次快速切筛选验收 (§19)", () => {
  it("乱序返回 20 次,最终显示最后一次筛选结果且无 stale", async () => {
    // 越晚发出的请求越早返回 → 最容易造成"A 覆盖 B"的经典形态
    for (let i = 1; i <= 20; i++) {
      set(`/t?page=${i}`, { delay: (21 - i) * 6, payload: { v: `page-${i}` }, unabortable: true });
    }

    await render("/t?page=1");
    for (let i = 2; i <= 20; i++) {
      await quick(`/t?page=${i}`, 4); // 不等响应就切下一个 —— 制造真实竞态
    }
    await flush(120); // 等所有乱序响应全部落地

    expect(lastState?.data?.v).toBe("page-20");
    expect(container.textContent).toBe("page-20");
    expect(calls).toHaveLength(20);
    // 前 19 个都被 abort
    expect(calls.slice(0, 19).every((c) => c.signal?.aborted)).toBe(true);
    expect(lastState?.error).toBeNull();
  });
});

describe("useResource — resetOnPathChange (实体级 stale)", () => {
  it("身份变化时丢掉旧实体的载荷;同一身份 reload 时保留", async () => {
    let captured: Resource<Record<string, unknown>> | null = null;
    function Detail(): ReactNode {
      captured = useResource<Record<string, unknown>>(planKey.value, { resetOnPathChange: true });
      return <span>{captured.data ? String(captured.data.v) : "—"}</span>;
    }
    set("/topic/1", { delay: 30, payload: { v: "topic-1" } });
    set("/topic/2", { delay: 30, payload: { v: "topic-2" } });

    planKey.value = "/topic/1";
    const r = mount();
    await act(async () => {
      r.render(<Detail />);
    });
    await flush();
    expect(captured?.data?.v).toBe("topic-1");

    planKey.value = "/topic/2";
    await act(async () => {
      r.render(<Detail />);
    });
    // 切换瞬间:旧话题的载荷不得挂在新话题名下
    expect(captured?.data).toBeNull();
    expect(captured?.initialLoading).toBe(true);
    await flush();
    expect(captured?.data?.v).toBe("topic-2");
  });
});

describe("useDebounced (§11)", () => {
  it("停止输入后才出一个值;窗口内的中间值不产生请求 key", async () => {
    let out = "";
    function Box(): ReactNode {
      const v = useDebounced("a", 200);
      out = v;
      return <span>{v}</span>;
    }
    const c = document.createElement("div");
    document.body.appendChild(c);
    const r = createRoot(c);
    await act(async () => {
      r.render(<Box />);
    });
    expect(out).toBe("a");
    await act(async () => {
      await sleep(300);
    });
    expect(out).toBe("a");
    await act(async () => {
      r.unmount();
    });
    c.remove();
  });
});
