#!/usr/bin/env node
/**
 * Live smoke for the Studio provider (Release 1.0 §29): npm run smoke:studio
 *
 * - STUDIO_API_KEY / STUDIO_BASE_URL / STUDIO_MODEL 缺一 → SKIPPED_NO_CREDENTIAL,
 *   exit 0(没有 AI 密钥时 TrendScope 依然完整可用,冒烟不该把 Release 卡住)。
 * - 配置齐全 → 一次最小 Evidence 请求:验证认证、结构化输出、schema 校验、
 *   以及密钥不出现在任何输出里。绝不打印密钥。
 *
 * 这里跑的是真实 provider 代码路径(OpenAICompatibleStudioProvider),
 * 不是另写一份 fetch,所以冒烟通过 == 生产请求形状通过。
 */
import { OpenAICompatibleStudioProvider } from "../server/src/studio/provider";
import { buildStudioMessages } from "../server/src/studio/prompt";
import { defaultStudioConfig, STUDIO_ENV } from "../server/src/studio/config";

// 体检与冒烟必须和应用程序读同一份 .env,否则用户按 README 配好密钥后这里仍报"未配置"
import { loadDotEnv } from "../server/src/env";
loadDotEnv();
import { studioSettings } from "../server/src/studio/studioSettings";
import { studioOutputSchema } from "../server/src/studio/schema";
import type { StudioEvidencePackage } from "../server/src/studio/evidencePackage";

const settings = studioSettings();
if (!settings.configured) {
  console.log(
    `SKIPPED_NO_CREDENTIAL — 需要 ${STUDIO_ENV.apiKey}(可选 ${STUDIO_ENV.baseUrl} / ${STUDIO_ENV.model});未配置时选题工作室仍提供确定性证据摘要。`,
  );
  process.exit(0);
}

/** 最小但形状真实的证据包:不读数据库,避免冒烟脚本改动任何用户数据。 */
const MINIMAL_EVIDENCE: StudioEvidencePackage = {
  evidenceVersion: "evidence-package-v1",
  evidenceHash: "ev-smoke",
  builtAt: new Date().toISOString(),
  topicId: 0,
  topicName: "冒烟测试话题",
  topicDescription: "仅用于验证 AI 服务连通性与输出契约",
  memberCount: 3,
  topKeywords: ["冒烟", "连通性"],
  topHashtags: [],
  platformDistribution: { zhihu: 3 },
  opportunityScore: 55,
  opportunityConfidence: "low",
  opportunityLevel: "medium",
  opportunityScoreVersion: "opportunity_v1",
  positiveOpportunityReasons: ["样本内出现稳定的新增内容"],
  limitingOpportunityReasons: ["样本量偏小"],
  lifecycle: "rising",
  lifecycleReason: "连续两个窗口增长",
  pendingLifecycle: null,
  trendScore: 60,
  trendConfidence: "low",
  trendEvidence: null,
  trendEffectiveWeights: null,
  trendUnavailableReasons: null,
  burstDensity: 1,
  topBurstContents: [
    {
      refId: "burst-content-1",
      contentItemId: 1,
      title: "冒烟样本标题",
      excerpt: "这是一条用于冒烟测试的正文摘要。",
      platform: "zhihu",
      contentType: "answer",
      authorName: null,
      burstScore: 70,
      burstConfidence: "low",
      likes: 10,
      comments: 1,
      publishedAt: null,
      truncated: false,
    },
  ],
  representativeContent: [],
  viralPatterns: [],
  saturationScore: 40,
  saturationBand: "中",
  saturationEvidence: null,
  noveltyScore: 55,
  noveltyConfidence: "low",
  emergingAngles: [],
  dataFreshness: {
    trendCalculatedAt: new Date().toISOString(),
    intelligenceCalculatedAt: null,
    opportunityCalculatedAt: new Date().toISOString(),
    ageHours: { trend: 0, intelligence: null, opportunity: 0 },
    stale: false,
  },
  qualityMode: "smoke",
  sourceKinds: { manual: 3 },
  demoData: true,
  evidenceTruncated: { representative: false, burstContents: false, patterns: false, angles: false, packageSize: false },
  evidenceIndex: [
    { id: "topic-1", kind: "topic", label: "话题 冒烟测试话题(3 条成员)" },
    { id: "trend-1", kind: "trend", label: "话题趋势指数 60(生命周期 rising)" },
    { id: "opportunity-1", kind: "opportunity", label: "选题机会指数 55" },
  ],
  charCount: 1200,
};

async function main() {
  const cfg = defaultStudioConfig();
  console.log(`LIVE TEST — 最小选题方案请求(model=${cfg.model},baseUrl=${cfg.baseUrl})…`);
  const provider = new OpenAICompatibleStudioProvider(cfg);
  const started = Date.now();
  const result = await provider.generate(buildStudioMessages(MINIMAL_EVIDENCE));
  const ms = Date.now() - started;
  const parsed = studioOutputSchema.safeParse(result.output);
  if (!parsed.success) {
    console.error("FAIL — 模型输出不符合选题方案 schema");
    for (const i of parsed.error.issues.slice(0, 5)) console.error(`  ${i.path.join(".")}: ${i.message}`);
    process.exit(1);
  }
  const out = parsed.data;
  const refs = new Set(MINIMAL_EVIDENCE.evidenceIndex.map((e) => e.id));
  const usedRefs = [
    ...out.recommendedAngles.flatMap((a) => a.evidenceRefs),
    ...out.titleDirections.flatMap((t) => t.evidenceRefs),
    ...out.evidenceReferences,
  ];
  const unknownRefs = [...new Set(usedRefs)].filter((r) => !refs.has(r));
  const blob = JSON.stringify(result);
  const key = process.env[STUDIO_ENV.apiKey] ?? "";
  console.log("PASS — 认证、结构化输出与 schema 校验通过");
  console.log(`  耗时 ${ms}ms · 角度 ${out.recommendedAngles.length} 条 · 标题方向 ${out.titleDirections.length} 条 · Hook ${out.hooks.length} 条`);
  console.log(`  证据引用 ${usedRefs.length} 处,其中不在索引内:${unknownRefs.length ? unknownRefs.join("、") : "无"}`);
  console.log(`  confidenceNote:${out.confidenceNote.slice(0, 80)}`);
  if (key && blob.includes(key)) {
    console.error("FAIL — 输出中出现了密钥");
    process.exit(1);
  }
  console.log("  Secret 已安全丢弃,未打印、未写入任何文件。");
  process.exit(0);
}

main().catch((e) => {
  const msg = e && e.message ? e.message : String(e);
  const key = process.env[STUDIO_ENV.apiKey] ?? "";
  console.error(`FAIL — ${key ? msg.split(key).join("[REDACTED]") : msg}`);
  process.exit(1);
});
