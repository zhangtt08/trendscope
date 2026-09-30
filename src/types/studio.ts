/**
 * 选题工作室前端契约 —— 与 server/src/studio 的返回结构一一对应。
 * 分数一律 number | null:未知就是未知,不折算成 0。
 */

export interface EvidenceRefItem {
  id: string;
  kind: string;
  label: string;
}

export interface EvidenceContent {
  refId: string;
  contentItemId: number;
  title: string | null;
  excerpt: string | null;
  platform: string;
  contentType: string;
  authorName: string | null;
  burstScore: number | null;
  burstConfidence: string | null;
  likes: number | null;
  comments: number | null;
  publishedAt: string | null;
  truncated: boolean;
}

export interface EvidencePattern {
  refId: string;
  feature: string;
  featureKind: string;
  viralRate: number | null;
  controlRate: number | null;
  lift: number | null;
  delta: number | null;
  viralSampleSize: number | null;
  controlSampleSize: number | null;
  evidenceQuality: string | null;
  direction: "more_common" | "less_common";
  controlMatchLevel: string | null;
  smoothingApplied: boolean;
}

export interface EvidenceAngle {
  refId: string;
  label: string | null;
  labelSource: string | null;
  memberCount: number;
  noveltyScore: number | null;
  isEmerging: boolean;
  firstObservedAt: string | null;
}

export interface StudioEvidencePackage {
  evidenceVersion: string;
  evidenceHash: string;
  builtAt: string;
  topicId: number;
  topicName: string;
  topicDescription: string | null;
  memberCount: number;
  topKeywords: string[];
  topHashtags: string[];
  platformDistribution: Record<string, number>;
  opportunityScore: number | null;
  opportunityConfidence: string | null;
  opportunityLevel: string | null;
  opportunityScoreVersion: string | null;
  positiveOpportunityReasons: string[];
  limitingOpportunityReasons: string[];
  lifecycle: string | null;
  lifecycleReason: string | null;
  pendingLifecycle: string | null;
  trendScore: number | null;
  trendConfidence: string | null;
  trendUnavailableReasons: Record<string, string> | null;
  burstDensity: number | null;
  topBurstContents: EvidenceContent[];
  representativeContent: EvidenceContent[];
  viralPatterns: EvidencePattern[];
  saturationScore: number | null;
  saturationBand: string | null;
  noveltyScore: number | null;
  noveltyConfidence: string | null;
  emergingAngles: EvidenceAngle[];
  dataFreshness: {
    trendCalculatedAt: string | null;
    intelligenceCalculatedAt: string | null;
    opportunityCalculatedAt: string | null;
    ageHours: Record<string, number | null>;
    stale: boolean;
  };
  qualityMode: string;
  sourceKinds: Record<string, number>;
  demoData: boolean;
  evidenceTruncated: {
    representative: boolean;
    burstContents: boolean;
    patterns: boolean;
    angles: boolean;
    packageSize: boolean;
  };
  evidenceIndex: EvidenceRefItem[];
  charCount: number;
}

export interface EvidenceBriefSection {
  key: string;
  title: string;
  lines: string[];
  emptyNote?: string;
}

export interface EvidenceBrief {
  generatedAt: string;
  kind: "deterministic_evidence_brief";
  deterministic: true;
  isAiGenerated: false;
  topicId: number;
  topicName: string;
  sections: EvidenceBriefSection[];
}

export interface StudioSettings {
  configured: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  secretStatus: "configured" | "missing";
  secretSource: string;
  missingEnvNames: string[];
  /** AI 能力的真实来源:外部 API / 本机 CLI / 无(与服务端 StudioSettingsView 一致) */
  source: "api" | "local-cli" | "none";
  /** 一句人话说明来源;服务端保证不含密钥值 */
  sourceDetail: string;
  usingDefaults: string[];
  promptVersion: string;
  schemaVersion: string;
  evidenceVersion: string;
}

export interface StudioRecommendedAngle {
  name: string;
  coreIdea: string;
  targetAudience: string;
  conflict: string;
  whyItMayBeInteresting: string;
  evidenceRefs: string[];
  saturationRisk: "low" | "medium" | "high" | "unknown";
  noveltyBasis: string;
}

export interface StudioHook {
  kind: string;
  text: string;
  evidenceRefs: string[];
}

export interface StudioTitleDirection {
  text: string;
  basedOn: string;
  evidenceRefs: string[];
  needsExternalVerification: boolean;
}

export interface StudioContentStructure {
  name: string;
  outline: string[];
  rationale: string;
  evidenceRefs: string[];
}

export interface StudioStance {
  label: string;
  summary: string;
  audienceFit: string;
  risks: string;
  evidenceRefs: string[];
}

export interface StudioOutput {
  topicSummary: string;
  whyNow: string;
  targetAudience: string;
  recommendedAngles: StudioRecommendedAngle[];
  hooks: StudioHook[];
  titleDirections: StudioTitleDirection[];
  contentStructures: StudioContentStructure[];
  stanceOptions: StudioStance[];
  risks: string[];
  avoidAngles: string[];
  evidenceReferences: string[];
  confidenceNote: string;
}

export interface StudioMark {
  angleIndex: number | null;
  state: string;
  note: string | null;
}

export interface StudioRunView {
  id: number;
  topicId: number;
  status: string;
  kind: string;
  provider: string | null;
  model: string | null;
  promptVersion: string;
  schemaVersion: string;
  evidenceVersion: string;
  evidenceHash: string;
  output: StudioOutput | null;
  unsupportedClaims: string[];
  error: string | null;
  demoData: boolean;
  staleEvidence: boolean;
  evidenceTruncated: Record<string, boolean> | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  durationMs: number | null;
  marks: StudioMark[];
}

export interface StudioView {
  brief: EvidenceBrief;
  evidence: StudioEvidencePackage;
  settings: StudioSettings;
  versions: { promptVersion: string; schemaVersion: string; evidenceVersion: string };
  history: StudioRunView[];
}

export interface StudioTopicRow {
  topicId: number;
  name: string;
  status: string;
  namingSource: string;
  memberCount: number;
  updatedAt: string;
  opportunityScore: number | null;
  opportunityLevel: string | null;
  opportunityConfidence: string | null;
  trendScore: number | null;
  lifecycle: string | null;
  lastRunAt: string | null;
  runCount: number;
}

export interface StudioGenerateResponse {
  runId: number;
  status: "completed" | "failed";
  reused: boolean;
  output: StudioOutput | null;
  unsupportedClaims: string[];
  error: string | null;
  provider: string | null;
  model: string | null;
  durationMs: number;
  evidenceHash: string;
  evidenceTruncated: StudioEvidencePackage["evidenceTruncated"];
  demoData: boolean;
  staleEvidence: boolean;
}
