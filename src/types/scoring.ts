/** Stage 7 scoring API 类型(与 server/src/scoring 输出对齐)。 */

export type LifecycleState = "emerging" | "rising" | "peak" | "saturated" | "declining" | "evergreen";
export type Confidence = "high" | "medium" | "low";

export interface TopicTrendListRow {
  topicId: number;
  name: string;
  status: string;
  keywords: string | null;
  cohesion: number | null;
  memberCount: number;
  firstObservedAt: string | null;
  score: number | null;
  confidence: string | null;
  lifecycle: string | null;
  contentGrowth: number | null;
  engagementGrowth: number | null;
  creatorGrowth: number | null;
  burstDensity: number | null;
  acceleration: number | null;
  recentNewContent: number | null;
  activeCreators: number | null;
  avgRawMomentum: number | null;
  calculatedAt: string | null;
  watchState: string | null;
  saturationScore: number | null;
  noveltyScore: number | null;
  emergingAngleCount: number | null;
  opportunityScore: number | null;
  opportunityLevel: string | null;
}

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BurstComponent {
  score: number | null;
  weight: number;
  available: boolean;
}

export interface BurstBreakdown {
  velocity: BurstComponent;
  reach: BurstComponent;
  engagementQuality: BurstComponent;
  relativePerformance: BurstComponent;
  interactionStructure: BurstComponent;
  weightsUsed?: Record<string, number>;
  confidenceScore?: number;
  confidenceReasons?: string[];
}

export interface ContentScoreRow {
  contentItemId: number;
  title: string | null;
  platform: string;
  contentType: string;
  authorName: string | null;
  publishedAt: string | null;
  url: string | null;
  score: number | null;
  confidence: string | null;
  scorable: number;
  unscorableReason: string | null;
  calculatedAt: string | null;
  topicId: number | null;
}

export interface ScoreRecord {
  contentItemId?: number;
  topicId?: number;
  scoreVersion: string;
  scorable: number;
  unscorableReason: string | null;
  overallScore: number | null;
  score: number | null;
  confidence: string | null;
  breakdown: string | BurstBreakdown | null;
  evidence: string | Record<string, unknown> | null;
  calculatedAt: string;
}

export interface ContentScoreDetail {
  current: ScoreRecord | null;
  history: ScoreRecord[];
}

export interface LifecycleEvent {
  id: number;
  topicId: number;
  fromState: string | null;
  toState: string;
  trendScore: number | null;
  reason: string;
  scoreVersion: string;
  occurredAt: string;
}

export interface TopicTrendDetail {
  detail?: TrendDetailPayload;
  current: (ScoreRecord & { memberCount?: number; recentNewContent?: number | null; activeCreators?: number | null; pendingLifecycle?: string | null }) | null;
  history: ScoreRecord[];
  lifecycleEvents: LifecycleEvent[];
}

export interface ScoringRunRow {
  id: number;
  scoreProfile: string;
  scoreVersion: string;
  status: string;
  contentCount: number;
  scorableCount: number;
  unscorableCount: number;
  topicCount: number;
  configSnapshot: string;
  durationMs: number | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ContentBurstProfile {
  version: string;
  weights: Record<string, number>;
  velocityWindows: { key: string; hours: number }[];
  ageBuckets: { key: string; maxHours: number | null }[];
  cohort: { minSample: number; floorSample: number; levelLabels: string[] };
  creatorMinHistory: number;
}

export interface TopicTrendProfile {
  version: string;
  weights: Record<string, number>;
  windowHours: number;
  burstDensityThreshold: number;
  minMembers: number;
}

export interface LifecycleProfile {
  emergingMaxAgeDays: number;
  risingTrendMin: number;
  peakMinMembers: number;
  saturatedMinMembers: number;
  evergreenMinAgeDays: number;
  hysteresisConsecutive: number;
  hysteresisStrongJump: number;
}

export interface ScoringProfileResult {
  burst: ContentBurstProfile;
  trend: TopicTrendProfile;
  lifecycle: LifecycleProfile;
  note: string;
}

/** §51-§55:服务端下发的话题趋势分解(前端不得自己按权重重算)。 */
export interface TrendComponentView {
  label: string;
  score: number | null;
  weight: number;
  effectiveWeight: number | null;
  available: boolean;
  reason: string | null;
  evidence: Record<string, unknown> | null;
}

export interface TrendDetailPayload {
  topicId: number;
  overallScore: number | null;
  confidence: string | null;
  scoreVersion: string;
  scorable: boolean;
  unscorableReason: string | null;
  lifecycle: string | null;
  pendingLifecycle: string | null;
  pendingCount: number;
  contentGrowth: number | null;
  engagementGrowth: number | null;
  creatorGrowth: number | null;
  burstDensity: number | null;
  acceleration: number | null;
  components: Record<string, TrendComponentView> | null;
  effectiveWeights: Record<string, number> | null;
  unavailableReasons: Record<string, string>;
  /** false = 这一版 Run 根本没有记录分解(旧数据),UI 必须说"未记录",不能拿当前权重复算 */
  breakdownRecorded: boolean;
  evidence: Record<string, unknown> | null;
  memberCount: number;
  recentNewContent: number | null;
  activeCreators: number | null;
  avgRawMomentum: number | null;
  calculatedAt: string;
}
