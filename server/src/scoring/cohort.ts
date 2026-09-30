/**
 * Content Cohort (Stage 7 §I-§L):把内容放进"合理可比较的一组"。
 * 维度:platform + contentType + 发布年龄桶(+ topic);样本不足逐级放宽。
 * 全部确定性;cohort 元数据(级别/样本量/sampleQuality)随 evidence 落库。
 */
import type { ContentBurstProfile, AgeBucket } from "./profiles";

export type CohortLevelLabel = "exact" | "broadened_once" | "broadened_twice" | "platform_only";

export interface CohortPlacement {
  /** 最终 cohort key(诊断用) */
  key: string;
  level: 0 | 1 | 2 | 3;
  levelLabel: CohortLevelLabel;
  size: number;
  /** true = 即使 platform 级也不足 floorSample */
  insufficient: boolean;
}

/** §J:发布年龄 → 桶;publishedAt 未知 → "unknown" 桶(不与已知年龄混桶,§BE)。 */
export function ageBucketKey(publishedAt: string | null | undefined, nowMs: number, buckets: AgeBucket[]): string {
  if (!publishedAt) return "unknown";
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return "unknown";
  const hours = Math.max(0, (nowMs - t) / 3_600_000);
  for (const b of buckets) {
    if (b.maxHours === null || hours < b.maxHours) return b.key;
  }
  return buckets[buckets.length - 1].key;
}

interface CohortCandidate {
  platform: string;
  contentType: string;
  ageBucket: string;
  topicId: number | null;
}

/**
 * 回退梯子(§K):level0(platform+contentType+age+topic)→ level3(platform)。
 * 第一个样本量 ≥ minSample 的级别即停;都不足 → platform 级 ≥ floorSample
 * 则用 platform 级(sampleQuality=platform_only,置信度扣分),否则 insufficient。
 * 原则:宁可粗一点也不要 N=4 的"96.7 percentile"假精确。
 */
export function resolveCohort(
  c: CohortCandidate,
  sizes: { l0: number; l1: number; l2: number; l3: number },
  profile: ContentBurstProfile,
): CohortPlacement {
  const labels = profile.cohort.levelLabels;
  const keys = [
    `${c.platform}|${c.contentType}|${c.ageBucket}|topic:${c.topicId ?? "-"}`,
    `${c.platform}|${c.contentType}|${c.ageBucket}`,
    `${c.platform}|${c.ageBucket}`,
    `${c.platform}`,
  ];
  const levels: (0 | 1 | 2 | 3)[] = [0, 1, 2, 3];
  const sizeOf = (lv: 0 | 1 | 2 | 3): number => sizes[`l${lv}` as "l0" | "l1" | "l2" | "l3"];
  for (const lv of levels) {
    if (sizeOf(lv) >= profile.cohort.minSample) {
      return { key: keys[lv], level: lv, levelLabel: labels[lv], size: sizeOf(lv), insufficient: false };
    }
  }
  const platformSize = sizeOf(3);
  if (platformSize >= profile.cohort.floorSample) {
    return { key: keys[3], level: 3, levelLabel: labels[3], size: platformSize, insufficient: false };
  }
  return { key: keys[3], level: 3, levelLabel: labels[3], size: platformSize, insufficient: true };
}
