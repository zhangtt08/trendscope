/**
 * Percentile service (Stage 7 §M):0-100 percentile,mean-rank 法。
 * 覆盖并列值/空数据/单样本/极端值;禁 value/max 假归一化。
 * 确定性纯函数;null 输入 → null(unknown ≠ 0 红线)。
 */

/**
 * mean-rank percentile:pct = 100 × (严格低于数 + 0.5×并列数) / n。
 * - 单样本 → 50(它就是中位数;置信度由 cohortSize 因子另行压低,不造假精确)
 * - 空数组 → null(无分布可比)
 * - 并列值同分(mean rank),避免"第一个并列=100%、最后一个=0%"的顺序伪影
 */
export function percentileRank(value: number, values: readonly number[]): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (!values || values.length === 0) return null;
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < value) below += 1;
    else if (v === value) equal += 1;
  }
  return (100 * (below + 0.5 * equal)) / values.length;
}

/** 中位数(偶数取均值);空 → null。Creator Baseline 用 median 不用 mean(§O)。 */
export function median(values: readonly number[]): number | null {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 样本标准差(分母 n-1);n<2 → null。lifecycle 波动(常青判定)用。 */
export function stddev(values: readonly number[]): number | null {
  if (!values || values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * 增长比 → 0-100 分(saturating:100·r/(r+1))。
 * r=1(与基准持平)→ 50;r=4 → 80;r=0.25 → 20。
 * baseline≤0:current>0 → 100(凭空新增);both 0 → 50(无信号,中性)。
 * current<0 或异常输入 → 0(负增长不给负分,下行由 lifecycle 处理)。
 */
export function growthRatioScore(current: number, baseline: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return 50;
  if (current < 0) current = 0;
  if (baseline <= 0) return current > 0 ? 100 : 50;
  const r = current / baseline;
  return (100 * r) / (r + 1);
}

/** 限量小数:UI 统一最多 1 位(§BV 无假精确)。 */
export function round1(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.round(v * 10) / 10;
}
