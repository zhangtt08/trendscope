/**
 * 报告文案的中文标签(服务端一份)。
 *
 * 为什么单独有这一份:分析报告是**服务端生成的文本**,会被人复制走或另存,
 * 所以枚举码必须在生成时就翻成中文 —— 前端的 `src/lib/format.ts` 管不到它。
 * 两边都存在的标签(生命周期、平台名、入库方式)由 `tests/unit/reportLabels.test.ts`
 * 逐键比对,防止漂移 —— 这条测试第一次跑就抓到「手动 / 手工录入」和「演示数据 / 示例数据」两处不一致。
 */
import { LIFECYCLE_LABELS_ZH } from "../scoring/lifecycle";

export const PLATFORM_LABELS_ZH: Record<string, string> = {
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

export const CONFIDENCE_LABELS_ZH: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export const LEVEL_LABELS_ZH: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
  insufficient: "数据不足",
};

/** 与前端 `SOURCE_TYPE_LABELS` 同义(由 tests/unit/reportLabels.test.ts 逐键比对)。 */
export const INGEST_KIND_LABELS: Record<string, string> = {
  api: "接口采集",
  playwright: "浏览器采集",
  csv: "CSV 导入",
  json: "JSON 导入",
  manual: "手动录入",
  fixture: "演示数据",
  replay: "回放数据",
};

export const lifecycleZh = (v: unknown): string =>
  v === null || v === undefined ? "数据不足" : LIFECYCLE_LABELS_ZH[v as keyof typeof LIFECYCLE_LABELS_ZH] ?? "数据不足";

export const confidenceZh = (v: unknown): string =>
  v === null || v === undefined ? "数据不足" : CONFIDENCE_LABELS_ZH[String(v)] ?? String(v);

export const levelZh = (v: unknown): string =>
  v === null || v === undefined ? "数据不足" : LEVEL_LABELS_ZH[String(v)] ?? String(v);

export const platformZh = (v: unknown): string =>
  v === null || v === undefined ? "未知" : PLATFORM_LABELS_ZH[String(v)] ?? String(v);

/**
 * ISO → 「2026-09-29 13:41」。报告给人看,不给用户看 ISO。
 * 用 Intl 而不是手写偏移算术:夏令时与闰秒都由时区数据库负责。
 */
export function formatDateTimeZh(iso: string | null | undefined): string {
  if (!iso) return "尚无";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(t));
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
