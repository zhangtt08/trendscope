/**
 * 自动分析报告端点契约 —— 断言"报告里的每个数字都来自既有计算",
 * 以及缺数据时必须显式标注而不是编造。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestDb, type DB } from "../../server/src/db/client";
import { contentItems } from "../../server/src/db/schema";
import { createApp } from "../../server/src/app";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";

let db: DB;
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
let server: Server;
let base = "";

beforeAll(async () => {
  const t = createTestDb();
  sqlite = t.sqlite;
  db = t.db;
  const runtime = new CollectionRuntime(db, { globalConcurrency: 1, perConnectorConcurrency: 1 });
  server = createApp(db, runtime, { dbFile: ":memory:" }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  sqlite.close();
});

describe("GET /api/reports/latest 与 POST /api/reports/generate", () => {
  it("空库也必须出报告,并明确写「数据不足」而不是编造话题", async () => {
    const r = await fetch(`${base}/api/reports/latest`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; sections: number; markdown: string; data: { platforms: unknown[] } };
    expect(j.ok).toBe(true);
    expect(j.sections).toBe(5); // 数据面 / 平台覆盖 / 排名 / 选题建议 / 能力与缺口
    expect(j.markdown).toContain("热点分析报告");
    expect(j.markdown).toContain("数据不足");
    // 空库不能出现任何"看起来像结论"的选题推荐
    expect(j.markdown).toContain("数据不足,先增加采集频次或扩大渠道");
    // 这一行曾经挂着「平台分布」的标签却列出 api/json/fixture —— 标签必须说清它列的是什么
    expect(j.markdown).toContain("入库方式");
    expect(j.markdown).not.toContain("平台分布");
    // 平台覆盖段必须存在,空库时如实说没有内容
    expect(j.markdown).toContain("二、平台覆盖");
    expect(j.data.platforms).toEqual([]);
  });

  it("报告正文不出现裸英文枚举码与 ISO 时间串(给用户读的文本)", async () => {
    // 必须**带数据**跑:空库时"最近采集"是"尚无",ISO 断言会空过(真踩过一次)。
    await db.insert(contentItems).values({
      platform: "zhihu",
      platformContentId: "report-iso-guard",
      contentType: "answer",
      title: "报告口径校验内容",
      url: "https://example.test/report-iso-guard",
      canonicalUrl: "https://example.test/report-iso-guard",
      sourceType: "api",
      dataQuality: "complete",
      views: 1234,
      publishedAt: "2026-09-29T01:02:03.000Z",
      collectedAt: "2026-09-29T01:05:06.000Z",
      createdAt: "2026-09-29T01:05:06.000Z",
      updatedAt: "2026-09-29T01:05:06.000Z",
    });
    const md = (await (await fetch(`${base}/api/reports/latest`)).json()).markdown as string;
    expect(md).toContain("接口采集"); // 确认这一段确实带着数据渲染,不是空表
    // 生命周期 / 置信度 / 档位一律中文
    expect(md).not.toMatch(/(emerging|rising|saturated|declining|evergreen)/);
    expect(md).not.toMatch(/\|\s*(high|medium|low)\s*\|/);
    // 时间一律「年-月-日 时:分」,不给 ISO
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  /** 生成时间是唯一允许每次调用都变的字段,把它剥掉后才能断言"正文完全由库状态决定"。 */
  const withoutTimestamp = (markdown: string) =>
    markdown.split("\n").filter((line) => !line.startsWith("生成时间:")).join("\n");

  const tableCounts = () =>
    Object.fromEntries(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => {
          const { name } = row as { name: string };
          return [name, (sqlite.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number }).c];
        }),
    );

  it("generate 与 latest 正文一致,且不写库(报告是纯派生)", async () => {
    const before = tableCounts();
    const a = (await (await fetch(`${base}/api/reports/latest`)).json()) as { markdown: string };
    const b = (await (await fetch(`${base}/api/reports/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).json()) as { markdown: string };

    expect(withoutTimestamp(b.markdown)).toBe(withoutTimestamp(a.markdown));
    expect(tableCounts()).toEqual(before);
  });
});
