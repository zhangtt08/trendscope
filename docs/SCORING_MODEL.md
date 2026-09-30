# SCORING MODEL — 内容爆发指数 / 话题趋势指数 / 生命周期(Stage 7)

> 面向产品与工程的完整解释:分数怎么算、什么时候不可靠、缺数据会怎样、以后怎么校准。
> 一句话定位:**这是对"已观察到的数据"的异常度量化,不是爆款预测**。UI 全部文案
> 遵守该红线(禁:爆款预测/爆火概率/预计会火/成功率)。

---

## 1. 分层总览

```
MetricSnapshot(append-only 时序)
   ↓ Layer 1  Content Cohort(把内容放进"合理可比较的一组")
   ↓ Layer 2  Content Burst Score  内容爆发指数(0-100,CONTENT_BURST_V1)
   ↓ Layer 3  Topic Trend Score    话题趋势指数(0-100,TOPIC_TREND_V1)
   ↓ Layer 4  Topic Lifecycle      生命周期(新兴/上升/高位/饱和/下降/常青/数据不足)
```

顺序是硬约束:话题趋势依赖成员的爆发指数(爆发密度组件),必须先跑内容评分。
全部确定性:同数据库 + 同 configSnapshot + 同当前时间 → 逐位相同的结果;
Clock 可注入,测试不依赖真实时间。无任何 LLM 参与。

## 2. Content Cohort(Layer 1)

**为什么**:点赞 1000 对 6 小时的小账号可能是爆发,对 7 天的大账号可能平平。
比较必须发生在"合理同组"内。

- 分桶维度:平台 + 内容类型 + **发布年龄桶**(0-6h / 6-24h / 1-3d / 3-7d /
  7-30d / 30d+;发布时间未知单独成"unknown"桶,不与已知年龄混桶)。
- **回退梯子**(样本不足逐级放宽,防"N=4 却显示 96.7 分位"的假精确):
  1. 平台+类型+年龄+话题(exact)
  2. 平台+类型+年龄(broadened_once)
  3. 平台+年龄(broadened_twice)
  4. 平台(platform_only)
  第一个样本量 ≥30 的级别即停;都不足 30 用平台级(样本 ≥5);
  平台级 <5 → 该内容 **insufficient_cohort(数据不足,不评分)**。
- 每次评分都记录:最终 cohort 级别 / 样本量 / sampleQuality,随 evidence 落库。

## 3. Content Burst Score(Layer 2,权重即公式)

| 组件 | 权重 | 怎么算 | 缺失时 |
| --- | --- | --- | --- |
| 互动增速 Velocity | 35% | 观察窗口(6h/24h/72h/7d)内平台加权动量增量 ÷ 小时数,在 cohort 的百分位。主窗口 24h,不足回退 72h→7d | 未知,权重重归一 |
| 触达 Reach | 20% | 最新 views 在 cohort 的百分位 | 未知(知乎多数内容无 views,**不因此压分**) |
| 互动质量 EQ | 20% | 深互动(评论+分享+收藏)÷ 全部互动;要求全部深互动已知 | 未知 |
| 相对表现 | 15% | 作者历史 ≥5 条 → 当前互动总量在**作者历史(中位思想)**的百分位;否则同组百分位 | 未知 |
| 互动结构 | 10% | 各互动分量(赞/评/分享/收藏)百分位均值 | 未知 |

- **Missing-aware(红线 null≠0)**:缺失组件不按 0,而是把剩余权重按原比例
  重归一(如 35/20/20/15/10 缺 Reach → 35/25/18.75/12.5×归一),同时置信度下降。
- **不可评分(unscorable)优先级**:无快照 → `insufficient_snapshots`;
  有快照但无任何可算信号(如知乎热榜全 null 指标)→ `insufficient_metrics`;
  cohort 样本不足 → `insufficient_cohort`。UI 一律显示"数据不足",**绝不显示 0 分**。
- **置信度**(high ≥0.75 / medium ≥0.45 / low):base 1.0 扣减——单快照 −0.3
  (无速度证据,§Z 明确:只有一个 snapshot 不能给 high)、观察跨度 <1h −0.1、
  cohort<30 −0.1 / <10 −0.2(取大不叠加)、可用信号 ≤50% −0.15、
  作者历史不足 −0.05。扣分原因逐条落 evidence,UI 可解释。
- **证据(evidence)**:四个窗口的动量增量/跨度/每小时动量、cohort key/级别/样本量、
  creator basis、缺失组件清单,全部随快照落库——"为什么是 87 分"永远可回答。

## 4. Topic Trend Score(Layer 3)

只基于已有数据(Topic / TopicMembership / TopicSnapshot / ContentScore /
MetricSnapshot);禁止 LLM 看描述猜趋势。

| 组件 | 权重 | 怎么算 |
| --- | --- | --- |
| 内容增长 | 35% | 当前 7 天窗口新增内容 vs 基准(前 7 天;基准窗口无快照 → 更早全历史中位)。映射 100·r/(r+1):持平=50,4 倍=80 |
| 互动增长 | 25% | TopicSnapshot 平台加权平均动量(当前窗口均值 vs 基准)。**不把知乎赞同与抖音点赞原值相加**——动量权重即平台归一化 |
| 创作者增长 | 15% | activeCreatorCount 当前 vs 基准(快照缺失时用成员加入时间的去重作者数兜底) |
| 爆发密度 | 15% | 成员中爆发指数 ≥80 的占比;映射 min(100, 100·占比/0.3) |
| 加速度 | 10% | 二阶变化 = 当前窗口新增 − 基准窗口新增;映射 50+50·clamp(accel/max(基准,3), −1, 1) |

- **单条爆款防误判(§CA)**:一个话题 1 条 95 分 + 19 条 40 分 → 爆发密度仅 5%
  (密度分 ~17),内容/创作者/加速度全平 → 总分 ~45,**不会**因为一条超级内容
  拉成"高趋势话题"。这是专项 fixture 验证的。
- 不可评分:成员 <3 → `insufficient_members`;无任何可算组件 → `insufficient_snapshots`。
- 置信度:成员 <10 −0.15;TopicSnapshot <3 −0.15;成员爆发分覆盖率 ≤50% −0.2。
- 基础饱和代理(v1 proxy):创作者集中度(最大作者占比)+ 增长趋平
  (当前/基准 ≤1.2 且仍有新增)。仅供 lifecycle 参考,标"初步饱和判断";
  真正的角度相似度饱和属 Stage 9。

## 5. Topic Lifecycle(Layer 4)

**与 Topic.status 是两个概念**:status(active/needs_review/inactive/archived)
是治理状态;lifecycle 是趋势阶段。互不影响。

| 状态 | 中文 | 判定要点(决策树按序) |
| --- | --- | --- |
| unknown | 数据不足 | 无趋势分 / 成员 <3 —— 不硬造阶段 |
| declining | 下降 | 近期零新增且基准 ≥3,或连续 2 次低分观察(单日波动不判死) |
| emerging | 新兴 | 话题年龄 ≤3 天 + 近窗口有新增 + 成员 ≤30 |
| peak | 高位 | 成员 ≥20 + 爆发密度 ≥25% + 趋势分 ≥70(高热度,**不解释为即将下降**) |
| rising | 上升 | 趋势分 ≥60 + 内容增长为正 + 创作者增长非负 + 加速度未转负 |
| saturated | 饱和 | 成员 ≥30 + 新增/基准在 0.4–1.6(趋平)+ 密度 <25%(初步饱和判断) |
| evergreen | 常青 | 年龄 ≥30 天 + 趋势分波动 ≤8(低波动稳定内容流) |
| 兜底 | — | 创作者退潮/增长平淡 → 保守归 saturated;否则趋势分 ≥55 且无衰退证据 → rising;再否则 evergreen |

**滞回(Hysteresis,防来回跳)**:阶段切换需 **连续 2 次观察一致**,或趋势分
**强突破(Δ≥25)**免等待。pending 状态持久化在 `topic_score_current`
(pending_lifecycle / pending_count);每次真实迁移写 `topic_lifecycle_events`
(from/to/分数/reason/版本,append-only)。单次异常波动只进 pending,不翻转。

## 6. 版本化与可追溯

- 每次评分 Run(scoring_runs)保存 `score_version` + `configSnapshot`
  (全部权重/阈值 JSON)——改公式后旧分数仍可解释。
- 快照三张表 append-only:content_score_snapshots / topic_trend_snapshots /
  topic_lifecycle_events;`*_current` 表只是"最新值缓存"(SQL 排序分页用),
  历史永不覆盖。
- 权重/阈值集中在 `server/src/scoring/profiles.ts`;调整必须:改 profile →
  bump version → 记 DECISIONS → 重跑(旧分数保留)。

## 7. 什么时候不可靠(诚实清单)

1. **单次快照**:无速度证据,置信度必然 ≤medium。
2. **cohort 小**:样本 <30 时比较基准偏弱;<5 直接不评分。
3. **指标缺失多**:可用信号 ≤50% 会显著降置信;EQ 需要全部深互动已知。
4. **观察跨度短**:24h 窗口需要窗口内 ≥2 次快照;跨度 <1h 额外降置信。
5. **跨平台话题**:互动增长用平台加权动量,混合平台话题的动量均值是
   "加权混音",evidence 保留平台分布供核查。
6. **词法基线话题**:无 EMBEDDING 凭证时话题来自词法聚类,趋势引擎照常工作,
   但话题质量本身是词法基线(UI 如实标注,不声称语义质量)。
7. 数据库内容多为 fixture/replay 时,Dry Run 结论标注 **FUNCTIONAL DRY RUN,
   NOT REAL MARKET CONCLUSION**。

## 8. 校准路径

- 权重是设计初始值。积累真实数据后:用 eval:scoring 的 fixture 基线 +
  真实回放对比,调整 `profiles.ts` 并 bump 版本。
- Velocity 窗口偏好(当前 24h 优先)可按平台内容生命周期分平台配置。
- 饱和代理 Stage 9 升级为角度相似度饱和(6B 的向量基础设施已就绪)。
