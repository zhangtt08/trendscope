# OPPORTUNITY MODEL — 选题机会指数(Stage 9)

> 面向产品与工程的完整解释。一句话定位:**机会指数 = 基于当前已观察到的内容增长、
> 异常爆发表现、新颖度、内容空间与历史阶段,对一个 Topic 当前"值得进一步研究"的
> 程度进行结构化量化。它不是未来结果概率,不构成选题建议。**

禁用词(全 UI 扫描零命中):爆款概率 / 成功率 / 一定会火 / 推荐你做 / 最佳选题 / 必做 / 稳赢 / 系统推荐。

## 1. 只消费既有引擎(§49)

Opportunity Engine **不重算**任何下层指标,只读各引擎 Current 快照:

```
topic_score_current(Stage 7:趋势/生命周期/爆发密度)      → Trend Strength + Lifecycle Fit
content_score_current(成员爆发分布)                       → Burst Opportunity
topic_intelligence_current(Stage 8:新颖度/饱和度)        → Novelty + Whitespace
pattern_results(Stage 8:爆发共性)                        → Pattern Strength
```

依赖不存在 → 对应组件 unknown(missing-aware),不默默用 0 算;核心证据全缺 → unscorable(数据不足)。

## 2. 六组件(TOPIC_OPPORTUNITY_V1,Balanced 默认)

| 组件 | 权重 | 来源与算法 |
| --- | --- | --- |
| Trend Strength | 30% | 直接消费 Stage 7 Topic Trend Score(不重算,§7) |
| Burst Opportunity | 20% | 50% 爆发密度 + 30% 成员爆发 P75 + 20% 近 7 天爆发数(§8:密度/分位数天然稀释单条爆款,F fixture 验证"趋势 92 但单爆款"不排第一) |
| Novelty | 15% | Stage 8 话题新颖度 + 新兴角度计数(高新颖 ≠ 自动高机会,§9) |
| Whitespace | 15% | 100 − 饱和度;**饱和 unscorable → Whitespace unknown,绝不 100**(§10,fixture I 验证) |
| Pattern Strength | 10% | 高/中证据共性数量 × 效应量封顶(§12:禁 max-lift→100);无 pattern 行 → unknown |
| Lifecycle Fit | 10% | 透明映射:新兴 65 / 上升 85 / 高位 70 / 饱和 45 / 下降 25 / 常青 55 / 数据不足 unknown(§13,值集中 OpportunityProfile;饱和≠0,§14) |

**Missing-aware(§15)**:组件 unknown → 其余权重按原比例重归一(总和恒=1,fixture §64 验证),同时置信度下降。**最低证据门**(§23):可用组件 ≥3 且必须有 Trend 或 Novelty 之一,否则 unscorable。

## 3. Confidence 与 Score 独立(§16)

数据更多**不会**让分数更高,只让置信更高。置信度因子:各上游置信度保守平均、
成员数 <10(−0.2)、词法基线(−0.1,§18:不影响数值归零,只降置信并标注)、
爆发覆盖率低(−0.1)、**新鲜度政策**(§50/§51:趋势 >24h 或情报 >48h → STALE_TREND /
STALE_INTELLIGENCE,各 −0.1;freshness 集中在 profile,不散落 Date.now)。
输出 high/medium/low + reasons(§17,例:"话题只有 6 个成员"/"角度分析仅为词法基线")。

## 4. Reason Codes(§25/§26)

内部 code(HIGH_TREND / RISING_LIFECYCLE / EMERGING_ANGLES / LOW_SATURATION /
HIGH_SATURATION / STRONG_BURST_DENSITY / CLEAR_VIRAL_PATTERNS /
PATTERN_SAMPLE_INSUFFICIENT / LOW_TOPIC_HISTORY / LEXICAL_BASELINE_ONLY /
STALE_TREND / STALE_INTELLIGENCE / NO_CORE_EVIDENCE / INSUFFICIENT_COMPONENTS),
UI 映射自然中文("近期增长明显"式表述);分为**正向信号**与**限制因素**两组展示(§24)。

## 5. Opportunity Level(§27/§80)

只是分数区间显示:70–100 较高机会 / 40–69 中等机会 / 0–39 较低机会(阈值集中配置)。
不是推荐等级;UI 全程无"推荐/必做"。

## 6. Delta 与 Why Changed(§41-§43)

每次 Run 与上一 snapshot 比较:ΔOpportunity 存 current;**whyChanged = 六组件
贡献差的确定性 Top 分解**(如 +12 = 趋势 +8、新颖度 +5、饱和 −2,fixture 验证),
无 LLM。工作台支持按"近期提升"排序(§43:名称是"机会指数近期提升",不是"马上会爆")。

## 7. 人工决策(§36-§38)

opportunity_decisions(shortlisted / reviewing / dismissed / none)与 TopicWatch
分离;**决策不影响分数**(fixture 验证:dismissed 后分数不变);带 note 审计。

## 8. Profiles(§55-§58)

- **Balanced(默认)**:上述权重。
- **Early Discovery**:偏重新颖(.25)/内容空间(.20)/趋势(.25),轻绝对规模。
  UI 明确标注"只是分析偏好,不是算法更准确"。
- Snapshot 保存 profileId + profileVersion;每次 Run 落 configSnapshot。
  调整权重必须 bump 版本 + 记 DECISIONS;**禁止为 fixture 调参**(§67)。

## 9. 编排(§52-§54)

机会分析按钮按序复用现有 API:内容评分 → 趋势 → 情报 → 机会
(/api/analysis/full-refresh 为 Orchestrator,不拥有业务逻辑)。依赖缺失时 UI
提示先运行对应评分,不默默计算。

## 10. 什么时候不可靠(诚实清单)

1. 成员少 / 快照少 → 置信度低(分数照常,但别单独依赖它)。
2. 词法基线话题:话题与角度均为词法聚类,升级语义向量前置信度打折。
3. Pattern 样本不足 → Pattern Strength unknown,机会指数偏"趋势+新颖+空间"。
4. 输入过期(STALE)→ 置信下降;先重跑对应引擎。
5. 真机库大量 fixture 数据时,一切结论标注 FUNCTIONAL DRY RUN /
   NOT REAL CONTENT RECOMMENDATION(§68/§69),Top 榜不称"最值得做"。
