/**
 * RSS / Atom 解析器单测 —— 全部用内联 XML 夹具,**不访问公网**
 * (真机跑通过的证据在 docs/TEST_STATUS.md:少数派源 10 条全部入库)。
 */
import { describe, it, expect } from "vitest";
import { parseFeed, RssConfigSchema, RSS_CONNECTOR_ID } from "../../server/src/connectors/rss";
import { ensureDefaultConnectors, getConnector } from "../../server/src/connectors/registry";

const RSS = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>派早报：荣耀发布 Magic9 系列 &amp; 一些别的事</title>
    <link>https://sspai.com/post/115134</link>
    <pubDate>Mon, 29 Sep 2026 08:09:05 +0800</pubDate>
    <author>少数派编辑部</author>
    <description><![CDATA[今天有 <b>7</b> 条更新]]></description>
  </item>
  <item><title>只有标题的条目</title></item>
  <item><description>既没标题也没链接,应被丢弃</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title type="html">基于 Termux 的开发服务器实践</title>
    <link href="https://sspai.com/prime/story/dev-env-on-android-with-termux"/>
    <updated>2026-09-28T09:33:03Z</updated>
    <author><name>neyham</name></author>
    <summary>摘要文本</summary>
  </entry>
</feed>`;

describe("RSS 2.0 解析", () => {
  it("取到标题/链接/作者/正文,并把发布时间归一为 UTC ISO", () => {
    const items = parseFeed(RSS, 20);
    expect(items[0].title).toBe("派早报：荣耀发布 Magic9 系列 & 一些别的事"); // &amp; 还原
    expect(items[0].url).toBe("https://sspai.com/post/115134");
    expect(items[0].authorName).toBe("少数派编辑部");
    expect(items[0].text).toContain("<b>7</b>"); // CDATA 原样保留
    expect(items[0].publishedAt).toBe("2026-09-29T00:09:05.000Z");
    expect(items[0].platformContentId).toBe("https://sspai.com/post/115134");
  });

  it("缺失字段留空而不是编造(无链接≠空字符串 0;无时间≠今天)", () => {
    const items = parseFeed(RSS, 20);
    expect(items[1].title).toBe("只有标题的条目");
    expect(items[1].url).toBeNull();
    expect(items[1].publishedAt).toBeNull();
    expect(items[1].authorName).toBeNull();
  });

  it("无题无链的条目直接丢弃,不生成假标题", () => {
    expect(parseFeed(RSS, 20).length).toBe(2);
  });

  it("limit 生效(单次 Run 硬上限的一部分)", () => {
    expect(parseFeed(RSS, 1).length).toBe(1);
  });
});

describe("Atom 解析", () => {
  it("支持 <link href=…/> 与嵌套 <author><name>", () => {
    const items = parseFeed(ATOM, 10);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe("https://sspai.com/prime/story/dev-env-on-android-with-termux");
    expect(items[0].authorName).toBe("neyham");
    expect(items[0].publishedAt).toBe("2026-09-28T09:33:03.000Z");
    expect(items[0].text).toBe("摘要文本");
  });
});

describe("配置与注册", () => {
  it("只接受 http/https 地址,pagesize/maxPages 有界", () => {
    expect(RssConfigSchema.safeParse({ url: "https://a.test/feed" }).success).toBe(true);
    expect(RssConfigSchema.safeParse({ url: "ftp://a.test/feed" }).success).toBe(false);
    expect(RssConfigSchema.safeParse({ url: "file:///C:/x.xml" }).success).toBe(false);
    expect(RssConfigSchema.safeParse({ url: "https://a.test/f", maxPages: 99 }).success).toBe(false);
    expect(RssConfigSchema.safeParse({ url: "https://a.test/f", pageSize: 5000 }).success).toBe(false);
    expect(RssConfigSchema.safeParse({ url: "https://a.test/f", 未知字段: 1 }).success).toBe(false);
    // 平台代码必须是已知枚举:写错会让整批条目在入库时逐行失败,而运行记录仍显示 completed
    // (反例不用 douban —— 它后来成了真实渠道平台,拿它当"未知代码"会自己失效)
    expect(RssConfigSchema.safeParse({ url: "https://a.test/f", platform: "not_a_platform" }).success).toBe(false);
    expect(RssConfigSchema.safeParse({ url: "https://a.test/f", platform: "baidu" }).success).toBe(true);
    expect(RssConfigSchema.safeParse({ url: "https://a.test/f", platform: "ithome" }).success).toBe(true);
    expect(RssConfigSchema.safeParse({ url: "https://a.test/f", platform: "douban" }).success).toBe(true);
    expect(RssConfigSchema.safeParse({ url: "https://a.test/f", platform: "tieba" }).success).toBe(true);
  });

  it("连接器已注册,且健康检查不假装可用", async () => {
    ensureDefaultConnectors();
    const c = getConnector(RSS_CONNECTOR_ID);
    expect(c).toBeDefined();
    expect(c?.metadata.isDemo).toBe(false);
    const h = await c?.healthCheck({});
    expect(h?.healthy).toBe(false); // 地址由任务提供,未验证前不能说"健康"
  });

  it("垃圾输入不崩:空串/非 XML 都返回空条目而不是抛错", () => {
    expect(parseFeed("", 10)).toEqual([]);
    expect(parseFeed("<html><body>not a feed</body></html>", 10)).toEqual([]);
  });
});
