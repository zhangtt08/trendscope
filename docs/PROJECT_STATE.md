# PROJECT_STATE

> 每完成一个明显工作单元更新本文件。

## 当前 Stage

**Release 1.0 —— 正式发布(已完成)**。五个交付包全部完成:AI 选题工作室(WP1)、完整产品工作流(WP2)、
安装/启动/数据库安全(WP3)、全产品 Bug Sweep(WP4)、发布交付(WP5)。版本号统一为 `1.0.0`,
发布闸门 `npm run verify:release`。当前基线见 `docs/RELEASE_NOTES_1.0.md`,更新记录见根目录 `CHANGELOG.md`。
> 情报模型全解:docs/CONTENT_INTELLIGENCE.md;Stage 7 模型:docs/SCORING_MODEL.md。

## 2026-09-30 (十) 搬到新机器后的复验(本机实测,不引用上一台机器的结论)

- [x] 门禁全绿:`typecheck` 0 错误 · `npm test` **720/63 文件**(154.58s) · `build` PASS ·
      `verify:release` **14 通过 / 0 跳过 / 0 失败** · eval 四项与冻结值逐字一致 · `check:responsive` 42 次渲染无溢出
- [x] 修掉一个空跑的检查:`check:responsive` 只认 Chrome 路径,本机只有 Edge → 直接退出。它不在 14 项闸门里,
      所以闸门全绿时没人发觉这项检查没执行。按 `browserPage.ts` 既有口径补 `chrome → msedge` 回退
- [x] 本机缺上一台机器的 BGE-M3 向量服务(权重不在本机):按使用者决定清空 `EMBEDDING_*` 退回词法基线,
      激活空间切到词法;3,923 条语义向量留在历史空间(D9 不物理删除)
- [x] 真机功能:调度器自己采到新内容(3,921→4,045)、自动补齐词法向量 4,044 条、
      **一键全分析 run 453 六步全部 completed**(269 活跃话题 / 8,800 已评分 / 291 趋势 / 121 机会)、
      15 个路由 0 控制台报错、交付副本 exe PrintWindow 抓到真实窗口
- [x] 数据库:先 `npm run db:backup` 得到逐项一致的 1,041,104,896 bytes 备份(本机此前零备份),
      再按使用者指示删 `content_score_snapshots`(546,001 行 / 787 MB)+ VACUUM → **1,017 MB → 185 MB**,
      其余表行数逐项未变、integrity ok。代价:内容详情的爆发历史从 6 天变 0 点,下轮评分起重新累积
- [x] 交付包 `DesktopTrendScope-1.0.0`:304 MB(源目录含 1 GB 备份时约 1.45 GB),
      `npm prune --omit=dev` 后 node_modules 106 MB;新增 `PREBUILT.txt` + 启动器判定让交付包跳过构建,
      双击路线已实测可用。明细见 docs/TEST_STATUS.md 第 (十) 轮

## Stage 9.5 完成内容(2026-09-27)

## Stage 9.5 完成内容(2026-09-27)

- [x] **环境解锁**:新机器(`C:\Users\EDY\Desktop\trendscope`)上 `npm test` 因 better-sqlite3 12.11.1
      的原生退出期 abort 根本跑不完(11/31 文件崩、结果不落盘)。依赖收紧 `~12.10.1` → 426/426 复现。D23
- [x] **目标一 请求可靠性层**:唯一 hook `src/lib/useResource.ts`(abort + 代次守卫双保险、
      initialLoading/refreshing 分离、reload/setData、`useDebounced`、`buildQuery`、
      `resetOnPathChange` 实体级 stale);`api.ts` 放行 AbortError(§10 abort 不算错误);
      统一错误 UI `components/RequestState.tsx`。**迁移 7 个页面**:选题机会 / 趋势中心(话题趋势展开区、
      内容爆发榜、动量榜双请求)/ 话题(含 5s 轮询与详情)/ 内容候选工作台 / 内容浏览器 /
      采集中心 Runs 标签 / 重复治理。mutation 不塞进 hook,成功后 `reload()`,无 `window.location.reload`
- [x] **目标二 Profile 治理**:0011 迁移 `opportunity_profiles`(key/name/description/version/status/
      is_active/四组参数 JSON/tuning/lineage/时间戳);部分唯一索引保证"当前模型只有一个";
      `opportunity/profileStore.ts`(Zod 闸门 + 权重归一化 + 版本化 + 激活/归档 + 用量 + diff);
      引擎改吃 Active Profile(`resolveActiveProfile`/`resolveProfileByKey`,保留内置回退);
      API 5 端点 + `PATCH → 409`;新页 **11 机会模型**(基础/高级折叠、差异预览、防双击、中文)
- [x] **目标三 趋势可解释**:引擎补 `reason` → `buildTrendBreakdown` 产出组件分解 + 有效权重 + 关键证据;
      0012 迁移给 `topic_trend_snapshots` / `topic_score_current` 补两列并随 Run 落库;
      `/api/topics/:id/trend` 新增 `detail`(overallScore/lifecycle/五组件/effectiveWeights/
      unavailableReasons/breakdownRecorded);共享组件 `components/TrendBreakdown.tsx` 同时供
      趋势中心展开区与话题详情使用,**删掉话题页那份写死权重**;爆发卡与机会详情补有效权重可见性
- [x] **性能**:`buildEdges` 5000×512 由 22.5s → 9.9–10.7s(输出逐位一致,已用边集校验和证明)
- [x] **测试**:44 例新增(11 hook + 14 profile 契约 + 8 profile UI + 7 trend 契约/引擎 + 4 展示),
      原 426 例一例未删、一例未改弱;`fileParallelism:false` 让计时断言稳定
- [x] **真机**:备份 → 0011/0012 原地迁移零丢失 → full-refresh 200 → 分解/有效权重/版本真实渲染
      → AUDIT_TEMP 建版本+归档(正式模型未受影响) → 13 路由 + 411px 走查 → checkpoint

## Stage 9.5 修掉的真实缺陷(择要,全表见 TEST_STATUS)

1. Import Center 四个按钮 `void doImport` 少括号 → 点击无效(预检/CSV 导入/JSON 导入/手动添加);
   重复治理页刷新与"合并后重载"同样失效 —— 均为 tsc 抓不到的正则事故残留。
2. `topic_score_current` upsert 的 set 列表漏 `components_json`/`effective_weights_json`
   → 同一话题第二次评分后分解永远 NULL(只有重跑才暴露,首插看不出)。
3. 411px 全站横向溢出(grid 子项 `min-width:auto` 让表格撑破页面,`.table-wrap` 永不滚动)。
4. 话题趋势区/未归类视图把请求失败渲染成"没有评分"/"全部已归题" —— 把未知当结论。

## Stage 8 完成内容(2026-09-25)

- [x] Engine A Viral Pattern:爆发组=Burst≥80(集中配置);匹配控制组五级梯子
      (exact→platform_global 标注);minViral=8/minControl=15,不足=insufficient_data;
      17 个确定性中文特征 + RuleBased 语义特征(Zod Schema)+ 可选 AI 抽取器
      (凭证缺失标 unavailable);Lift 零命中 add-1 平滑(D16);连续特征 median+IQR;
      证据质量分级排序(§26);负向模式展示(§27)
- [x] Engine B Saturation:五组件(20 规模/20 频率/25 角度相似/20 重复率/15 集中度);
      AngleText V1(标题主导)+ 词法角度基线(D18);修正 HHI;话题内角度分析
      最近 300 条上限(§32 防爆炸);unscorable 诚实;低/中/高档,绝不"不要做"
- [x] Engine C Novelty:话题内角度簇(连通分量 0.6)+ 历史调和(质心 ≥0.6 继承
      稳定 ID/firstObservedAt/人工命名,D19);Emerging 三条件(近 7 天出现+成员 ≥3
      +与历史 <0.5);新颖度 4 因子;噪声护栏(1 条离群不成角度)
- [x] 基建:0009 迁移 7 表(intelligence_runs/content_feature_records(缓存)/
      pattern_results/saturation+novelty snapshots(append-only)/topic_angle_clusters/
      topic_intelligence_current);API 7 端点;趋势列表 saturation/novelty 筛选
- [x] UI:话题洞察面板(饱和/新颖/共性表/角度表+空态 §78);趋势中心饱和+新颖列
      与筛选;工作台话题附饱和/新颖;内容详情特征调试卡(§75);无因果文案(§59)
- [x] 测试:unit 15(特征/平滑/梯子/AngleText/HHI/命名)+ 集成 11(golden §66-§71)
      + perf(5000×500 → 732ms)= +26,总计 351/351
- [x] 真机:备份 → 0009 原地迁移零丢失 → Functional Dry Run(饱和 68 高=诚实;
      pattern insufficient 空态)→ API/UI smoke

### Stage 8 已知非阻塞事项

1. 角度向量为词法基线(D18),EMBEDDING 凭证后可升级语义角度(bump ANGLE_TEXT 版本)。
2. pattern 真实结论需要真实数据积累(爆发组 ≥8 + 控制组 ≥15);fixture 库下为诚实空态。
3. 权重/阈值为设计初始值(profiles.ts 集中),校准须 bump 版本 + 记 DECISIONS。
4. AI 语义特征抽取器已实现(OpenAI-compatible + Zod),凭证到位即启用;无凭证不阻塞。

## Stage 7 完成内容(2026-09-25)

- [x] Layer 1 Cohort:platform+contentType+年龄桶(+topic)四级回退梯子
      (≥30 停 / 平台级兜底 ≥5 / 不足=insufficient_cohort),sampleQuality 落 evidence
- [x] Layer 2 Content Burst(CONTENT_BURST_V1):velocity(窗口 6h/24h/72h/7d,
      动量/小时,主窗 24h 回退)/reach(null 不压分)/EQ(深互动占比,需全知)/
      relative(creator 中位 ≥5 优先,cohort 回退)/structure(分量百分位均值);
      missing-aware 权重重归一 + 置信度扣分表;unscorable 三态
      (insufficient_snapshots/metrics/cohort),绝不 0 分
- [x] Layer 3 Topic Trend(TOPIC_TREND_V1):content/engagement(平台加权,不跨平台
      原值相加)/creator/burst density(≥80 阈值)/acceleration(二阶);
      单条爆款防误判 fixture(1 爆款+19 平淡 → 45 分不升高)
- [x] Layer 4 Lifecycle:新兴/上升/高位/饱和/下降/常青/数据不足;决策树多因子
      (年龄/增长/加速度/趋势分/密度/规模/饱和代理 v1/波动);滞回状态机
      (连续 2 次 or Δ≥25 强突破),pending 持久化,迁移写 topic_lifecycle_events
- [x] 基建:0008 迁移 5 新表(scoring_runs/content_score_snapshots/
      content_score_current/topic_trend_snapshots/topic_score_current/
      topic_lifecycle_events);三张 append-only + 两张 current 缓存(SQL 排序分页);
      scoring_runs 记 configSnapshot(旧分数可解释);Clock 注入,全确定性,无 LLM
- [x] API:/api/scoring/profile|runs|content/run|content/:id|trend/run +
      /api/trends/topics|contents(分页/筛选 lifecycle/confidence/platform/watch/
      minScore)+ /api/topics/:id/trend
- [x] 前端:趋势中心(05 趋势升级,话题趋势默认视图 + 内容爆发视图 + 既有动量榜);
      话题详情趋势区(指数/生命周期/分解/时间线/迁移历史);内容详情爆发卡;
      工作台爆发指数列;全中文徽章(新兴/上升/…/数据不足),无假精确(整数或一位)
- [x] eval:scoring(fixture A-H + 话题 A/C/D/E 明细输出,非只 PASS)
- [x] 测试:27 unit + 12 burst fixture + 10 topic fixture/滞回 + 1 perf
      (5000×500:评分 656ms/125ms,列表 1-3ms)= +50,总计 324/324
- [x] 真机:备份 → 0008 原地迁移零丢失 → Functional Dry Run(12/24 可评,
      unscorable 全部诚实标注;话题 1 emerging trend=50)→ API/UI smoke 全过

### Stage 7 已知非阻塞事项

1. 真实跨平台校准需第二个平台 Connector(D8 权重表已预留)。
2. 饱和代理为 v1(成员增长趋平 + 创作者集中度),角度相似度饱和属 Stage 9。
3. 权重为设计初始值,校准路径见 SCORING_MODEL §8(禁为数据集调参)。
4. momentum 排序仍在 JS(既有 Known Issue;新增的 score/lifecycle 排序已下沉 SQL)。
5. runner 的 lifecycle 首次评定不进 lifecycleTransitions 返回值(事件表里有记录)。

## Stage 6B 接手复验(2026-09-25 上午)

新机器 `C:\Users\Administrator\Desktop\trendscope` 上的完整复验记录:

### 基线复验与一处性能修复

- typecheck 0 错 · build PASS · eval:topics P/R/F1=100% / Noise 14.3% / Cohesion 63.2%
  (与交接记录逐字一致)· smoke:zhihu / smoke:embedding 均 SKIPPED_NO_CREDENTIAL(设计行为)
- **6B 性能测试在本机失败**(5000×512 邻居检索实测 33.3-35.1s > 30s 断言;
  开发机可通过,本机 CPU 较慢):已做**等价优化**修复 ——
  `server/src/topics/clustering.ts` buildEdges 消除内层循环 1250 万次
  `subarray()` 视图分配 + 原向量范数预计算。**输出逐位一致**(临时 bench
  对比 113693 条边 a/b/similarity 全等),1.59× 提速,修后 16.8-24.5s 稳定通过,
  274/274 全绿。未动任何阈值/配置/行为。
- `routes/topics.ts:75-76` 有重复的 `void provider;` 行(无害,未动,待顺手清理)

### 真机验收路径走查(API 层,全部通过)

1. 语义中心→向量化:missing 范围 → total=0/skipped=1(空语义文本条目按 §12
   永不向量化,与 6A 记录一致)
2. 话题分析:runId 5 → 1 话题 / cohesion 100% / unclustered 72%(与交接一致);
   话题 ID 稳定为 1(Reconciler 生效)
3. 话题详情:6 成员 / 快照 append-only / 演化事件 created / 5 次 Run 记录齐全
4. 内容详情:similar top3 同模板 similarity=1.0、elapsedMs=2;embedding-status
   正常;**注意这两个端点挂在 `/api/content/:id/similar|embedding-status` 下,
   不是 /api/embedding 下**
5. 候选工作台:momentum 行带 `topic{id,name,memberCount}`(§44 话题上下文)
6. 治理:watch 生效;rename → 重跑分析 → 手动命名不被覆盖(namingSource=manual,
   §17-20 保证实测成立);move-content 进/出 memberCount 7↔6 正常;
   merge 未在真机测(仅 1 个真实话题,12 例集成测试已覆盖)
7. **走查后真机库已复原**:watch 行已删、话题名已恢复
   「减脂 脂餐 次采」(naming_source=manual,视觉同原);append-only 新增
   2 Run + 2 Snapshot + 1 EmbeddingJob 记账按设计保留

### 新坑(已写入 HANDOFF §6)

9. **Git Bash `curl -d` 发中文 JSON 会写坏数据**(GBK 字节被服务端按 UTF-8
   解析 → 库里存 mojibake,且 UI/对比才发现不了的话看着像"显示问题")。
   带 non-ASCII 的请求一律用 python urllib / `--data-binary @utf8文件`。

**Stage 6A —— 语义层与 Embedding 基础设施(已完成)**

> ContentItem → SemanticText → Embedding → Vector Storage → Similar Content;
> 可追溯 / 可重复 / 可缓存 / 可测试 / 无 API Key 可运行(词法回退)。
> 未做:Topic Clustering / Topic 表 / 任何 Score(§55)。
> Live Smoke:SKIPPED_NO_CREDENTIAL(EMBEDDING_* 未配置);Contract 用 Replay。
> 真机 Dry Run:24 条内容全部向量化(1 条空文本跳过),抽查 10 条 similar
> 全部合理(fixture 同模板 ≈100%、无关内容 <20%),查询 0-4ms。

## Stage 6B 完成内容

- [x] Topic/TopicMembership/TopicAnalysisRun/TopicSnapshot/TopicEvolutionEvent/
      TopicWatch 六表(0007 迁移,真机原地升级;索引名全局唯一已避坑)
- [x] TopicClusteringConfig(§9/§10:lexical/semantic 阈值分离、golden 实测
      校准 lexical=0.3、集中配置无 magic number)
- [x] 图聚类(§7/§8):确定性随机投影 32 维预筛(禁 O(n²))+ 精确 cosine +
      每节点 top-neighborLimit 建边 → 并查集连通分量 → 簇校验
- [x] Cohesion(质心平均 cosine,§14)/Representative(medoid top3,§15)/
      关键词(CJK bigram TF-IDF + 模板词停用表,§16)/三级命名 manual>ai>keyword(§17-20)
- [x] TopicReconciler(§22-26):Jaccard 继承稳定 ID、split/merge 检测、
      inactive 不物理删除;manualLock 人工指派保护(§36)
- [x] Pipeline(§49):missing 空语义文本归 unclustered(§12)不阻塞;
      cancel 边界停止;小事务持久化(§71);qualityMode=lexical_baseline/semantic(§51/52)
- [x] TopicSnapshot append-only(§28-32:newContentCount 明确定义、authorId
      去重、platformDistribution JSON)
- [x] 人工治理(§33-37):重命名(不被自动覆盖)、合并、拆分、移动/移除、watch
- [x] API(§68)+ 话题 UI(§38-48:Explorer 过滤/Detail 可解释性/分析面板/
      未归类视图)+ Similar Content 话题列(§43)+ 候选工作台话题列(§44)
- [x] 测试(§73-77):graph/components/cohesion/representative/reconcile/
      stable ID/manual governance/snapshot/watch/space isolation — 12 例集成
- [x] Golden Eval(§54-61):npm run eval:topics → 6 主题 P/R/F1=100%、
      Noise 14.3%、Cohesion 63.2%(词法基线,产品默认阈值)
- [x] 性能(§64):5000×512 邻居检索+聚类 <30s(投影预筛,非 O(n²))
- [x] 真机 Dry Run(§62/63):FUNCTIONAL DRY RUN — 唯一话题「减脂 脂餐 次采」
      6 成员 cohesion 100%,72% 孤立内容合理归 unclustered

## Stage 6A 完成内容

- [x] SemanticTextBuilder(§2-8):按 contentType 字段规则、优先级去重、
      HTML/实体/空白/标点清洗、hashtag 去重封顶、截断(title 全保+正文前部
      +tags 保尾,wasTruncated)、SEMANTIC_TEXT_BUILDER_VERSION=semantic-v1、
      sha256 textHash;URL/作者/指标/ID/时间绝不参与(§29 基础)
- [x] EmbeddingProvider 接口(metadata/embed/embedBatch/batchSize/并发/间隔/
      validateConfig/mode 标注);业务层零厂商依赖(§10)
- [x] LexicalFallbackEmbeddingProvider:中文 bigram3+unigram0.5+word2、
      FNV-1a hashing trick、L2 归一化、确定性(零随机)、512 维;UI 明确
      「本地词法回退」(§13/§36)
- [x] OpenAICompatibleEmbeddingProvider:baseUrl/model/apiKeySecretRef/
      dimension/batchSize 可配;复用 HttpClient+SecretResolver;数量/维度
      严格校验;401/429/5xx 错误映射;Replay Transport 契约测试(§52)
- [x] EmbeddingSpace 稳定 ID `{provider}:{model}:{dim}:{builderVersion}`;
      单 active + 历史空间保留(§35);不同空间禁止互算 cosine(结构隔离)
- [x] content_embeddings(唯一约束 item+space+textHash,vector=Float32 BLOB,
      读写维度严格校验)+ embedding_jobs + embedding_spaces(0006 迁移,
      真机原地升级无损)
- [x] EmbeddingJob(§25-32):missing/all scope、batch、textHash 缓存 skip、
      单条/批失败不崩(partial + failed_item_ids)、cancel 边界停止、
      §29 指标变化不触发(测试覆盖)、§28 superseded 保留历史(D9)
- [x] cosineSimilarity 全边界(相同=1/正交≈0/反向=-1/零向量=0/维度不匹配/
      NaN 拒绝);SimilarContentService(excludeSelf/platform 过滤/space 隔离)
- [x] API(§39):spaces/space activate/jobs/job/cancel/settings +
      content/:id/similar + content/:id/embedding-status
- [x] UI:语义中心(空间表/任务表/运行向量化/设置,凭证只显 Configured/
      Missing);内容详情页相似内容(百分比+词法/语义标签+调试证据)+
      Embedding Provenance + Semantic Text Preview(§45-47)
- [x] 性能(§42):5000×512 向量存储 3.45s,topK 查询 54.6ms(brute-force
      足够,D10)
- [x] 真机 Dry Run(§51)与 smoke:embedding(§53,SKIPPED_NO_CREDENTIAL)

## Stage 5 —— Zhihu Official Connector(已完成)

> 知乎官方 API → Collection Runtime → RawRecord → ZhihuSourceAdapter →
> ContentItem → MetricSnapshot → DiscoveryObservation → FTS → Trends →
> Candidate Workbench。Live Smoke:SKIPPED_NO_CREDENTIAL。

## Stage 5 完成内容

- [x] 官方 API 核对:docs/connectors/ZHIHU_API_RESEARCH.md(Last Verified
      2026-09-24;来源 developer.zhihu.com/docs + 官方 CDN zhihu-cli skill 包,
      原文归档 docs/connectors/vendor-zhihu/)。鉴权 Bearer + X-Request-
      Timestamp(秒);zhihu_search(Query/Count≤10)/hot_list(Limit≤30)
      /quota(额度,不耗业务额度);错误码 0/10001/20001/30001/90001
- [x] SecretResolver(secretref:env:<NAME>;数据库/日志/事件零明文;Task
      config 只存引用);Secret 生命周期三态(configured/missing/invalid)
- [x] ZhihuOfficialConnector(id zhihu-official,platform zhihu,api,
      sourceType api,v1.0.0,capabilities search+hotlist):复用
      HttpConnectorBase/RateLimiter/Retry/Breaker/Runtime;动态注入鉴权头;
      可注入 Clock;Replay Transport(HttpClient transport 注入);Search/
      Hotlist 分离 Zod schema(§10 无隐式模式);真实 healthCheck(七态区分)
- [x] ZhihuSourceAdapter(纯标准化):VoteUpCount→upvotes(§23,不塞 likes);
      官方没有的指标→null(绝不 0;真实 0 保留 0);authorId null;EditTime
      epoch→UTC;搜索摘要剥 <em>;热榜从稳定公开 URL 提取 question/article
      与 ID;§18 组合键 `contentType:id`(question/article 数字 ID 独立空间,
      撞号防护);quality 门(title 非空即有 body,question 不误判 invalid)
- [x] content_discovery_observations(0005 迁移,append-only):search/hotlist
      rank 时序,平台无关;PageResult 可选 discovery 字段(index 对齐),
      collector 落库;同一内容跨 Run rank 逐条追加(§30/§31)
- [x] Raw Momentum 平台映射(§24/25):zhihu 权重 upvotes1/comments2/shares3/
      favorites2,其余平台不变;delta 的 upvotes 仅对 zhihu 行计算与标注
      unknown;仍叫 Raw Momentum,无任何新评分
- [x] Response Validation:宽松外层(Code 先判,错误响应无误报 drift)+
      核心 item schema(passthrough 额外字段);核心缺失→SCHEMA_DRIFT
- [x] Error Mapping:20001→AUTH_ERROR、30001→RATE_LIMITED(可重试)、
      90001→REMOTE_5XX、10001→INVALID_RESPONSE、HTTP 401/403/429/5xx;
      providerErrorCode 保留;错误信息零 Secret
- [x] Replay Fixtures(6 个,标 REPLAY_FIXTURE)+ Contract Tests(20)+
      集成测试(§38 search 全链路/§39 hotlist 双 Run 追加观察/§40 增长
      100→160 → momentum 96/漂移/lineage)
- [x] UI:Connector 页 Official API 徽章 + Test Connection(quota 轻量探测,
      不抓数据);无凭证 → misconfigured/Credential Missing(非 Unavailable);
      Task 表单 zhihu 模板预填(search 填 query/hotlist 无 query);
      Momentum 表加 Δ赞同列(平台语义)
- [x] npm run smoke:zhihu(独立于 npm test;无凭证 SKIPPED_NO_CREDENTIAL
      exit 0;有凭证最小请求验证 auth/schema/归一化,不打印 token)
- [x] 真机库 0005 原地迁移无损(25 内容 + FTS 24 docs)

## 最近测试结果

```
npm run typecheck  PASS(client + server strict,0 error)
npm run build      PASS
npm test           PASS  216 passed (216)   15 files
  - Stage 1-4 原 191 例全部保留通过(零退化)
  - Stage 5 新增 25 例:contract 16 + integration 9
npm run smoke:zhihu  SKIPPED_NO_CREDENTIAL(exit 0)
真机冒烟           PASS  Connector 页 Zhihu Official(Official API 徽章 +
                         Credential Missing 语义)+ 0005 迁移 + Test Connection
```

## Known Issues

1. Live Smoke 因环境无 ZHIHU_ACCESS_SECRET 为 SKIPPED(§58:第三方账号权限
   不属于代码正确性;Connector 保持 Credential Required,官方渠道
   developer.zhihu.com/profile 可申请)。
2. zhihu_search 官方当前单页(HasMore 恒 false):checkpoint 语义保留,
   官方开放翻页后无需改 runtime。
3. 热榜无 metrics/author/时间字段:官方事实,指标全 null;价值在 rank 时序。
4. momentum 排序仍在 JS(Stage 3 遗留,规模到达后下沉 SQL)。
5. breaker 状态不持久化(Stage 4 遗留)。

## Stage 6 Recommendation

- 环境获得 ZHIHU_ACCESS_SECRET 后:跑 `npm run smoke:zhihu` → 建 Search/
  Hotlist Task → 真实数据进入 Workbench/Trends(代码零改动)。
- 候选方向:① quota 展示与额度告警(官方 /api/v1/quota);② 热榜 rank
  趋势视图(数据已就绪,只差 UI);③ 下一个平台 Connector(抖音开放平台
  走同一模式);④ 搜索排名时序视图(DiscoveryObservation 已 append-only)。

## Stage 4 —— Collection Runtime Productionization(已完成)

> 无平台 API Key 情况下,全链路模拟并验证:
> Collection Task → Scheduler → Connector → Pagination → Rate Limit → Retry →
> Checkpoint → Resume → RawRecord → 既有 Import Pipeline → ContentItem →
> MetricSnapshot → CollectionRun → Run History。

### Stage 3 三个语义修正(§0)

- [x] 腰部过滤改为 Filter Preset:All(默认)/ Mid-tier Discovery /
      High Engagement / Custom;Mid-tier 明确标注"用户筛选预设,非科学定义"
- [x] 动量分更名 `rawMomentumScore`(Raw Momentum Score / 原始互动动量);
      UI 与 API 全量对齐,禁用 Viral/Trend/Opportunity Score 称谓
- [x] Topic Workbench → Candidate Workbench(内容候选工作台);domain 层
      ContentPick;表名 topic_picks / 列名 momentum_score 保留(兼容决策见
      docs/DECISIONS.md;未来 Topic Engine 不得复用该概念)

### 采集运行时实现(§2-32)

- [x] 审计文档 docs/COLLECTION_RUNTIME_AUDIT.md;修复而非重写
- [x] CollectionTask CRUD + Zod 闸门 + schedule 持久化;CollectionRun 全量统计
- [x] FixtureRemoteConnector 场景 A-H + 参数放宽支持 1000+ 条
- [x] 逐页 checkpoint + Resume;RateLimiter(修 abort 泄槽)+ 保守覆盖;
      Retry(backoff+jitter);CircuitBreaker(修探针卡死);Health 五态
- [x] Scheduler(interval)+ Restart Recovery(INTERRUPTED+可恢复);防重入;
      Queue(global 2 + per-connector 1);Cancel;Partial Run;Schema Drift;
      Secret lint(secretref:);事件 redact;14 类 RunEvent
- [x] Collection Center UI(Connectors/Tasks/Runs + Timeline)+ Dashboard
      采集统计卡片区;§33/§34 打通验证
- [x] 0003 零重复建表;原 152 tests 全部保留通过

### Stage 4 测试结果

```
typecheck PASS · build PASS · 191/191(原 152 + Stage 4 新增 39)
真机:2 轮 Run → 6 item × 2 snapshot → Δlikes=+50 → momentum=400 自动消费
```

### Stage 4 Known Issues(部分已被 Stage 5 处理)

1. momentum 排序 JS 内做(规模后下沉 SQL)——仍在
2. breaker 状态不持久化 —— 仍在
3. Scheduler 单进程内存实现 —— 仍在
4. fixture 全局模块态依赖唯一 taskId/runId —— 仍在
5. 浏览器采集 contract-only —— 仍在

### Stage 5 前置条件(已由 Stage 5 兑现)

- 具体平台 Connector + SourceAdapter:zhihu-official + ZhihuSourceAdapter ✅
- secrets 存储落地:secretref:env 语法 + SecretResolver ✅
- cron 调度扩展:仍留待后续(interval 已够用)

## FINAL RELEASE 1.0 · WP1 AI Topic Studio(2026-09-27 完成)

产品价值链的最后一层接上了:**Evidence → AI Topic Studio → 可执行选题方案**。
确定性引擎继续负责趋势 / 爆发 / 生命周期 / 共性 / 饱和度 / 新颖度 / 机会指数;
Studio 只做转化,不重新判断热度。没有 AI 密钥时 TrendScope 依然完整可用 ——
证据面板与确定性「证据摘要(非 AI)」照常可读,只有"生成选题方案"禁用并说明配置方法。

- 代码:`server/src/studio/`(config / evidencePackage / schema / prompt / provider /
  evidenceBrief / repository / studioSettings / service)+ `routes/studio.ts`
  + migration `0013` + `src/pages/TopicStudio.tsx`(导航第 12 项)+ `src/types/studio.ts`
- 数据:`topic_studio_runs`(历史只追加)+ `topic_studio_marks`(saved/favorite/discarded),
  均带 FK 且级联删除;真库已原地迁移(48 表 / 599 行 / integrity ok),迁移前备份已校验
- 护栏:输出必须严格符合 `studio-output-v1`(不合规 = 失败,不产出半成品);每条角度与标题
  必须引用证据编号;幻觉扫描标出"证据里没有的百分比 / 量级 / 权威背书";内容正文一律以
  `【DATA·…】` 区块进入 prompt,伪造的数据标记(含结束标记)会被中和
- 基线:**544/544 tests(41 文件)· typecheck 0 error · build PASS ·
  eval:topics / eval:opportunity 与冻结值逐字一致 · 三档浏览器走查 0 console / 0 溢出 / 0 死按钮**
- 剩余工作包:WP2 完整产品工作流(首跑引导 / Demo Mode / 一键全分析分步进度与分步报错)、
  WP3 安装启动与数据库安全(`engines.node` / `npm run doctor` / `.env.example` / 优雅退出 /
  干净目录全新安装验证)、WP4 全产品 Bug Sweep、WP5 Release 1.0 交付物

## FINAL RELEASE 1.0 · WP2 完整产品工作流(2026-09-27 完成)

从"功能可用"到"拿到手就能走完主流程":空库首启不再是死页面,一键按序跑完分析并显示进度,
演示数据与真实数据物理隔离。

- 首页(§32/§33/§36):唯一状态源 `GET /api/analysis/status` → 八张概览卡 + 五步引导 +
  数据源健康(知乎凭证 / 语义模式 / AI 服务),缺凭证时点名环境变量,不写"没有数据"
- 一键全分析(§37-§39):`server/src/analysis/fullRefresh.ts` + `analysis_runs`(migration 0014),
  六步各自 completed/skipped/failed + 原因;前序结果不回滚;AI 方案不参与
- 演示模式(§34/§35):`npm run demo` 独立库自动装载示例数据,`npm run demo:reset` 只碰演示文件,
  界面常驻横幅,首页显示演示占比 100% 并声明不代表真实热门内容
- 依赖感知(§40)+ empty/error 态(§41/§42):12 条路由在空库下全部有指引、可点击到达,
  浏览器实测 0 console error / 0 溢出 / 0 死按钮
- 基线:**559/559 tests · typecheck 0 error · build PASS · eval 两项与冻结值逐字一致**
- 剩余:WP3 安装启动与数据库安全(`engines` / `doctor` / `.env.example` / 优雅退出已做,
  干净目录全新安装验证待发)、WP4 全产品 Bug Sweep(WP1/WP2 期间已攒下一批待办清单)、WP5 交付物
