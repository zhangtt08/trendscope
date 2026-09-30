/**
 * Creator Baseline (Stage 7 §O/§P):作者历史中位表现基准。
 * - 历史内容 ≥ creatorMinHistory → relativeBasis=creator:当前互动总量在
 *   作者历史分布中的百分位(median 思想,单条爆款拉不偏 baseline)。
 * - 不足 → relativeBasis=cohort(同 cohort 分布);连 cohort 都没有 → unknown。
 * - 绝不写 50 冒充"正常"(§P)。
 * 互动总量 = 最新快照中可用互动指标之和(null 项跳过,不按 0;全 null = null)。
 * 历史分布的构建与"排除自身"由 service 层完成(带 itemId 才能精确排除)。
 */

export type RelativeBasis = "creator" | "cohort" | "unknown";

export function creatorKeyOf(authorId: string | null | undefined, authorName: string | null | undefined): string | null {
  if (authorId && authorId.trim()) return `id:${authorId.trim()}`;
  if (authorName && authorName.trim()) return `name:${authorName.trim()}`;
  return null;
}

/** interactionTotal:可用互动之和;全部未知 → null(unknown ≠ 0)。 */
export function interactionTotal(
  m: Partial<Record<"likes" | "comments" | "shares" | "favorites" | "upvotes", number | null>>,
): number | null {
  let sum = 0;
  let known = 0;
  for (const k of ["likes", "comments", "shares", "favorites", "upvotes"] as const) {
    const v = m[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      known += 1;
    }
  }
  return known > 0 ? sum : null;
}
