/**
 * 一键热点捕获:把"已授权的渠道"聚合成一次点击(或一次定时),采完自动补分析。
 *
 * 渠道都是**预置**的,不是让用户手填 URL:
 *  - 知乎热榜:官方开放接口(需 ZHIHU_ACCESS_SECRET)
 *  - B站热门 / HN 首页:公开、无需凭证的 JSON 接口(走通用 HTTP 连接器)
 *  - 微博热搜:需要使用者自己的登录态(WEIBO_COOKIE);没有就如实标不可用
 * 抖音 / 小红书不预置:它们的接口要求伪造平台签名,属于风控绕过。
 */
import express, { Router } from "express";
import { z } from "zod";
import type { DB } from "../db/client";
import type { CollectionRuntime } from "../services/collection/runtime";
import { createTask, getRun, listTasks, updateTask } from "../services/collection/service";
import { autoAnalysisSnapshot, startAutoAnalysis } from "../analysis/autoAnalysis";
import { cascadeSnapshot, runHotCascade } from "../collection/hotCascade";
import { closeLoginWindow, loginWindowState, openLoginWindow } from "../collection/browserLogin";
import { getConnector } from "../connectors/registry";
import { BROWSER_PAGE_CONNECTOR_ID } from "../connectors/browserPage";
import { beginJob, endJob, markFinished, markRunning, progressSnapshot } from "../services/hotProgress";
import { clientOrServerError } from "./errors";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 渠道默认自动采集间隔(分钟)。渠道表、/api/hot/channels 与 Agent 注册表共用这一份。 */
export const DEFAULT_HOT_CHANNEL_INTERVAL_MIN = 30;

/**
 * "为什么某个平台不提供"的如实说明。渠道表与 Agent 注册表共用这一份,
 * 免得两处各写一遍后对同一件事给出两种说法。
 */
export const REFUSED_CHANNELS: { label: string; reason: string }[] = [
  {
    label: "抖音 / 小红书 / 微博的官方私有接口",
    reason:
      "调用它们需要伪造平台签名或逆向风控参数(属于检测规避),本产品不做;" +
      "这些平台的公开热榜改由聚合源渠道获取,见上方渠道列表。",
  },
];

export interface ChannelPreset {
  key: string;
  label: string;
  connectorId: string;
  collectionType: "search" | "hotlist";
  config: Record<string, unknown>;
  needsEnv?: string;
  note: string;
  /**
   * 自动采集间隔(分钟)。渠道任务是点「一键抓热点」时由本接口建的,归应用所有:
   * 若停在 manual 档就再也不会自己跑,用户看到的正是"根本没有多平台数据"。
   * 周更类榜单给大间隔,30 分钟轮询它们只是白打接口。
   */
  intervalMinutes?: number;
  /**
   * 改名前的旧标签。任务名由标签拼出,直接改标签会把用户库里已有的那条任务变成孤儿
   * (还在定时跑,只是应用不再认识它)。列在这里就能原地改名,采集历史不断。
   */
  renamedFrom?: string[];
  /**
   * 只能按需跑的渠道(要开一个看得见的浏览器窗口)。
   * 这类渠道**不能**挂定时档:每 30 分钟弹一个窗口不是自动化,是骚扰。
   * 它停在手动档是设计意图,所以 D54 的"补回 interval"逻辑要跳过它。
   */
  onDemandOnly?: boolean;
}

/** 导出给契约测试:渠道表是静态配置,不碰网络。 */
export const CHANNELS: ChannelPreset[] = [
  {
    key: "zhihu-hot",
    label: "知乎热榜",
    connectorId: "zhihu-official",
    collectionType: "hotlist",
    config: { mode: "hotlist", limit: 30 },
    needsEnv: "ZHIHU_ACCESS_SECRET",
    note: "官方接口;单次 30 条,无指标(标题+链接)。",
  },
  {
    key: "bilibili-popular",
    label: "B站热门",
    connectorId: "generic-http",
    collectionType: "hotlist",
    config: {
      url: "https://api.bilibili.com/x/web-interface/popular",
      itemsPath: "data.list",
      platform: "bilibili",
      query: { ps: 20 },
      headers: { "User-Agent": "trendscope-local/1.0" },
      pagination: { kind: "page", pageParam: "pn", startPage: 1, hasMorePath: "data.no_more" },
      pageSize: 20,
      maxPages: 2,
      mapping: {
        platformContentId: "bvid",
        title: "title",
        text: "desc",
        url: "short_link",
        publishedAt: "pubdate",
        authorName: "owner.name",
        views: "stat.view",
        likes: "stat.like",
        comments: "stat.reply",
        shares: "stat.share",
        favorites: "stat.favorite",
      },
    },
    note: "公开接口,无需凭证;指标齐全(播放/点赞/评论/作者/发布日)。",
  },
  {
    key: "hn-front",
    label: "Hacker News 首页",
    connectorId: "generic-http",
    collectionType: "hotlist",
    config: {
      url: "https://hn.algolia.com/api/v1/search",
      itemsPath: "hits",
      platform: "other",
      query: { tags: "front_page", hitsPerPage: 20 },
      pagination: { kind: "page", pageParam: "page", startPage: 0 },
      pageSize: 20,
      maxPages: 2,
      mapping: {
        platformContentId: "objectID",
        title: "title",
        url: "url",
        publishedAt: "created_at",
        likes: "points",
        comments: "num_comments",
        authorName: "author",
      },
    },
    note: "公开文档接口,无需凭证。",
  },
  {
    key: "rss-sspai",
    label: "少数派 RSS",
    connectorId: "rss",
    collectionType: "hotlist",
    config: { url: "https://sspai.com/feed", platform: "other", maxPages: 1, pageSize: 20 },
    note: "公开订阅源,无需凭证;标题+链接+发布时间,无互动指标。",
  },
  {
    key: "douyin-hot",
    label: "抖音热榜(抖音官方)",
    renamedFrom: ["抖音热榜(聚合源)"],
    connectorId: "generic-http",
    collectionType: "hotlist",
    config: {
      url: "https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/",
      itemsPath: "word_list",
      platform: "douyin",
      pagination: { kind: "none" },
      pageSize: 50,
      maxPages: 1,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
      mapping: {
        platformContentId: "word",
        title: "word",
        views: "hot_value",
      },
    },
    note: "抖音自己的公开热榜接口,零凭证、无签名;50 条标题+热度值(接口本身不给链接与发布时间,不编造)。",
  },
  {
    key: "douyin-hot-videos",
    label: "抖音热门视频(浏览器)",
    connectorId: "browser-page",
    collectionType: "hotlist",
    config: {
      url: "https://www.douyin.com/hot",
      mode: "network",
      urlPattern: "channel/hotspot",
      pickPath: "aweme_list",
      fields: {
        platformContentId: "aweme_id",
        title: "desc",
        // 分享地址是响应里现成的 share_info.share_url(不是我们由 id 拼出来的),
        // 真机核对过它能打开对应视频;它带着抖音自己的分享参数(did/iid/share_sign),
        // 只存在本机库里,不出本机。
        url: "share_info.share_url",
        authorName: "author.nickname",
        likes: "statistics.digg_count",
        comments: "statistics.comment_count",
        shares: "statistics.share_count",
        favorites: "statistics.collect_count",
        publishedAt: "create_time#unix",
      },
      constants: { contentType: "video" },
      platform: "douyin",
      maxItems: 10,
      headless: false,
      settleMs: 6000,
      waitMs: 35000,
    },
    onDemandOnly: true,
    note:
      "读抖音热榜页面「自己请求回来」的那份 JSON(签名由页面自己的脚本完成,我们不伪造、不绕验证)," +
      "拿到的是真正的视频条目:作者、点赞/评论/分享/收藏、发布时间。会弹一个看得见的浏览器窗口,所以只能手动点。",
  },
  {
    key: "toutiao-hot",
    label: "今日头条热榜(聚合源)",
    connectorId: "generic-http",
    collectionType: "hotlist",
    config: {
      url: "https://60s.viki.moe/v2/toutiao",
      itemsPath: "data",
      platform: "toutiao",
      pagination: { kind: "none" },
      pageSize: 50,
      maxPages: 1,
      headers: { "User-Agent": "trendscope-personal/1.0" },
      mapping: {
        platformContentId: "link",
        title: "title",
        text: "detail",
        url: "link",
        views: "hot_value",
      },
    },
    note: "公开聚合接口,零凭证。",
  },
  {
    key: "zhihu-hot-agg",
    label: "知乎热榜(聚合源)",
    connectorId: "generic-http",
    collectionType: "hotlist",
    config: {
      url: "https://60s.viki.moe/v2/zhihu",
      itemsPath: "data",
      platform: "zhihu",
      pagination: { kind: "none" },
      pageSize: 50,
      maxPages: 1,
      headers: { "User-Agent": "trendscope-personal/1.0" },
      mapping: {
        platformContentId: "link",
        title: "title",
        text: "detail",
        url: "link",
        views: "hot_value",
        // 这两个字段源里一直有,以前被丢掉 → 这批内容"缺发布时间",
        // 趋势与生命周期只能靠采集时间推断。created_at 是毫秒时间戳。
        publishedAt: "created_at",
        comments: "comment_cnt",
      },
    },
    note: "备用渠道:官方接口配额用尽时可用;含提问创建时间与评论数,无作者。",
  },
  {
    key: "weibo-hot",
    label: "微博热搜",
    connectorId: "generic-http",
    collectionType: "hotlist",
    needsEnv: "WEIBO_COOKIE",
    config: {
      url: "https://weibo.com/ajax/side/hotSearch",
      itemsPath: "data.realtime",
      platform: "weibo",
      headers: {
        Cookie: "secretref:env:WEIBO_COOKIE",
        "User-Agent": "Mozilla/5.0",
        Referer: "https://weibo.com",
      },
      pagination: { kind: "none" },
      mapping: {
        platformContentId: "word",
        title: "word",
        text: "note",
        url: "word_scheme",
        views: "num",
      },
    },
    note: "需要你自己账号的登录态;只读、单页、低频。",
  },
  {
    // 以下四路走同一个公开聚合服务(60s-api,开源、有文档、零凭证),
    // 拿到的是各平台公开热榜的标题+热度+链接,不含任何需要登录态或签名的调用。
    key: "xiaohongshu-hot",
    label: "小红书热点(聚合源)",
    connectorId: "generic-http",
    collectionType: "hotlist",
    config: {
      url: "https://60s.viki.moe/v2/rednote",
      itemsPath: "data",
      platform: "xiaohongshu",
      pagination: { kind: "none" },
      pageSize: 50,
      maxPages: 1,
      headers: { "User-Agent": "trendscope-personal/1.0" },
      mapping: {
        platformContentId: "link",
        title: "title",
        url: "link",
        views: "score",
      },
    },
    note:
      "公开聚合接口,零凭证;小红书热榜标题+热度(如 947.5w)+搜索链接。" +
      "这是第三方服务,它自己失效时会返回 500,那一次运行会在采集中心显示失败(不是本机配置问题);第一方内容需登录,见下方登录按钮。",
  },
  {
    key: "baidu-hot",
    label: "百度热搜",
    connectorId: "generic-http",
    collectionType: "hotlist",
    config: {
      url: "https://60s.viki.moe/v2/baidu/realtime",
      itemsPath: "data",
      platform: "baidu",
      pagination: { kind: "none" },
      pageSize: 50,
      maxPages: 1,
      headers: { "User-Agent": "trendscope-personal/1.0" },
      mapping: {
        platformContentId: "url",
        title: "title",
        text: "desc",
        url: "url",
        views: "score",
      },
    },
    note: "公开聚合接口,零凭证;50 条,带摘要描述与热度值,适合做话题正文。",
  },
  {
    key: "weibo-hot-agg",
    label: "微博热搜(免登录聚合源)",
    connectorId: "generic-http",
    collectionType: "hotlist",
    config: {
      url: "https://60s.viki.moe/v2/weibo",
      itemsPath: "data",
      platform: "weibo",
      pagination: { kind: "none" },
      pageSize: 50,
      maxPages: 1,
      headers: { "User-Agent": "trendscope-personal/1.0" },
      mapping: {
        platformContentId: "link",
        title: "title",
        url: "link",
        views: "hot_value",
      },
    },
    note: "不需要 WEIBO_COOKIE 也能跑;字段比登录态渠道少(无 note 补充说明)。",
  },
  {
    key: "ithome-rank",
    label: "IT之家热榜",
    connectorId: "generic-http",
    collectionType: "hotlist",
    config: {
      url: "https://60s.viki.moe/v2/it-news/rank",
      itemsPath: "data",
      platform: "ithome",
      pagination: { kind: "none" },
      pageSize: 50,
      maxPages: 1,
      headers: { "User-Agent": "trendscope-personal/1.0" },
      mapping: {
        platformContentId: "link",
        title: "title",
        url: "link",
      },
    },
    note: "公开聚合接口,零凭证;科技类选题补充源,只有标题+链接。",
  },
  {
    key: "tieba-hot",
    label: "百度贴吧热榜",
    connectorId: "generic-http",
    collectionType: "hotlist",
    config: {
      url: "https://60s.viki.moe/v2/baidu/tieba",
      itemsPath: "data",
      platform: "tieba",
      pagination: { kind: "none" },
      pageSize: 30,
      maxPages: 1,
      headers: { "User-Agent": "trendscope-personal/1.0" },
      mapping: {
        platformContentId: "url",
        title: "title",
        text: "abstract",
        url: "url",
        views: "score",
      },
    },
    note: "公开聚合接口,零凭证;30 条,带摘要与热度值,社区讨论型选题源。",
  },
  {
    key: "douban-movie-weekly",
    label: "豆瓣电影周榜",
    connectorId: "generic-http",
    collectionType: "hotlist",
    config: {
      url: "https://60s.viki.moe/v2/douban/weekly/movie",
      itemsPath: "data",
      platform: "douban",
      pagination: { kind: "none" },
      pageSize: 10,
      maxPages: 1,
      headers: { "User-Agent": "trendscope-personal/1.0" },
      mapping: {
        platformContentId: "id",
        title: "title",
        text: "card_subtitle",
        url: "url",
        comments: "rating_count",
      },
    },
    intervalMinutes: 360,
    note: "公开聚合接口,零凭证;周榜,每 6 小时刷一次足够。评分人数当作评论量级指标。",
  },
  {
    key: "douban-tv-weekly",
    label: "豆瓣国产剧周榜",
    connectorId: "generic-http",
    collectionType: "hotlist",
    config: {
      url: "https://60s.viki.moe/v2/douban/weekly/tv_chinese",
      itemsPath: "data",
      platform: "douban",
      pagination: { kind: "none" },
      pageSize: 10,
      maxPages: 1,
      headers: { "User-Agent": "trendscope-personal/1.0" },
      mapping: {
        platformContentId: "id",
        title: "title",
        text: "card_subtitle",
        url: "url",
        comments: "rating_count",
      },
    },
    intervalMinutes: 360,
    note: "公开聚合接口,零凭证;周榜,每 6 小时刷一次足够。评分人数当作评论量级指标。",
  },
];

const CaptureSchema = z
  .object({ channels: z.array(z.string().min(1)).max(CHANNELS.length).optional(), analyze: z.boolean().default(true) })
  .strict();

export function channelSchedule(c: ChannelPreset): { type: "interval"; intervalMs: number } | { type: "manual" } {
  // 要开窗口的渠道刻意留在手动档:每 30 分钟弹一个浏览器窗口不是自动化,是骚扰。
  if (c.onDemandOnly) return { type: "manual" };
  const min = c.intervalMinutes ?? DEFAULT_HOT_CHANNEL_INTERVAL_MIN;
  return { type: "interval", intervalMs: min * 60_000 };
}

/**
 * 一键抓取的渠道选择,导出给测试钉住(纯函数,不碰网络、不碰库)。
 *
 * 没点名渠道 = 界面那个「抓取 N 个渠道的热点」按钮:这时 onDemandOnly 的渠道**必须排除**。
 * 它们会开一个看得见的浏览器窗口,混在批量里等于用户点一下就被弹窗打断;
 * 浏览器连接器又有 1 分钟最小间隔,连点两次必定有一条失败。想跑它就显式点名。
 */
export function pickCaptureChannels(requested?: string[]): ChannelPreset[] {
  if (requested?.length) return CHANNELS.filter((c) => requested.includes(c.key));
  return CHANNELS.filter((c) => !c.onDemandOnly && (!c.needsEnv || Boolean(process.env[c.needsEnv]?.trim())));
}

/** 稳定比较:配置从库里读出来是 JSON,键序不同不代表内容不同。 */
function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(norm).join(",")}]`;
    if (v && typeof v === "object") {
      return `{${Object.entries(v as Record<string, unknown>)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([k, val]) => `${k}:${norm(val)}`)
        .join(",")}}`;
    }
    return JSON.stringify(v) ?? "null";
  };
  return norm(a) === norm(b);
}

async function findOrCreateTask(db: DB, runtime: CollectionRuntime, c: ChannelPreset) {
  const name = `热点渠道:${c.label}`;
  const existing = await listTasks(db, runtime);
  const legacy = (c.renamedFrom ?? [])
    .map((old) => existing.find((t) => t.name === `热点渠道:${old}`))
    .find((t): t is NonNullable<typeof t> => Boolean(t));
  const found = existing.find((t) => t.name === name) ?? legacy;
  if (found) {
    // 渠道任务归应用所有(预设升级要能落到已存在的任务上),但只碰自己该管的三件事:
    // 改名(否则旧任务变孤儿还在定时跑)、config(且只在连接器还是同一个时 —— 换过连接器的
    // 任务是用户或测试的有意安排,不该被预设覆盖)、以及缺失的定时档。
    const patch: Record<string, unknown> = {};
    if (found.name !== name) patch.name = name;
    if (found.connectorId === c.connectorId && !sameJson(found.config, c.config)) patch.config = c.config;
    const want = channelSchedule(c);
    const currentType = (found.schedule as { type?: string } | null | undefined)?.type;
    if (currentType !== want.type) {
      patch.schedule = want;
      patch.enabled = true;
    }
    if (Object.keys(patch).length > 0) await updateTask(db, runtime, found.id, patch);
    const patched = await runtime.runTask(found.id, "manual");
    return { taskId: found.id, run: patched };
  }
  const task = await createTask(db, runtime, {
    name,
    connectorId: c.connectorId,
    collectionType: c.collectionType,
    config: c.config,
    schedule: channelSchedule(c),
    enabled: true,
  });
  const run = await runtime.runTask(task.id, "manual");
  return { taskId: task.id, run };
}

export function createHotRouter(db: DB, runtime: CollectionRuntime): Router {
  const router = Router();
  // 必须自己挂 JSON 解析:否则 req.body 恒为 undefined,
  // 未知渠道不会 400、analyze:false 也会被忽略(实测过这个坑)。
  router.use(express.json({ limit: "1mb" }));

  router.get("/channels", (_req, res) => {
    res.json({
      channels: CHANNELS.map((c) => ({
        key: c.key,
        label: c.label,
        note: c.note,
        requiresEnv: c.needsEnv ?? null,
        intervalMinutes: c.onDemandOnly ? null : (c.intervalMinutes ?? DEFAULT_HOT_CHANNEL_INTERVAL_MIN),
        onDemandOnly: Boolean(c.onDemandOnly),
        available: c.needsEnv ? Boolean(process.env[c.needsEnv]?.trim()) : true,
      })),
      refused: REFUSED_CHANNELS,
    });
  });

  const BrowserLoginSchema = z
    .object({ url: z.string().regex(/^https:\/\/[^\s]+$/i, "只支持 https 地址").default("https://www.xiaohongshu.com/explore") })
    .strict();

  // 「登录一次」:打开看得见的浏览器窗口让用户自己登录,登录态留在本机档案目录。
  // 服务端不代填账号、不读 Cookie、不碰验证码 —— 只负责把窗口开起来和收掉。
  router.get("/browser-login", (_req, res) => res.json(loginWindowState()));

  router.post("/browser-login", async (req, res) => {
    try {
      const body = BrowserLoginSchema.parse(req.body ?? {});
      const state = await openLoginWindow(body.url);
      res.json({ ok: true, ...state });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.post("/browser-login/close", async (_req, res) => {
    try {
      res.json({ ok: true, ...(await closeLoginWindow()) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /**
   * 试采:用给定配置真开一次浏览器,把取到的条目回显出来,但**一条都不入库**。
   * 存在的理由:需要登录的平台(小红书)只有登录之后才看得到页面结构,
   * 而"改选择器 → 建任务 → 跑一次 → 看有没有数据"这个循环对非开发者太重。
   * 有了它,使用者在界面上就能把选择器试对,再保存成任务。
   */
  router.post("/browser-preview", async (req, res) => {
    try {
      const connector = getConnector(BROWSER_PAGE_CONNECTOR_ID);
      if (!connector) return res.status(500).json({ error: "浏览器采集连接器未注册" });
      const cfg = (req.body?.config ?? {}) as Record<string, unknown>;
      const v = connector.validateConfig(cfg);
      if (!v.ok) return res.status(400).json({ error: `配置不合法:${v.error}` });
      const run = await connector.collectPage(
        { pageSize: (cfg.maxItems as number) ?? 20 },
        cfg,
        {
          runId: 0,
          taskId: 0,
          signal: new AbortController().signal,
          logger: { event: () => {}, runId: 0 },
        },
      );
      const items = run.items.slice(0, 20) as Record<string, unknown>[];
      res.json({
        ok: true,
        count: run.items.length,
        items,
        // 把这次真正取到的键回显出来:使用者据此确认 fields 的键名有没有写对
        keys: [...new Set(items.flatMap((i) => Object.keys(i)))],
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string })?.code ?? null;
      res.status(400).json({ error: msg, code });
    }
  });

  /**
   * 正在跑的抓取/深挖进度;没有任务在跑时返回 { job: null }。
   * 界面每 1.5 秒读一次 —— 关键是让人看见"现在在做第几条、这条已经等了多久",
   * 而不是一片空白地猜程序是不是死了。
   */
  router.get("/progress", (_req, res) => {
    res.json(progressSnapshot());
  });

  router.post("/capture", async (req, res) => {
    try {
      const captureStartedAt = new Date().toISOString();
      const body = CaptureSchema.parse(req.body ?? {});
      const wanted = pickCaptureChannels(body.channels);
      if (body.channels && wanted.length !== body.channels!.length) {
        const known = new Set(CHANNELS.map((c) => c.key));
        return res.status(400).json({ error: `存在未知渠道:${body.channels!.filter((k) => !known.has(k)).join(", ")}` });
      }

      const results: Record<string, unknown>[] = [];
      let accepted = 0;
      // 进度先立起来:总数 = 这次真的要处理的渠道数(被跳过的也算在内,原因如实标)。
      // 界面靠它显示"已完成 N / M · 正在采哪一条 · 已等待多久" —— 之前只有最后一次性返回,
      // 使用者等十分钟也分不清是卡住了还是本来就这么慢。
      beginJob("capture", wanted.map((c) => c.label));
      // 显式点名的渠道如果缺自己的凭证,按渠道跳过并说明原因:
      // 不能悄悄建一个注定失败的任务(实测:指定 weibo-hot 而无 WEIBO_COOKIE 时会多出一条任务与一条失败运行)。
      const runnable: ChannelPreset[] = [];
      wanted.forEach((c, i) => {
        if (c.needsEnv && !process.env[c.needsEnv]?.trim()) {
          results.push({ channel: c.label, status: "skipped", reason: `缺少环境变量 ${c.needsEnv},未采集` });
          markFinished("capture", i, "skipped", `缺少 ${c.needsEnv}`);
          return;
        }
        runnable.push(c);
      });
      for (const c of runnable) {
        const index = wanted.indexOf(c);
        markRunning("capture", index);
        const startedAt = new Date().toISOString();
        try {
          const { taskId, run } = await findOrCreateTask(db, runtime, c);
          if (!run.ok) {
            results.push({ channel: c.label, status: "refused", reason: run.reason, taskId });
            markFinished("capture", index, "failed", String(run.reason ?? "运行被拒绝"));
            continue;
          }
          type RunLite = {
            status: string;
            recordsFetched: number;
            recordsAccepted: number;
            duplicates: number;
            errorMessage: string | null;
          };
          let view: RunLite | undefined;
          for (let i = 0; i < 120; i++) {
            await sleep(1000);
            const got = await getRun(db, run.runId!);
            view = got?.run as unknown as RunLite | undefined;
            if (view && ["completed", "partial", "failed", "cancelled"].includes(view.status)) break;
          }
          accepted += view?.recordsAccepted ?? 0;
          const st = view?.status ?? "timeout";
          results.push({
            channel: c.label,
            status: st,
            fetched: view?.recordsFetched ?? 0,
            accepted: view?.recordsAccepted ?? 0,
            duplicates: view?.duplicates ?? 0,
            error: view?.errorMessage ?? null,
            taskId,
            startedAt,
          });
          markFinished(
            "capture",
            index,
            st === "completed" ? "done" : "failed",
            st === "completed"
              ? `入库 ${view?.recordsAccepted ?? 0} / 去重 ${view?.duplicates ?? 0}`
              : (view?.errorMessage ?? "这一条没有正常结束"),
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ channel: c.label, status: "error", error: msg });
          markFinished("capture", index, "failed", msg);
        }
      }
      endJob("capture");

      // 如实汇报"这批新内容会不会被自动算一遍"。
      // 采集运行结束时 runtime 挂点已经触发过一次,这里的调用只是兜底(锁会挡住重复);
      // 真正的答案在快照里 —— 之前直接回传本次调用的返回值,会出现
      // "响应说没触发,但 /api/analysis/status 里 triggered 已经 +1" 的自相矛盾。
      let analysis: Record<string, unknown> = { triggered: false, running: false };
      if (body.analyze && accepted > 0) {
        startAutoAnalysis(db, { accepted, status: "completed" });
        const snap = autoAnalysisSnapshot();
        const covered = snap.running || (snap.lastTriggeredAt ?? "") >= captureStartedAt;
        analysis = {
          triggered: covered,
          running: snap.running,
          lastStatus: snap.lastStatus,
          lastTriggeredAt: snap.lastTriggeredAt,
          ...(covered
            ? {}
            : { reason: "自动分析未触发(可能被 TRENDSCOPE_AUTO_ANALYSIS=0 关闭,或本次没有新内容入库)" }),
        };
      }

      res.json({ ok: true, channels: results, accepted, analysis });
    } catch (e) {
      clientOrServerError(res, "hot-capture", e);
    }
  });

  // ---- 热点派生:热榜标题 → 站内检索 → 真正的创作内容 ----
  const CascadeSchema = z
    .object({
      keywords: z.number().int().min(1).max(5).optional(),
      perKeyword: z.number().int().min(1).max(20).optional(),
      /** 跳过"上一轮刚跑过"的节流:手动点击时用 */
      force: z.boolean().default(false),
    })
    .strict();

  router.get("/cascade", (_req, res) => {
    res.json({ ok: true, cascade: cascadeSnapshot() });
  });

  router.post("/cascade", async (req, res) => {
    try {
      const body = CascadeSchema.parse(req.body ?? {});
      const result = await runHotCascade(db, runtime, {
        keywords: body.keywords,
        perKeyword: body.perKeyword,
        ...(body.force ? { minIntervalMs: 0 } : {}),
      });
      res.json({ ok: true, ...result, cascade: cascadeSnapshot() });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  return router;
}
