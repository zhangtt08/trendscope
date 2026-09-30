/** Shared API types for Stage 3 trends & Candidate Workbench (Stage 4 §0 renamed). */

export interface MomentumRow {
  itemId: number;
  platform: string;
  title: string | null;
  authorName: string | null;
  publishedAt: string | null;
  url: string | null;
  contentType: string;
  base: { capturedAt: string; metrics: Partial<Record<string, number>> } | null;
  last: { capturedAt: string; metrics: Partial<Record<string, number>> } | null;
  delta: Partial<Record<string, number | null>>;
  daily: Partial<Record<string, number | null>>;
  engagement: number | null;
  /** Raw Momentum Score(原始互动动量)— 透明启发式,非 Viral/Trend/Opportunity Score */
  rawMomentumScore: number;
  unknownComponents: string[];
  snapshotCount: number;
  pick: { status: string; note: string | null } | null;
  topic: { id: number; name: string; memberCount: number; saturation: number | null; novelty: number | null; opportunity: number | null } | null;
}

export interface MomentumResult {
  rows: MomentumRow[];
  total: number;
  page: number;
  pageSize: number;
  windowDays: number;
  windowStart: string;
  baselineUsedCount: number;
}

export interface TrendOverview {
  windowDays: number;
  windowStart: string;
  platform?: string;
  buckets: { date: string; snapshots: number; distinctItems: number; likesDeltaSum: number | null }[];
  platformMix: { platform: string; items: number; snapshots: number }[];
  totalSnapshots: number;
  activeItems: number;
}

/** Domain 名 ContentPick(数据库表 topic_picks,列 momentum_score = 决策时 Raw Momentum) */
export interface ContentPick {
  id: number;
  contentItemId: number;
  status: string;
  note: string | null;
  rawMomentumScore: number | null;
  windowDays: number | null;
  createdAt: string;
  decidedAt: string | null;
  updatedAt: string;
  platform: string;
  title: string | null;
  authorName: string | null;
  publishedAt: string | null;
  likes: number | null;
  url: string | null;
}

/** @deprecated legacy alias — use ContentPick */
export type PickRow = ContentPick;

export interface PickListResult {
  rows: ContentPick[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<string, number>;
}
