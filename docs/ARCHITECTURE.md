# TrendScope 架构（Stage 1：数据底座）

## 1. 分层总览

```
┌─────────────────────────────────────────────────────────────┐
│  React SPA (Vite, :5183)                                     │
│  Dashboard / Import Center / Content Explorer / Detail       │
└──────────────┬──────────────────────────────────────────────┘
               │ /api/* （Vite dev 代理；生产由 Express 托管静态）
┌──────────────▼──────────────────────────────────────────────┐
│  Express API (:5184)                                         │
│  /stats /content /content/:id /import/* /fixtures            │
├──────────────────────────────────────────────────────────────┤
│  Services                                                    │
│  importService（管道）   queryService（查询）  statsService   │
├──────────────────────────────────────────────────────────────┤
│  Adapters   SourceAdapter 接口                               │
│  CSVAdapter · JSONAdapter · ManualAdapter · FixtureAdapter   │
│  （未来：DouyinApiAdapter / XiaohongshuPlaywrightAdapter …）  │
├──────────────────────────────────────────────────────────────┤
│  Domain（纯函数，零 IO）                                      │
│  constants · zod · dates · numbers · url · fingerprint ·     │
│  quality                                                     │
├──────────────────────────────────────────────────────────────┤
│  SQLite (better-sqlite3, WAL) + Drizzle ORM                  │
│  raw_records → content_items → content_metric_snapshots      │
│  import_batches（血缘）                                       │
└──────────────────────────────────────────────────────────────┘
```

借鉴来源：多源适配器接口取自 NewsNow（github.com/newsnext/newsnow）的
`defineSource` 模式；Raw/Normalized 分层取自 Medallion 架构（Bronze/Silver/Gold）
在 dlt/DuckDB/dbt 实践中的形态；append-only 指标时序取自时序快照类采集项目的通行
做法（如 bitpulse/github-data 的 timeseries 思路）；统一 schema + 唯一约束去重参考
Social-Media-ETL-Pipeline。

## 2. 数据模型

### import_batches（血缘）
每次导入一行：sourceType、platform、started/completedAt、total/successful/
failed/duplicate、status（pending/processing/completed/partial/failed）、
options（字段映射 JSON）。

### raw_records（Bronze，不可变）
sourceType、platform（可为 null）、adapter、importBatchId、**payload（原始 JSON
原文）**、fieldNames、note。标准化失败/校验失败的行也存这里（note 记录原因），
保证"原始输入永不因标准化而丢失"。

### content_items（Silver，标准化态）
- 身份：platform + platformContentId（唯一偏索引）；canonicalUrl（唯一偏索引）；
  fingerprint（普通索引，仅用于标记疑似重复）。
- 内容：contentType、url、authorId/Name、title/text/transcript、hashtags(JSON 数组)、
  publishedAt、collectedAt。
- 最新指标：views/likes/comments/shares/favorites/upvotes/authorFollowers —— 全部
  **可空**，null=未知。
- 质量：dataQuality（complete/partial/minimal/invalid，规则计算见 §4）。
- 溯源：sourceType、rawDataId（创建本条目的原始记录）。

### content_metric_snapshots（时序，append-only）
contentItemId + capturedAt + 六项指标 + source + importBatchId。
索引 (contentItemId, capturedAt)。重新采集只 INSERT，永不 UPDATE。

### 索引清单（spec §18）
- `uq_content_platform_id` (platform, platformContentId) WHERE id IS NOT NULL
- `uq_content_canonical_url` (canonicalUrl) WHERE IS NOT NULL
- publishedAt / collectedAt / authorId / dataQuality / platform / fingerprint
- snapshot: (contentItemId, capturedAt)、capturedAt
- batches: startedAt

## 3. 导入管道（importService）

```
row → validateRaw（廉价结构检查，失败仍存 raw + note）
    → normalize（映射 → 清洗 → 类型收敛 → Zod 闸门；抛错=失败行，raw 保留）
    → canonicalizeUrl（中心化，幂等）
    → 去重判定：
        a. platform + platformContentId 命中 → duplicate 分支
        b. canonicalUrl 命中                → duplicate 分支
        c. fingerprint 命中（且 a/b 未命中） → 仅标记 possibleDuplicateOf，照常入库
    → 新条目：事务内 raw → item（质量已按规则计算）→ 首个快照
    → 已有条目：事务内 新 raw → 新快照 → 更新 item
```

**duplicate 分支的更新规则（spec §17 + Stage 2 §2）**
- latest metrics：新值非 null 才覆盖（null 表示本次未采集，保留旧值）
- publishedAt / title / text / url / canonicalUrl：仅 fill-if-null（COALESCE），
  永不覆盖已有值
- contentType：仅当旧值为 unknown 时升级
- collectedAt / updatedAt：刷新
- **同批快照去重**：同一 ImportBatch 内同一 item + 六项指标完全一致 → 不再追加
  snapshot；跨批/指标变化 → 永远追加（"指标未增长"本身是有效时序观察）
- 历史快照：不动

**行隔离**：单行失败（校验/标准化/DB 约束）只影响该行，计入 failedRecords，
raw 照存（含 rowIndex），批次状态变 partial/failed；整批事务不回滚。

**批次状态**：failed=0 → completed；0<failed<total → partial；全部失败 → failed；
致命错误（超限）→ markBatchFailed。

## 3.5 去重治理（Stage 2 §11-15）

- 确定性去重（platform+id / canonicalUrl）仍在管道内自动执行。
- fingerprint 命中 → 生成 `duplicate_candidates`（pending），**永不自动合并**。
- 人工 Confirm（Duplicate Review UI）：A=canonical，B 写
  `mergedIntoContentItemId`（不物理删除）；B 的 snapshots 迁移到 A（capturedAt
  保留）；fill-if-null 补全 A；写 `duplicate_merge_records` 审计（undo-friendly）；
  RawRecord 全部原样保留。Not Duplicate / Ignore 仅改候选状态。
- merged 源条目从列表与 FTS 检索中排除，但 Detail 可通过指针访问（含其原始记录）。

## 3.6 FTS5 检索（Stage 2 §6-10）

- 虚表：`fts_documents(title, body, author, tags) tokenize='unicode61'`，
  迁移 `drizzle/0002_fts.sql` 创建；启动时 `ensureFtsBackfilled()` 幂等回填
  （数量对账后 rebuild），Stage 1 库无缝升级。
- **同步策略：application-layer sync**（选择理由：需要在索引时做值变换，
  trigger 无法表达）。每个 create/update/merge 路径调用
  `syncItemAfterWrite`；重建走 `rebuildFts`。
- **中文检索**：写入与查询两侧做 CJK 单字间空格展开（bigram 思路），
  unicode61 词元下用短语匹配实现中文子串检索；ASCII 词尾加 `*` 前缀匹配。
- 查询安全：MATCH 参数化绑定；用户输入剥离 FTS 语法字符后逐词加引号 →
  无注入面；MATCH 语法错误时 catch 并回退 LIKE（响应带 mode 标识）。
- 排序：默认 BM25（`bm25(fts_documents)` 升序 = 相关度降序），仍支持
  publishedAt/collectedAt/likes/comments 等列排序；高亮用 `snippet()`，
  前端以纯文本分段渲染 `[...]` 标记（无 innerHTML）。

## 4. 数据质量规则（确定性代码，spec §9）

- invalid：无 platform；或有身份但完全无 body（title/text/transcript 全空）
- minimal：有 platform + body，且无 id、无 url、无日期、无作者、无任何指标
- partial：core + 至少一项可观测信息，但未满 complete
- complete：id + body + publishedAt + author + ≥1 指标

## 5. 关键归一化策略

- **时区（Stage 2）**：所有入库时间统一为 UTC。字符串自带显式 offset
  （Z / +08:00 / ±HHMM）→ 尊重原始 offset（assumption=explicit_offset）；
  真正 timezone-naive 的字符串按 **sourceTimezone** 解释
  （adapter_default / user_selected），中国平台默认 Asia/Shanghai，CSV/JSON
  在导入映射中选择，manual 表单选择；完全未声明时区 → UTC 兜底但标记
  assumption=unknown。零依赖实现：Intl.DateTimeFormat 计算 IANA 偏移
  （含 DST 区）。provenance（rawPublishedAt / publishedTz /
  publishedTzAssumption）随 ContentItem 持久化，RawRecord 仍是原始事实来源。
- **数值**：支持 `1.2万 / 3.5亿 / 1,234 / 2300次 / +88`；`"N/A"/"-"/"未知"` → null；
  真实 `"0"` → 0。负数视为无效 → null。
- **平台**：行内平台值优先（中英文别名映射）；用户选择的"平台兜底"仅在行内缺失/
  无法识别时生效。因此选择了兜底后，未知平台行不会被错误拒绝。
- **URL**：仅去除已知 tracking 参数白名单（utm_*/fbclid/spm/xsec_token/…），
  保留内容定位参数；小写 host、去默认端口/fragment/尾斜杠。禁止过度归一化。
- **contentType**：显式映射 > 中文别名 > URL 形状推断（/video/、/question/ 等），
  推断不出 → unknown。

## 6. Adapter 契约（未来平台接入点）

```ts
interface SourceAdapter {
  id: string;
  getSourceType(): SourceType;
  validateRaw(input: unknown): { ok: boolean; error?: string };
  normalize(input: unknown, ctx: NormalizeContext): NormalizedRecord; // Zod 闸门
}
```

新增真实平台（Douyin API / Playwright 等）只需实现该接口并在 routes 注册，
管道/去重/快照/质量全部复用。CSV/JSON 的字段映射（`mapping`：canonical → 源列）
与自动检测（中英文别名打分）由 fieldMapping.ts 提供。

## 7. 前端

- 4 页：Dashboard（壳）/ Import Center / Content Explorer / Content Detail。
- 数据层为轻量 fetch 封装（`src/lib/api.ts`），错误统一转可读 Error。
- null 一律渲染 `—`（等宽、弱化色），0 渲染 `0`。
- 全局 ErrorBoundary + API 错误横幅 → 不白屏。
- 设计系统：Industrial/utilitarian（IBM Plex Sans/Mono、amber 强调、发丝线、
  图章式徽章），动效仅透明度过渡（稳定优先）。

## 8. 安全与稳定（spec §27）

- 上传 ≤ 10MB、单批 ≤ 10,000 条（前端 + 服务端双重校验）。
- UTF-8 有效性检查、空文件/空表头/无数据行明确报错。
- 全部 API 返回结构化 JSON 错误；服务器兜底错误中间件；前端 ErrorBoundary。
- 预检上传缓存（内存，15 分钟 TTL）避免二次传文件。

## 9. 评分层(Stage 7)

```
server/src/scoring/
  profiles.ts        全部权重/阈值(CONTENT_BURST_V1 / TOPIC_TREND_V1 / LIFECYCLE),集中配置
  percentile.ts      mean-rank 百分位 / median / stddev / 增长比映射(纯函数)
  cohort.ts          发布年龄桶 + 四级 cohort 回退梯子(exact→platform_only→insufficient)
  metricProfile.ts   平台指标语义(zhihu: upvotes 主互动;复用 trendService 动量权重,单一事实来源)
  creatorBaseline.ts 作者历史互动总量(null≠0;中位思想)
  confidence.ts      确定性置信度扣分表(单快照/跨度/cohort/可用信号/作者历史)
  contentBurst.ts    Layer 2:五组件 + missing-aware 重归一 + unscorable 三态 + evidence
  topicTrend.ts      Layer 3:五组件(只用 Topic/TopicSnapshot/ContentScore/MetricSnapshot)
  lifecycle.ts       Layer 4:决策树(6 态+unknown);滞回在 service 状态机
  repository.ts      append-only 快照 + current 缓存(upsert)+ SQL 排序分页查询
  service.ts         批量 Run 编排(内容 → 话题顺序硬约束;Clock 注入;小事务)
```

- 数据流:MetricSnapshot → cohort 分布 → Burst Score →(先跑内容)→ Topic Trend
  → Lifecycle 状态机 → topic_lifecycle_events。
- 表:scoring_runs / content_score_snapshots(append-only)/ content_score_current
  (latest 缓存,冗余 platform/topic 供 SQL 排序)/ topic_trend_snapshots(append-only)/
  topic_score_current(latest + pending 滞回态)/ topic_lifecycle_events(append-only)。
  迁移 0008,真机原地应用。
- 确定性:Clock 注入、无 LLM、configSnapshot 落 run——同输入同输出(§CD)。
- 模型语义与校准路径:docs/SCORING_MODEL.md。

## 10. 内容情报层(Stage 8)

```
server/src/intelligence/
  profiles.ts        VIRAL_PATTERN_V1 / SATURATION_V1 / NOVELTY_V1 / ANGLE_TEXT_V1 集中配置
  features.ts        17 个确定性中文特征(问句/金额/地区/身份/清单/强标点……)
  semanticFeatures.ts 语义特征 Zod Schema + RuleBased 恒可用 + 可选 OpenAI-compatible
  angleText.ts       AngleTextBuilder V1(标题/首句主导,弱化正文)
  viralPattern.ts    爆发组(Burst≥80)vs 匹配控制组五级梯子 → Lift(零命中平滑)
  saturation.ts      五组件(规模/频率/角度相似/重复率/修正 HHI)+ 近 300 条上限
  novelty.ts         角度簇连通分量 + 历史调和(稳定 ID/人工命名)+ Emerging 判定
  repository.ts      feature 缓存/append-only 结果/角度簇持久化/SQL 列表
  service.ts         runIntelligence 编排(时钟注入;特征 textHash 缓存)
```

- 数据流:Burst Score → 爆发组/控制组 → 特征 Lift(pattern_results,append-only);
  AngleText → 词法角度向量 → 饱和度(快照)+ 角度簇(持久化调和)+ 新颖度(快照)。
- 表(0009):intelligence_runs / content_feature_records(textHash+版本缓存)/
  pattern_results / topic_saturation_snapshots / topic_novelty_snapshots(append-only)/
  topic_angle_clusters(持久化调和)/ topic_intelligence_current(SQL 列表缓存)。
- 红线:观察到的关联 ≠ 因果(§17);饱和只给档位不给"不要做"(§41);
  无 LLM 自由文本结论(§10-§13)。模型全解:docs/CONTENT_INTELLIGENCE.md。

## 11. Stage 9.5 收口层（2026-09-27）

```
src/lib/useResource.ts          取数唯一入口:AbortController + 请求代次双保险、
                                  initialLoading/refreshing 分离、reload/setData、
                                  useDebounced(仅搜索框)、buildQuery、resetOnPathChange
src/components/RequestState.tsx 统一错误横幅 + 重试 / 轻量"正在更新"提示
src/components/TrendBreakdown.tsx 趋势分解唯一实现(趋势中心展开区 + 话题详情共用)
server/src/opportunity/profileStore.ts
                                  Profile 治理唯一入口:Zod 闸门、权重归一化、版本化、
                                  激活/归档、用量统计、版本 diff;无"改旧版本"的写路径
server/src/scoring/topicTrend.ts  buildTrendBreakdown():组件分 + 有效权重 + 关键证据 + 不可用原因
drizzle/0011_*.sql                opportunity_profiles(当前模型唯一由部分唯一索引保证)
drizzle/0012_*.sql                topic_trend_snapshots / topic_score_current 各补两列
```

三条硬约束：

1. **前端不算分**。任何 breakdown / 有效权重都来自服务端下发；旧 Run 没记录时显示"未记录"，
   不用当前权重复算冒充（与 null ≠ 0 同一条红线）。
2. **历史版本 immutable**。快照引用的 Profile 版本不可原地修改；编辑 = 另存新版本；
   切换当前模型只影响之后的新 Run；归档代替删除。
3. **计时断言必须可复现**。vitest 串行执行（D27）；性能预算靠等价优化赢得，
   不靠放宽阈值（`buildEdges` 输出用边集校验和锁死逐位不变）。
