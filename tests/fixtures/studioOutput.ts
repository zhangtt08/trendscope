/** Studio 模型输出夹具 —— 与 server/src/studio/schema.ts 的严格 schema 一一对应。 */
export const STUDIO_OUTPUT_FIXTURE = {
  topicSummary: "这个话题当前聚集在若干具体提问上,成员以长回答为主。",
  whyNow: "话题趋势指数已给出,生命周期处于加速段,机会指数的正向信号来自趋势与新颖度。",
  targetAudience: "正在做同类内容、需要判断切入角度的运营与创作者。",
  recommendedAngles: [
    {
      name: "把共识拆成可验证的步骤",
      coreIdea: "围绕话题里被反复提问的操作步骤,给出一份可复述的检查清单。",
      targetAudience: "刚入门、需要明确路径的读者",
      conflict: "共识性建议很多,但少有可核对的执行细节",
      whyItMayBeInteresting: "趋势与机会指数的正向信号都指向该话题仍在被持续提问。",
      evidenceRefs: ["trend-1", "opportunity-1"],
      saturationRisk: "medium",
      noveltyBasis: "现有代表内容以经验叙述为主,清单式表达在证据里较少出现。",
    },
    {
      name: "从失败样本反推前提",
      coreIdea: "用话题里出现过的反面案例,说明结论成立需要哪些前提。",
      targetAudience: "已经看过常规答案、想看差异的读者",
      conflict: "主流叙述集中在成功路径",
      whyItMayBeInteresting: "代表内容显示讨论集中在单一叙事上。",
      evidenceRefs: ["rep-1", "topic-1"],
      saturationRisk: "low",
      noveltyBasis: "新兴角度数量为零,说明该切法尚未在语料里形成簇。",
    },
  ],
  hooks: [
    { kind: "question", text: "同一个问题为什么今年被反复提起?", evidenceRefs: ["trend-1"] },
    { kind: "experience", text: "把三次尝试里唯一有效的那一步拆开讲", evidenceRefs: [] },
  ],
  titleDirections: [
    { text: "这个话题今年被反复提问,值得看的三个细节", basedOn: "趋势处于加速段", evidenceRefs: ["trend-1"], needsExternalVerification: false },
    { text: "别再复制共识答案了:先核对这四条前提", basedOn: "代表内容的单一叙事", evidenceRefs: ["rep-1"], needsExternalVerification: false },
  ],
  contentStructures: [
    {
      name: "观察 → 前提 → 步骤 → 复核",
      outline: ["说明话题当前被讨论的形态", "列出结论依赖的前提", "给出可执行步骤", "提示复核方式"],
      rationale: "与证据中的操作型提问对齐。",
      evidenceRefs: ["topic-1"],
    },
  ],
  stanceOptions: [
    {
      label: "支持给出可复述路径",
      summary: "认为明确步骤比情绪化判断更有价值。",
      audienceFit: "入门读者",
      risks: "容易被写成通用清单,失去话题特异性。",
      evidenceRefs: ["trend-1"],
    },
    {
      label: "保留争议",
      summary: "把两种做法并列,交由读者判断。",
      audienceFit: "已有判断的读者",
      risks: "可能被认为没有结论。",
      evidenceRefs: [],
    },
  ],
  risks: ["话题证据样本量偏小,结论适用范围有限。"],
  avoidAngles: ["重复已有共识清单"],
  evidenceReferences: ["topic-1", "trend-1", "opportunity-1", "rep-1"],
  confidenceNote: "以上只基于本机已采集的证据;机会指数的限制因素指出样本量偏小,请自行核对适用范围。",
};
