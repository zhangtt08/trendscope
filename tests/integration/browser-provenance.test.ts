/**
 * 浏览器采集的**来源标记**回归测试(走真实 runtime + 真实入库路径,只是浏览器是假的)。
 *
 * 为什么要单独钉这一条:连接器声明 sourceType="playwright",但 runtime 里
 * adapterFor() 的 default 分支把它落到 JSON 适配器上,而适配器自己的 getSourceType()
 * 返回 "json" —— 于是浏览器采回来的行在界面里显示「接口采集」。
 * 真机跑抖音热榜时才发现的(10 行全是 json)。行的结构复用 JSON 管线是对的,
 * 但"这条数据怎么来的"必须如实。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import { contentItems } from "../../server/src/db/schema";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";
import { createTask } from "../../server/src/services/collection/service";
import { registerConnector } from "../../server/src/connectors/registry";
import { BrowserPageConnector, type BrowserLike } from "../../server/src/connectors/browserPage";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeBrowser(): BrowserLike {
  const el = (value: string) => ({
    async innerText() {
      return value;
    },
    async getAttribute() {
      return value;
    },
  });
  const page = {
    async goto() {},
    url: () => "https://example.test/hot",
    async waitForSelector() {
      return {};
    },
    async waitForTimeout() {},
    async $$(sel: string) {
      void sel;
      return [
        {
          async $(childSel: string) {
            if (childSel === "title") return el("安洗莹卫冕亚运会羽毛球女单冠军");
            if (childSel === "link") return el("/hot/2673243");
            return null;
          },
          async innerText() {
            return "";
          },
          async getAttribute() {
            return null;
          },
        },
      ];
    },
    locator() {
      return { first: () => ({ async isVisible() { return false; } }) };
    },
  };
  return {
    pages: () => [page as never],
    async newPage() {
      return page as never;
    },
    async close() {},
  };
}

let db: DB;
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
let runtime: CollectionRuntime;

beforeAll(async () => {
  const t = createTestDb();
  sqlite = t.sqlite;
  db = t.db;
  runtime = new CollectionRuntime(db, { globalConcurrency: 1, perConnectorConcurrency: 1 });
  // 用假浏览器顶替同名连接器:注册表是 Map.set,直接覆盖真实实例
  registerConnector(new BrowserPageConnector(async () => fakeBrowser()));
});

afterAll(() => {
  sqlite.close();
});

describe("浏览器采集的来源标记", () => {
  it("浏览器采回来的行,入库来源是 playwright 而不是 json", async () => {
    const task = await createTask(db, runtime, {
      name: "来源标记演练",
      connectorId: "browser-page",
      collectionType: "hotlist",
      config: {
        url: "https://example.test/hot",
        itemSelector: "li",
        fields: { title: "title", url: "link::href" },
        platform: "douyin",
      },
      schedule: { type: "manual" },
      enabled: true,
    });
    const started = await runtime.runTask(task.id, "manual");
    expect(started.ok).toBe(true);

    let rows: typeof contentItems.$inferSelect[] = [];
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      rows = await db.select().from(contentItems).where(eq(contentItems.platform, "douyin"));
      if (rows.length > 0) break;
    }
    expect(rows.length).toBeGreaterThan(0);
    // 这一条就是回归点:曾经落地成 "json"
    expect(rows[0].sourceType).toBe("playwright");
    expect(rows[0].title).toBe("安洗莹卫冕亚运会羽毛球女单冠军");
    expect(rows[0].url).toBe("https://example.test/hot/2673243");
  }, 30_000);
});
