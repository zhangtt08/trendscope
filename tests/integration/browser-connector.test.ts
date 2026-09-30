/**
 * 浏览器页面采集连接器的契约测试 —— 全部用注入的假浏览器,不启动真 Chrome、不碰公网。
 *
 * 钉住的都是真会出事的行为:
 *  1. 取不到条目必须显式报错(SCHEMA_DRIFT),不能静默返回空页让运行记录显示"成功";
 *  2. 被要求登录 / 出现风控提示时要说清楚"请你自己登录一次",而不是当成网络故障重试;
 *  3. 相对链接要补成绝对链接,否则用户在界面里点不开;
 *  4. 只允许 https、只取一屏(maxItems),不做翻页爬取。
 */
import { describe, it, expect } from "vitest";
import { BrowserPageConnector, type BrowserLike } from "../../server/src/connectors/browserPage";

function fakeElement(props: Record<string, { text?: string; attrs?: Record<string, string>; children?: unknown[] }>) {
  const make = (p: { text?: string; attrs?: Record<string, string>; children?: Record<string, unknown[]> }): any => ({
    async $(sel: string) {
      const child = (p.children?.[sel] ?? []) as any[];
      return child[0] ? make(child[0]) : null;
    },
    async innerText() {
      return p.text ?? "";
    },
    async getAttribute(name: string) {
      return p.attrs?.[name] ?? null;
    },
  });
  return Object.values(props).map(make);
}

function fakeBrowser(opts: {
  items: Record<string, unknown>[];
  finalUrl?: string;
  visibleBlocked?: string[];
  responses?: { url: string; body: unknown }[];
}): { browser: BrowserLike; closed: { value: boolean }; opened: { url?: string } } {
  const closed = { value: false };
  const opened: { url?: string } = {};
  const handlers: ((res: unknown) => void)[] = [];
  const page = {
    async goto(url: string) {
      opened.url = url;
      // 页面自己的请求:导航后逐条"回包",网络捕获模式应该像浏览器一样收到它们
      for (const r of opts.responses ?? []) {
        const res = {
          url: () => r.url,
          status: () => 200,
          headers: () => ({ "content-type": "application/json" }),
          text: async () => JSON.stringify(r.body),
        };
        for (const h of handlers) h(res);
      }
    },
    on(_event: string, handler: (res: unknown) => void) {
      handlers.push(handler);
    },
    url: () => opts.finalUrl ?? opened.url ?? "",
    async waitForSelector() {
      return {};
    },
    async waitForTimeout() {},
    async $$(sel: string) {
      void sel;
      return opts.items.map((raw) => {
        const i = raw as Record<string, string>;
        // 子选择器命中哪个字段,就返回那个字段的文本;取属性时同一个值当作 href 返回
        const child = (value: string) => ({
          async innerText() {
            return value;
          },
          async getAttribute() {
            return value;
          },
        });
        return {
          async $(childSel: string) {
            const v = i[childSel];
            return v === undefined ? null : child(v);
          },
          async innerText() {
            return i["."] ?? "";
          },
          async getAttribute(name: string) {
            return i[".::" + name] ?? i["."] ?? null;
          },
        };
      });
    },
    locator(sel: string) {
      return {
        first: () => ({
          async isVisible() {
            return (opts.visibleBlocked ?? []).includes(sel);
          },
        }),
      };
    },
  };
  const browser: BrowserLike = {
    pages: () => [page as unknown as BrowserLike["pages"] extends () => (infer P)[] ? P : never],
    async newPage() {
      return page as never;
    },
    async close() {
      closed.value = true;
    },
  };
  return { browser, closed, opened };
}

const ctxStub = () =>
  ({
    runId: 1,
    taskId: 1,
    signal: new AbortController().signal,
    logger: { event: () => {}, runId: 1 },
  }) as never;

const baseConfig = {
  url: "https://example.test/hot",
  itemSelector: "li",
  fields: { title: "title", url: "link::href" },
  platform: "douyin",
};

describe("浏览器页面采集连接器", () => {
  it("取到条目:相对链接补成绝对地址,并如实标记来源是浏览器采集", async () => {
    const { browser, opened } = fakeBrowser({
      items: [{ title: "安洗莹卫冕亚运会羽毛球女单冠军", link: "/hot/2673243/abc" }],
    });
    const c = new BrowserPageConnector(async () => browser);
    const r = await c.collectPage({ pageSize: 20 }, baseConfig, ctxStub());

    expect(opened.url).toBe("https://example.test/hot");
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      title: "安洗莹卫冕亚运会羽毛球女单冠军",
      url: "https://example.test/hot/2673243/abc",
    });
    expect(r.hasMore).toBe(false);
    expect(c.metadata.sourceType).toBe("playwright");
    expect(c.metadata.connectorType).toBe("browser");
  });

  it("一条都没取到时显式报错,不静默返回空页", async () => {
    const c = new BrowserPageConnector(async () => fakeBrowser({ items: [] }).browser);
    await expect(c.collectPage({ pageSize: 20 }, baseConfig, ctxStub())).rejects.toMatchObject({
      code: "SCHEMA_DRIFT",
    });
  });

  it("跳到登录页 → 说清楚要用户自己登录一次(不是网络错误)", async () => {
    const c = new BrowserPageConnector(
      async () => fakeBrowser({ items: [], finalUrl: "https://www.xiaohongshu.com/login?redirectPath=/explore" }).browser,
    );
    let caught: unknown = null;
    try {
      await c.collectPage(
        { pageSize: 20 },
        { ...baseConfig, loginUrlPrefixes: ["https://www.xiaohongshu.com/login"] },
        ctxStub(),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: "AUTH_ERROR" });
    expect((caught as Error).message).toMatch(/登录/);
  });

  it("页面出现风控提示 → 同样停下来如实说明,不尝试绕过", async () => {
    const c = new BrowserPageConnector(
      async () => fakeBrowser({ items: [], visibleBlocked: [".safe-check"] }).browser,
    );
    await expect(
      c.collectPage({ pageSize: 20 }, { ...baseConfig, blockedSelectors: [".safe-check"] }, ctxStub()),
    ).rejects.toMatchObject({ code: "AUTH_ERROR" });
  });

  it("maxItems 有上限:一屏取到再多也只取配置的那几条", async () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ title: `话题 ${i}`, link: `/hot/${i}` }));
    const c = new BrowserPageConnector(async () => fakeBrowser({ items }).browser);
    const r = await c.collectPage({ pageSize: 20 }, { ...baseConfig, maxItems: 5 }, ctxStub());
    expect(r.items).toHaveLength(5);
  });

  it("配置校验:只收 https、不收未知键、字段选择器不能为空", () => {
    const c = new BrowserPageConnector(async () => fakeBrowser({ items: [] }).browser);
    expect(c.validateConfig({ ...baseConfig, url: "http://example.test/hot" }).ok).toBe(false);
    expect(c.validateConfig({ ...baseConfig, 未知键: 1 }).ok).toBe(false);
    expect(c.validateConfig({ ...baseConfig, fields: { title: "  " } }).ok).toBe(false);
    expect(c.validateConfig(baseConfig).ok).toBe(true);
  });

  it("健康检查不假装可用,也不在检查里启动浏览器", async () => {
    let launched = 0;
    const c = new BrowserPageConnector(async () => {
      launched += 1;
      return fakeBrowser({ items: [] }).browser;
    });
    const h = await c.healthCheck({});
    expect(h.healthy).toBe(false);
    expect(launched).toBe(0);
    expect(h.detail).toContain("运行");
  });

  it("网络捕获:读页面自己收到的 JSON,嵌套字段、分享链接、秒级时间戳与固定值都按声明映射", async () => {
    const body = {
      aweme_list: [
        {
          aweme_id: "7686556973038439699",
          desc: "新生儿宝宝护理这10件事千万要注意",
          create_time: 1789702200,
          author: { nickname: "郭老师-母婴育儿百科", authentication_token: "MS4wLjAAAAAA-不该入库" },
          statistics: { digg_count: 4323, comment_count: 83, share_count: 12, collect_count: 278 },
          // 真机核对过:分享地址是响应里现成的,不是由 id 拼出来的
          share_info: { share_url: "https://www.iesdouyin.com/share/video/7686556973038439699/?region=CN" },
        },
        { aweme_id: "2", desc: "第二条", create_time: 1789702300, author: { nickname: "甲" }, statistics: { digg_count: 5 } },
      ],
    };
    const c = new BrowserPageConnector(
      async () =>
        fakeBrowser({
          items: [],
          responses: [{ url: "https://www.douyin.com/aweme/v1/web/channel/hotspot?x=1", body }],
        }).browser,
    );
    const r = await c.collectPage(
      { pageSize: 20 },
      {
        ...baseConfig,
        mode: "network",
        urlPattern: "channel/hotspot",
        pickPath: "aweme_list",
        fields: {
          platformContentId: "aweme_id",
          title: "desc",
          url: "share_info.share_url",
          authorName: "author.nickname",
          likes: "statistics.digg_count",
          favorites: "statistics.collect_count",
          publishedAt: "create_time#unix",
        },
        constants: { contentType: "video" },
      },
      ctxStub(),
    );
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      contentType: "video",
      title: "新生儿宝宝护理这10件事千万要注意",
      url: "https://www.iesdouyin.com/share/video/7686556973038439699/?region=CN",
      authorName: "郭老师-母婴育儿百科",
      likes: 4323,
      favorites: 278,
    });
    // 第二条响应里没有 share_info:宁可这个键整个缺席,也不要写成空串或 0
    expect(Object.keys(r.items[1] as Record<string, unknown>)).not.toContain("url");
    // 秒级时间戳要换算成 ISO,否则界面会显示 1970
    expect(new Date(String((r.items[0] as Record<string, unknown>).publishedAt)).getFullYear()).toBeGreaterThan(2020);
    // 白名单之外的键(比如响应里的 authentication_token)一个都不许带出去
    expect(JSON.stringify(r.items)).not.toContain("authentication_token");
  });

  it("网络捕获:没等到匹配响应时,报错说清看到了哪些地址与用的 pickPath", async () => {
    const c = new BrowserPageConnector(
      async () => fakeBrowser({ items: [], responses: [{ url: "https://x.test/other", body: { a: 1 } }] }).browser,
    );
    await expect(
      c.collectPage(
        { pageSize: 20 },
        { ...baseConfig, mode: "network", urlPattern: "hot/search/list", pickPath: "data.word_list", waitMs: 1500, settleMs: 0 },
        ctxStub(),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  });

  it("网络捕获:不写 pickPath 时能在这一条响应里自动找到对象数组", async () => {
    const c = new BrowserPageConnector(
      async () =>
        fakeBrowser({
          items: [],
          responses: [
            {
              url: "https://example.test/api/hot",
              body: { data: { word_list: [{ word: "话题甲" }, { word: "话题乙" }, { word: "话题丙" }] } },
            },
          ],
        }).browser,
    );
    const r = await c.collectPage(
      { pageSize: 20 },
      { ...baseConfig, mode: "network", urlPattern: "api/hot", fields: { title: "word" }, waitMs: 2000, settleMs: 0 },
      ctxStub(),
    );
    expect(r.items).toHaveLength(3);
    expect((r.items[0] as Record<string, unknown>).title).toBe("话题甲");
  });

  it("浏览器关不掉也不能把进程泄漏出去:运行结束后 close 被调用", async () => {
    const { browser, closed } = fakeBrowser({ items: [{ title: "A", link: "/hot/1" }] });
    const c = new BrowserPageConnector(async () => browser);
    await c.collectPage({ pageSize: 20 }, baseConfig, ctxStub());
    expect(closed.value).toBe(true);
  });
});
