/** Display formatting. null → "—" (spec §23); real 0 → "0". */

export const EM_DASH = "—";

export function fmtMetric(v: number | null | undefined): string {
  if (v === null || v === undefined) return EM_DASH;
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  // 小数必须收口:日增赞这类派生值直接 String() 会显示 3.4285714285714286,
  // 违反"无假精确"约定。整数原样,小数最多一位。
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, "");
}

/**
 * §76 数字口径(唯一规则):
 *  - 计数(内容条数、命中数)用千分位精确值;
 *  - 互动量与派生指标用 万/亿 紧凑制,小数只留一位;
 *  - 坐标轴同用 万/亿,不引入 k / M 等第二套单位;
 *  - 未知一律 null,由调用方显示"—",绝不补 0。
 */
export function fmtAxisNumber(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EM_DASH;
  const abs = Math.abs(v);
  if (abs >= 100_000_000) return `${(v / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (abs >= 10_000) return `${(v / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, "");
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(iso: string | null | undefined): string {
  return fmtDateTime(iso).slice(0, 10) === EM_DASH.slice(0, 10) ? EM_DASH : fmtDateTime(iso).slice(0, 10);
}

export const PLATFORM_LABELS: Record<string, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  zhihu: "知乎",
  bilibili: "B站",
  weibo: "微博",
  toutiao: "今日头条",
  baidu: "百度热搜",
  ithome: "IT之家",
  douban: "豆瓣",
  tieba: "百度贴吧",
  manual: "手动",
  other: "其他",
};

export const CONTENT_TYPE_LABELS: Record<string, string> = {
  video: "视频",
  image_post: "图文",
  text_post: "文字",
  question: "提问",
  answer: "回答",
  article: "文章",
  unknown: "未知",
};

export const QUALITY_LABELS: Record<string, string> = {
  complete: "完整",
  partial: "部分",
  minimal: "极简",
  invalid: "无效",
};

/** §78:界面一律中文;括号里保留工程上常说的缩写,内部 code 不变。 */
export const SOURCE_TYPE_LABELS: Record<string, string> = {
  api: "接口采集",
  playwright: "浏览器采集",
  csv: "CSV 导入",
  json: "JSON 导入",
  manual: "手动录入",
  fixture: "演示数据",
  replay: "回放数据",
};

/** 采集间隔说成人话:30 → 每 30 分钟,360 → 每 6 小时。数字不换算成"半小时"这种含糊说法。 */
export function intervalZh(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return EM_DASH;
  if (min % 1440 === 0) return `每 ${min / 1440} 天`;
  if (min % 60 === 0) return `每 ${min / 60} 小时`;
  return `每 ${min} 分钟`;
}

/** 采集运行的错误码与事件码:接口里保持英文 code(契约),界面显示中文。 */
export const RUN_ERROR_ZH: Record<string, string> = {
  AUTH_ERROR: "鉴权失败",
  RATE_LIMITED: "触发频率限制",
  NETWORK_ERROR: "网络错误",
  REMOTE_5XX: "远端服务错误",
  TIMEOUT: "请求超时",
  INVALID_RESPONSE: "响应无法解析",
  SCHEMA_DRIFT: "上游结构变化",
  INVALID_CONFIG: "任务配置不合法",
  CANCELLED: "已取消",
  INTERRUPTED: "被中断",
  UNKNOWN: "未知错误",
};

export const RUN_EVENT_ZH: Record<string, string> = {
  RUN_QUEUED: "已排队",
  RUN_STARTED: "开始运行",
  RUN_COMPLETED: "运行完成",
  RUN_PARTIAL: "部分完成",
  RUN_FAILED: "运行失败",
  RUN_CANCELLED: "已取消",
  PAGE_FETCHED: "取回一页",
  PAGE_FAILED: "该页失败",
  RECORD_IMPORTED: "记录入库",
  RATE_LIMIT_WAIT: "等待限流窗口",
  RATE_LIMITED: "触发频率限制",
  RETRY: "重试",
  CHECKPOINT_SAVED: "保存断点",
  SCHEMA_DRIFT: "上游结构变化",
  INTERRUPTED: "被中断",
};

export const METRIC_LABELS: Record<string, string> = {
  views: "浏览量",
  likes: "点赞数",
  comments: "评论数",
  shares: "分享数",
  favorites: "收藏数",
  upvotes: "赞同数",
  followers: "粉丝数",
};

/** 连接器元数据里的枚举:内部 code 不变,展示走中文。 */
export const CONNECTOR_TYPE_LABELS: Record<string, string> = {
  api: "官方接口",
  browser: "浏览器采集",
  file: "本地文件",
  mock: "演示模拟",
  other: "其他",
};

export const CAPABILITY_LABELS: Record<string, string> = {
  search: "搜索",
  hotlist: "热榜",
  content_detail: "内容详情",
  comments: "评论",
  author: "作者",
  metrics: "互动指标",
};

export const BREAKER_STATE_LABELS: Record<string, string> = {
  closed: "正常",
  open: "已熔断",
  half_open: "试探恢复",
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "正在运行",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};

export const DUP_REASON_LABELS: Record<string, string> = {
  fingerprint: "指纹一致",
  manual: "人工标记",
};

export const DUP_STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  confirmed_duplicate: "已确认合并",
  not_duplicate: "非重复",
  ignored: "已忽略",
};

/** 采集运行的触发方式,与 collection_runs.trigger 取值一致。 */
export const TRIGGER_LABELS: Record<string, string> = {
  manual: "手动",
  schedule: "定时",
  resume: "断点续跑",
};

/**
 * 批次名是历史数据(append-only),早期由服务端生成为 `fixture:<slug>` / `manual-<时间>`。
 * 展示时补中文前缀(§78),原始标识保留在 slug 段,方便对账与排查。
 */
const FIXTURE_SLUG_ZH: Record<string, string> = {
  "douyin-like-export": "抖音样本",
  "xiaohongshu-like-export": "小红书样本",
  "zhihu-like-export": "知乎样本",
  "edge-cases": "边界样本",
  "large-dataset": "大规模样本",
};

export function batchDisplayName(name: string | null): string {
  if (!name) return EM_DASH;
  const fx = name.match(/^fixture:(.+)$/);
  if (fx) {
    const slug = fx[1].replace(/-export$/, "");
    return `示例数据 · ${FIXTURE_SLUG_ZH[fx[1]] ?? FIXTURE_SLUG_ZH[slug] ?? fx[1]}`;
  }
  const mn = name.match(/^manual-(.+)$/);
  if (mn) return `手动录入 · ${mn[1].replace("T", " ")}`;
  return name;
}

export function parseHashtagsJson(s: string | null): string[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/** 把毫秒说成人话:进度提示里"已经等了多久"是判断程序有没有卡住的关键信息。 */
export function elapsedZh(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return EM_DASH;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest === 0 ? `${m} 分钟` : `${m} 分 ${rest} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}
