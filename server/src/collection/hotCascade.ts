/**
 * 热点派生采集:热榜只给标题,而趋势、话题与选题需要"创作内容"本身。
 *
 * 为什么要有这一步(目标里写的是"采集热点话题以及视频等创作内容"):
 * 「一键抓热点」拿回来的是各平台热榜条目 —— 标题 + 热度 + 链接,没有正文、作者、互动数。
 * 这类条目聚不成簇(实测 831 条里 647 条未归类),趋势只能靠采集时间推断,选题也就停在标题层面。
 * 本模块把当日热点标题拆成检索词,再用**已有凭证的搜索接口**取回真正的内容条目
 * (知乎官方搜索:回答正文、作者、赞数、评论数),让下游拿到可分析的数据。
 *
 * 边界(刻意的):
 * - 只用已有的合法通道:默认知乎开放平台官方搜索接口。没有凭证就整轮跳过,零写入。
 * - 任务数量恒定:每个检索词占一个**固定槽位任务**(名字带序号),复用而不是每轮新建 ——
 *   否则半小时一次定时采集会把采集中心淹掉。
 * - 有节流:默认 30 分钟内不重复;进程内同一时刻只跑一轮;检索词有冷却期,避免反复搜同一个词。
 * - 配额:每轮最多 N 个词 × 每词 M 条,默认 3 × 10,对知乎 5000 次/日的额度是零头。
 */
import { and, desc, eq, gte, isNotNull, ne } from "drizzle-orm";
import type { DB } from "../db/client";
import { collectionTasks, contentItems } from "../db/schema";
import { createTask, getRun, listTasks, updateTask } from "../services/collection/service";
import type { CollectionRuntime } from "../services/collection/runtime";
import { beginJob, endJob, markFinished, markRunning } from "../services/hotProgress";

const TASK_PREFIX = "热点派生 · 检索";
const TERMINAL = ["completed", "partial", "failed", "cancelled"];

/**
 * 热榜标题里的"胶水词":它们是榜单的共有措辞或汉语虚词,不是一个可检索的话题。
 * 判定不只靠这张表(还有文档频率上下限),但只靠频率上下限会翻车 ——
 * 实测按"越稀有越具体"排序后,派生出了「其中」「代表」这种没用的词(它们确实少见)。
 * 想搜自己关心的词,不必绕这一层:采集中心建一个搜索任务即可。
 */
const GENERIC_HOT_WORDS = new Set([
  // 榜单措辞
  "近日", "网友", "表示", "认为", "回应", "相关", "什么", "如何", "为什么", "怎么",
  "这个", "那个", "一种", "一款", "一起", "正式", "宣布", "出现", "情况", "时候",
  "问题", "回答", "视频", "图片", "消息", "话题", "今日", "上午", "下午", "凌晨",
  // 汉语虚词与抽象词(少见但不成话题,正是"越稀有越具体"会挑出来的东西)
  "其中", "代表", "方面", "时间", "关系", "东西", "事情", "一下", "这样", "那样",
  "就是", "不是", "可以", "可能", "已经", "一直", "未来", "现在", "今天", "昨天",
  "明天", "目前", "此次", "本次", "有关", "关于", "一个", "一些", "主要", "重要",
  "称将", "此外", "随后", "截至", "上述", "记者", "报道", "通报", "介绍", "表示称",
]);

/** 不同连接器的搜索配置形状不一样,这里只有一处映射。 */
const CASCADE_PROFILES: Record<string, { collectionType: string; config: (query: string, count: number) => Record<string, unknown> }> = {
  "zhihu-official": {
    collectionType: "search",
    config: (query, count) => ({ mode: "search", query, count }),
  },
  // 离线可用的确定性源:集成测试用它跑通真实入库路径,不打公网。
  "fixture-remote": {
    collectionType: "search",
    config: (query, count) => ({ platform: "zhihu", keyword: query, scenario: "A", totalItems: count, pageSize: count }),
  },
};

export interface CascadeOptions {
  /** 每轮最多派生几个检索词 */
  keywords?: number;
  /** 每个检索词取回多少条 */
  perKeyword?: number;
  /** 关键词取回的时间窗口(小时) */
  windowHours?: number;
  /** 自动节流:距上次多久才允许再跑(毫秒) */
  minIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CascadeKeywordResult {
  keyword: string;
  taskId: number;
  runId: number | null;
  status: string;
  accepted: number;
  error: string | null;
}

export interface CascadeResult {
  ran: boolean;
  reason: string | null;
  keywords: string[];
  results: CascadeKeywordResult[];
  accepted: number;
}

const state = {
  running: false,
  lastStartedAt: null as string | null,
  lastFinishedAt: null as string | null,
  lastKeywords: [] as string[],
  lastAccepted: 0,
  lastError: null as string | null,
  rounds: 0,
  /** 冷却期内的检索词 → 冷却到什么时候(进程内即可,重启后重复搜索的代价是零写入的去重) */
  cooldown: new Map<string, number>(),
};

export function cascadeSnapshot() {
  return {
    enabled: cascadeEnabled(),
    running: state.running,
    lastStartedAt: state.lastStartedAt,
    lastFinishedAt: state.lastFinishedAt,
    lastKeywords: state.lastKeywords,
    lastAccepted: state.lastAccepted,
    lastError: state.lastError,
    rounds: state.rounds,
    connector: cascadeConnectorId(),
  };
}

/** 默认开;`TRENDSCOPE_HOT_CASCADE=0` 关闭(只影响自动触发,手动按钮始终可用)。 */
export function cascadeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.TRENDSCOPE_HOT_CASCADE?.trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

export function cascadeConnectorId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env.TRENDSCOPE_HOT_CASCADE_CONNECTOR?.trim();
  return id && CASCADE_PROFILES[id] ? id : "zhihu-official";
}

/** 该连接器这一轮能不能真的取数(缺凭证就整轮跳过,不要留下一串失败运行)。 */
function connectorAvailable(connectorId: string, env: NodeJS.ProcessEnv): { ok: boolean; reason?: string } {
  if (connectorId === "zhihu-official") {
    return env.ZHIHU_ACCESS_SECRET?.trim()
      ? { ok: true }
      : { ok: false, reason: "未配置 ZHIHU_ACCESS_SECRET,热点派生需要知乎官方搜索接口的凭证。" };
  }
  return { ok: true };
}

/** 从一条热榜标题里取出可检索的短语:去掉包裹符号与标点,截到 30 字。 */
function toQuery(text: string): string | null {
  const cleaned = text
    .replace(/[「」『』【】《》"'（）()，。、；;：:!！?？…·\-—|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const phrase = cleaned.slice(0, 30).trim();
  // 至少 4 个字才叫一个话题;必须含中日韩文字,否则是型号/数字/纯英文噪声
  if ([...phrase].length < 4) return null;
  if (!/[\u4e00-\u9fa5]/.test(phrase)) return null;
  if (/^\d+$/.test(phrase.replace(/\s/g, ""))) return null;
  if (GENERIC_HOT_WORDS.has(phrase)) return null;
  return phrase;
}

/**
 * 派生检索词 = **热榜标题本身**,不是分词片段。
 *
 * 为什么换掉片段方案:仓库的中文分词是按二字滑窗(TF×IDF),拿它当搜索词会产出
 * 「生活」「长期」「实际」「其中」这类虚词片段 —— 它们确实"少见",但不成话题
 * (真机实测连续两轮派生出这类词)。热榜标题天然就是一个具体话题
 * ("Tiffany中国区负责人致歉" 这种),按热度取前 N 条既是最有代表性的排序口径,
 * 也保证搜回来的就是这件事的讨论。
 *
 * 只排除示例/回放数据(那是假热点),并按前 8 字去重,避免同一事件的八条榜单标题各搜一遍。
 */
export async function pickHotKeywords(
  db: DB,
  opts: { limit?: number; windowHours?: number; now?: number } = {},
): Promise<string[]> {
  const limit = Math.max(1, Math.min(10, opts.limit ?? 3));
  const windowHours = Math.max(1, opts.windowHours ?? 24);
  const now = opts.now ?? Date.now();
  const since = new Date(now - windowHours * 3600_000).toISOString();

  const rows = await db
    .select({
      title: contentItems.title,
      views: contentItems.views,
      collectedAt: contentItems.collectedAt,
      sourceType: contentItems.sourceType,
    })
    .from(contentItems)
    .where(and(gte(contentItems.collectedAt, since), isNotNull(contentItems.title), ne(contentItems.sourceType, "fixture")))
    .orderBy(desc(contentItems.views), desc(contentItems.collectedAt))
    .limit(500);

  const seenPrefix = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const phrase = toQuery(r.title ?? "");
    if (!phrase) continue;
    if ((state.cooldown.get(phrase) ?? 0) > now) continue;
    const prefix = [...phrase].slice(0, 8).join("");
    if (seenPrefix.has(prefix)) continue; // 同一事件的多个榜单变体只搜一次
    seenPrefix.add(prefix);
    out.push(phrase);
    if (out.length >= limit) break;
  }

  if (state.cooldown.size > 600) {
    for (const [k, until] of state.cooldown) if (until <= now) state.cooldown.delete(k);
  }
  return out;
}

/** 固定槽位任务:同名就复用,绝不每轮新建(采集中心会被定时派生淹掉)。 */
async function ensureSlotTask(db: DB, runtime: CollectionRuntime, slot: number, connectorId: string): Promise<number> {
  const name = `${TASK_PREFIX} #${slot + 1}`;
  const existing = await listTasks(db, runtime);
  const found = existing.find((t) => t.name === name);
  if (found) return found.id;
  const profile = CASCADE_PROFILES[connectorId] ?? CASCADE_PROFILES["zhihu-official"]!;
  const created = await createTask(db, runtime, {
    name,
    connectorId,
    collectionType: profile.collectionType,
    config: profile.config("初始化", 3),
    schedule: { type: "manual" },
    enabled: true,
  });
  return created.id;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 跑一轮派生。返回 ran=false + reason 的情况都保证**零写入**:
 * 没有关键词 / 缺凭证 / 上一轮还在跑 / 距上次太近。
 */
export async function runHotCascade(
  db: DB,
  runtime: CollectionRuntime,
  opts: CascadeOptions = {},
): Promise<CascadeResult> {
  const env = opts.env ?? process.env;
  const empty: CascadeResult = { ran: false, reason: null, keywords: [], results: [], accepted: 0 };

  const minIntervalMs = opts.minIntervalMs ?? Number(env.TRENDSCOPE_HOT_CASCADE_MIN_MS ?? 30 * 60_000);
  if (state.running) return { ...empty, reason: "上一轮热点派生还在进行,本次不叠加。" };
  if (state.lastStartedAt && Date.now() - Date.parse(state.lastStartedAt) < minIntervalMs) {
    const waitMin = Math.ceil((minIntervalMs - (Date.now() - Date.parse(state.lastStartedAt))) / 60_000);
    return { ...empty, reason: `距上一轮不足 ${Math.max(1, minIntervalMs / 60_000)} 分钟,请 ${waitMin} 分钟后再来(手动触发可用 force 跳过)。` };
  }

  const keywords = await pickHotKeywords(db, { limit: opts.keywords ?? 3, windowHours: opts.windowHours });
  if (keywords.length === 0) return { ...empty, reason: "近 24 小时没有可用的真实热榜内容,无法派生检索词。" };

  const connectorId = cascadeConnectorId(env);
  const profile = CASCADE_PROFILES[connectorId];
  if (!profile) return { ...empty, reason: `未知的派生源:${connectorId}` };
  const available = connectorAvailable(connectorId, env);
  if (!available.ok) return { ...empty, reason: available.reason ?? "该源不可用。" };

  const perKeyword = Math.max(1, Math.min(20, opts.perKeyword ?? Number(env.TRENDSCOPE_HOT_CASCADE_PER_KEYWORD ?? 10)));
  state.running = true;
  state.rounds += 1;
  state.lastStartedAt = new Date().toISOString();
  state.lastKeywords = keywords;
  const cooldownMs = Math.max(1, Number(env.TRENDSCOPE_HOT_CASCADE_COOLDOWN_HOURS ?? 6)) * 3600_000;

  const results: CascadeKeywordResult[] = [];
  // 深挖也是逐个检索词串行(每个还要等自己的采集运行结束),同样要给界面看得见进度
  beginJob("cascade", keywords);
  try {
    for (const [i, keyword] of keywords.entries()) {
      markRunning("cascade", i);
      const taskId = await ensureSlotTask(db, runtime, i, connectorId);
      await updateTask(db, runtime, taskId, { config: profile.config(keyword, perKeyword) });
      state.cooldown.set(keyword, Date.now() + cooldownMs);
      const started = await runtime.runTask(taskId, "manual");
      if (!started.ok || started.runId == null) {
        results.push({ keyword, taskId, runId: null, status: "refused", accepted: 0, error: started.reason ?? null });
        markFinished("cascade", i, "failed", started.reason ?? "运行被拒绝");
        continue;
      }
      let accepted = 0;
      let status = "timeout";
      let error: string | null = null;
      for (let tick = 0; tick < 90; tick++) {
        await sleep(1000);
        const got = await getRun(db, started.runId);
        const run = got?.run as unknown as { status: string; recordsAccepted: number; errorMessage: string | null } | undefined;
        if (!run) continue;
        if (TERMINAL.includes(run.status)) {
          status = run.status;
          accepted = run.recordsAccepted ?? 0;
          error = run.errorMessage;
          break;
        }
      }
      results.push({ keyword, taskId, runId: started.runId, status, accepted, error });
      markFinished("cascade", i, status === "completed" ? "done" : "failed", error ?? `入库 ${accepted} 条`);
    }
  } finally {
    endJob("cascade");
    state.running = false;
    state.lastFinishedAt = new Date().toISOString();
    state.lastAccepted = results.reduce((a, r) => a + r.accepted, 0);
    state.lastError = results.find((r) => r.error)?.error ?? null;
  }

  return {
    ran: true,
    reason: null,
    keywords,
    results,
    accepted: results.reduce((a, r) => a + r.accepted, 0),
  };
}

/**
 * 采集运行结束后的自动挂点:只在"热榜渠道采回了新内容"时派生,
 * 且受节流与开关约束 —— 由启动装配(index.ts)调用。
 */
export async function maybeCascadeAfterCollection(db: DB, runtime: CollectionRuntime, info: { taskId: number; status: string; accepted: number }) {
  if (info.accepted <= 0) return null;
  if (!["completed", "partial"].includes(info.status)) return null;
  if (!cascadeEnabled()) return null;
  // 只对「热点渠道:*」触达派生;用户自建任务(自己的关键词搜索等)不该再触发一轮派生
  const [task] = await db
    .select({ id: collectionTasks.id, name: collectionTasks.name })
    .from(collectionTasks)
    .where(eq(collectionTasks.id, info.taskId))
    .limit(1);
  if (!task || !task.name.startsWith("热点渠道:")) return null;
  return runHotCascade(db, runtime);
}
