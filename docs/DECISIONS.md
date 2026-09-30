# DECISIONS — 架构与命名决策记录

## D-2026-09-24 · Candidate Workbench 语义修正(Stage 4 §0)

### D1 · 数据库表名 `topic_picks` 保留

**决定**:不改表名、不改列名(momentum_score 保留),domain/service 层统一用
`ContentPick` 类型(`src/types/trend.ts`、`server/src/services/topicService.ts`),
API 输入输出字段统一为 `rawMomentumScore`(旧 `momentumScore` 输入兼容一版)。

**原因**:
- 改表名需要迁移 + 同步全部既有查询/测试,收益只有"名字更好看",风险不成比例。
- `momentum_score` 列语义已在 schema 注释中明确为"决策时点的 Raw Momentum Score"。

**约束**:
- 未来真正的 Topic Engine(Topic 聚类/主题建模)**不得复用** `topic_picks` 表与
  `ContentPick` 概念——那是"内容候选决策",不是"主题"。
- `/picks` REST 路径保留(前端与测试已依赖;语义上操作对象本来就是 ContentItem)。

### D2 · `momentumScore` → `rawMomentumScore`

**决定**:`trendService` 的 `MomentumRow.momentumScore` 更名 `rawMomentumScore`;
UI 文案统一"原始互动动量"。

**禁用词**:Viral Score / Trend Score / Opportunity Score(以及爆款预测类称谓)。
该分数是透明启发式(Δlikes + 2Δcomments + 2Δfavorites + 3Δshares),窗口内
快照增量加权,不含任何模型/预测语义。

### D3 · Filter Preset 替代硬编码腰部过滤

**决定**:内容候选工作台默认预设为 **All**;`Mid-tier Discovery`(点赞 300–5000)
降级为**用户筛选预设**并显式标注:"用户偏好,非系统对潜力内容的科学定义"。
`High Engagement` = 按互动率降序(要求五项指标全已知);`Custom` = 手动区间。

### D4 · 页面更名,路由不变

`/workbench` 路由与 `Workbench.tsx` 文件名保留(链接/书签兼容),页面标题改为
"内容候选工作台",导航项改为 "Candidate Workbench"。

## D-2026-09-24 · Stage 5 知乎官方 Connector

### D5 · 知乎 ContentID 采用 `contentType:id` 组合键(§18)

**决定**:`platformContentId` 存 `answer:1903044959663284716`、
`question:123456789`、`article:987654321` 形式的组合键(类型小写前缀)。

**原因**:知乎 question 与 article 的公开数字 ID 是**独立命名空间**
(`zhihu.com/question/123` 与 `zhuanlan.zhihu.com/p/123` 可并存),
裸 ID 跨类型撞号会导致 deterministic dedup 错误合并两类内容。
官方 `ContentID` 与 URL 数字 ID 属同一 namespace(官方示例已验证:
ContentID 1903044959663284716 ↔ /answer/1903044959663284716)。

### D6 · Secret 引用语法扩展为 `secretref:<source>:<name>`

**决定**:Stage 4 的 `secretref:<id>` 扩展出 `secretref:env:ZHIHU_ACCESS_SECRET`
来源段;解析仅由 `services/secrets/secretResolver.ts` 负责(唯一解密点)。
`SECRET_REF_PATTERN` 同步放宽(仍禁止明文,lintSecrets 行为不变)。
知乎 Connector 默认约定环境变量 `ZHIHU_ACCESS_SECRET`,Task config 可用
`secretRef` 字段覆盖变量名(仍是引用,不是值)。

### D7 · PageResult 增加可选 `discovery` 字段(§29-31)

**决定**:`PageResult.discovery?: { type, query?, ranks[], metadata? }`
(index 与 items 对齐),由 collector 在导入后写入
`content_discovery_observations`(0005 迁移,append-only)。
不破坏 Stage 4 分页契约四字段;Fixture connector 不提供该字段,零影响。

### D8 · Raw Momentum 平台权重映射(§24/25)

**决定**:`scoreOf(delta, platform)` 按平台取权重表——
`zhihu: upvotes 1 / comments 2 / shares 3 / favorites 2`;
其余平台维持 `likes 1 / comments 2 / shares 3 / favorites 2`。
upvotes 参与窗口 delta 计算仅对 zhihu 行生效(非知乎行不进入
unknownComponents,避免全表"部分未知"徽章退化)。分数仍叫
Raw Momentum,无任何 Viral/Trend/Opportunity Score。

## D-2026-09-24 · Stage 6A 语义层与 Embedding 基础设施

### D9 · 文本更新采用 superseded 标记,不物理删除旧向量(§28)

**决定**:ContentItem 语义字段(title/text/transcript/hashtags)变化 →
semanticText hash 变化 → 插入**新** ContentEmbedding 行;旧行置
`superseded_at`(保留)。相似搜索只读未 superseded 行。

**原因**:可追溯(embedding 历史即内容文本演化史)、可回滚、成本极低
(向量 BLOB 很小)。清理策略留待 Stage 6B 按需设计。

### D10 · 相似搜索采用"批量读 + brute-force cosine"(§41)

**决定**:不做 FTS 预筛,不做候选 bucket。一次查询读出该空间全部活跃向量
(Float32 BLOB),内存中 brute-force cosine 取 topK。

**依据(实测,非伪造)**:5000 条 × 512 维 —— 存储 3.45s(含 5000 行
content_items 插入),topK=10 查询平均 **54.6ms**(10 次平均, brute-force
在 JS 单线程约 2.5M 乘加,远低于 500ms 预算)。规模到 5 万条或引入 API
Provider 后再评估 sqlite-vec / 专用向量库。

### D11 · Lexical Fallback 特征权重(§14/§43)

**决定**:中文 bigram 权重 3(主导)+ 单字 unigram 0.5(弱补充)+ 英文/
数字 token 权重 2;FNV-1a hashing trick 双哈希定桶与符号;L2 归一化;
默认 512 维。Golden 基线(§43)在 512 维下成立:A/B、A/E 明显高于 A/D
(单字权重过高会引入噪声,曾使 A/C < A/D,调参后修复——教训记录)。

## D-2026-09-25 · Stage 7 评分引擎

### D12 · 权重与阈值为设计初始值,集中 profiles.ts,版本化快照

**决定**:CONTENT_BURST_V1(velocity .35 / reach .20 / EQ .20 / relative .15 /
structure .10)与 TOPIC_TREND_V1(content .35 / engagement .25 / creator .15 /
density .15 / acceleration .10)为设计初始值;全部参数集中在
`server/src/scoring/profiles.ts`,每次 Run 落 configSnapshot。
**约束**:调整必须 bump 版本 + 记录本文件 + 旧分数保留;禁止为让某个数据集
变好看而调参(延续 §58)。

### D13 · Missing-aware 合成:缺组件重归一权重 + 降置信,绝不按 0

**决定**:任一组件不可用(null)→ 剩余组件权重按原比例重归一到 1,同时按
confidence.ts 的确定性扣分表降置信;全部组件不可用 → unscorable(不输出 0 分)。
原因:缺失=未知;按 0 参与等于伪造"表现差"证据,违反项目红线。

### D14 · unscorable 判定顺序:snapshots → metrics → cohort

**决定**:先 insufficient_snapshots(从未观测)、再 insufficient_metrics
(有观测但无可算信号,热榜形态)、最后 insufficient_cohort(样本不足)。
原因:最具体的"数据为什么不可用"优先呈现;cohort 不足是分布问题而非内容问题。

### D15 · Lifecycle 滞回:连续 2 次观察或 Δ≥25 强突破才迁移

**决定**:lifecycle 切换需连续 2 次评估一致(hysteresisConsecutive=2),或趋势分
强突破(Δ≥25);pending 态持久化于 topic_score_current;迁移写 append-only
topic_lifecycle_events(含 reason)。原因:防"今天 Rising 明天 Peak 后天 Rising"
抖动;单日数据异常不应推翻阶段结论。Lifecycle 与 Topic.status 严格分离。

## D-2026-09-25 · Stage 8 内容情报

### D16 · 控制组零命中用 add-1 平滑,不输出 Infinity

**决定**:viralRate/controlRate 任一侧 0 命中 → (hits+1)/(n+2)(Jeffreys),
notes.smoothingApplied=true;其余情况不平滑。原因:controlRate=0 时裸 Lift=∞,
"N=12 vs 0 命中 = 28 倍"是伪统计;平滑把极端值压到有限且可解释。

### D17 · 控制组梯子跨话题兜底必须标注 platform_global

**决定**:话题内四级放宽仍不足时,允许用同平台全局非爆发内容兜底,但
controlMatchLevel=platform_global 显式落库/展示。原因:宁要"标注过的粗对照"
不要"无结论";泛化边界必须可见。

### D18 · 角度向量 v1 恒用词法回退,独立于内容 Embedding 空间

**决定**:AngleText(ANGLE_TEXT_V1)的向量用 lexicalEmbed 计算,不进
embedding_spaces,不与内容向量混算;UI 标注"词法饱和度基线"。原因:零凭证
可运行(§12/§36);话题内近邻结构是相对比较,词法基线已可区分"同模板刷屏"
与"角度多样";EMBEDDING 凭证到位后再升级真语义角度(届时 bump 版本)。

### D19 · 角度簇跨 Run 调和:质心相似度继承 ID,"曾新兴"永久保留

**决定**:新 Run 的角度簇与既有簇质心 cosine ≥0.6 → 继承 id/firstObservedAt/
人工命名;未命中簇置 inactive(历史保留);isEmerging 语义为"曾识别为新兴",
继承后不回落。原因:角度生命周期(出现→成熟→消退)需要稳定身份;
"当下是否新兴"与"曾经新兴"是两个问题。

## D-2026-09-25 · Stage 9 机会引擎

### D20 · Pattern Strength 无行 = unknown(而非 0)

**决定**:话题在最近一次情报 Run 无 pattern_results 行 → Pattern Strength 视为
unknown(权重重归一 + 置信下降),而非 0 分。原因:当前 schema 无法区分
"分析了但无模式"与"样本不足未分析";把两者都当 0 会系统性压低新话题。
后续若在情报 Run 落每话题 pattern 状态,可拆分这两种情形(记 Stage 10 候选)。

### D21 · Whitespace 必须由可评分的饱和度推出,禁默认 100

**决定**:Whitespace = 100 − 饱和度,且仅当饱和度可评分;饱和 unknown →
Whitespace unknown(绝不自动 100)。原因:无饱和数据时假定"空间巨大"是最危险的
默认——伪乐观比伪悲观更难被用户察觉。

### D22 · 人工决策(decision)与机会分数完全解耦

**决定**:opportunity_decisions(shortlisted/reviewing/dismissed)是独立人工状态,
不参与分数计算(fixture 验证 dismissed 后分数不变);与 TopicWatch(话题关注)
分开建表。原因:分数是数据证据的函数;用户判断是决策层输入,混淆两者会让
分数失去可审计性。

## D-2026-09-27 · Stage 9.5 运行环境

### D23 · better-sqlite3 收紧到 `~12.10.1`,禁用 12.11.1

**决定**:依赖声明由 `^12.2.0` 改为 `~12.10.1`(而非 `^12.10.1`——caret 仍会解析回
12.11.1),lock 记录 12.10.1。

**原因(实测)**:新机器 Node v24.19.0(ABI 137)下,better-sqlite3 **12.11.1** 会在
vitest worker 退出阶段触发原生 abort ——
`node::RemoveEnvironmentCleanupHook … Assertion failed: (env) != nullptr`,栈内含
`Statement::scalar deleting destructor'`,即预处理语句 JS 包装对象在 V8 环境已拆除后才被
GC 析构。31 个测试文件里 11 个因此崩溃,`npm test` 根本跑不完(退出码 1、结果不落盘)。
同代码同 lock 换回 12.10.1 → `426/426 PASS`,崩溃标记 0 次。

**已排除**:并行度(`--pool=forks` 照崩)、超时(3 秒即崩,给到 240s 照崩)、worker 复用
(`--no-file-parallelism --isolate=false` 照崩)、`--forceExit` 无效、`:memory:` 最小复现
(主线程与 worker 线程均不崩——需 drizzle 语句量 + afterAll 关库组合才触发)。
结论是插件收尾顺序回归,**不是产品缺陷,也不是任何一条断言写错**。

**约束**:本决定**未修改、未放宽、未删除任何测试**。在确认 12.11.x 修复该退出路径之前,
不得让 better-sqlite3 升到 12.11.*;若将来升级,必须完整重跑 `npm test` 并以"崩溃标记为 0"
为验收判据。


## D-2026-09-27 · Stage 9.5 前端可靠性 / Profile 治理 / 可解释性

### D24 · 取数只允许一个 hook:useResource(abort + 代次双保险)

**决定**:所有 GET/query 走 `src/lib/useResource.ts`;不再新增 useFetch/useRequest/useLoader/useAsync
这类并行实现。Mutation 不塞进 hook,继续用 `api/post/patch/del`,成功后 `reload()`。
`api.ts` 改为放行 `AbortError`(不再伪装成"无法连接服务器"),hook 因此能区分"被取消"与"真失败"。

**原因**:此前 `api()` 虽支持 signal,但调用点不传,慢响应可以盖掉新结果 —— 是真实产品 bug 而非洁癖。
双保险是必要的:abort 只保证"尽力不发/早断",传输层不能保证及时生效,所以还必须有请求代次计数,
只有最新一代的结果允许写 state(测试里用 unabortable 假 fetch 专门验证了这条)。

**约束**:`initialLoading` 与 `refreshing` 语义分离,换筛选时保留旧数据(不闪空白);
被 abort 的请求不弹错、不写 console;只有搜索类文本框 debounce(250ms),select/日期立即请求。
`resetOnPathChange` 只用于身份型读取(详情):切换实体后继续显示上一个实体的载荷就是撒谎。

### D25 · Opportunity Profile 落库,版本 immutable,archive 而非 delete

**决定**:`opportunity_profiles` 表为唯一配置源;种子两行必须与代码常量逐字段相等(有深比较测试锁死);
不存在任何"改旧版本"的写入口 —— `PATCH /profiles/:id` 显式回 409。权重允许任意非负输入,
保存时服务端归一化(全 0 → 400);新鲜度以小时表达;参数分基础/高级两层;不做物理删除。

**原因**:§24/§25 的可解释性要求 —— 历史快照必须能指回"当时用的那份权重"。
原地改一份被引用过的配置,会让所有旧分数失去意义,这是不可逆的数据破坏。
激活唯一性用部分唯一索引(`WHERE is_active=1`)在数据库层兜底,而不是靠应用逻辑记得检查。

**约束**:§0 说本阶段不加新算法,所以**没有**为 profile 引入新的评分组件;引擎只是从
"读代码常量"改成"读 active 行 + 缺失时回退到内置常量"。同一版本 + 同一输入 + 同一时钟
必须逐位复现(D48 有测试)。

### D26 · 趋势分解的服务端唯一真源 = topic_(trend) 表里的 components_json

**决定**:组件分数、名义权重、missing-aware 后的**有效权重**、每个组件的关键证据、不可用原因,
全部由 `buildTrendBreakdown()` 在 Run 时算出并**落库**(`topic_trend_snapshots` 与
`topic_score_current` 各两列,迁移 0012);API 下发 `detail`。前端 `TrendBreakdown` 只渲染。

**原因**:此前话题页自带一份写死的 `TOPIC_TREND_V1` 权重、趋势中心读一个服务端从不返回的
`current.breakdown` 字段(整块静默为空)。两份实现必然随引擎漂移,而漂移的表现是"用户看到
一个没人算过的数字"。旧行为 NULL 时 UI 明说"这一版没记录分解",绝不用当前权重反推冒充
(与 null ≠ 0 同一条红线)。

### D27 · vitest 串行执行:让计时断言量算法,不量 CPU 争抢

**决定**:`fileParallelism: false`。**没有**改任何阈值、timeout、断言或测试数量。

**原因(实测)**:`buildEdges` 5000×512 在本机单独跑 22.5s,整套并行时被其它文件挤到 37.8s
而越过 30s 预算 —— 同一份代码,失败原因与代码无关。并行时快时慢的计时断言不是回归信号,
是噪声。串行总时长 84s(并行 41s),换来可复现的绿;并把套件数从 31 增到 36 后的竞争压回去。

**同时**:为让真实预算更宽,做了**行为等价**优化(投影行 Float64Array 化 + i 行分量提局部
+ 除法改乘法比较 + 精确复核稀疏化),22.5s → 9.9s;用 5000 条边的 `a|b|similarity.toFixed(17)`
校验和确认输出逐位不变(`digest=6d9f8b8609d175fd7713a335`)。**优化优先于放宽,永远不反过来。**

## FINAL RELEASE 1.0 · WP1 AI Topic Studio

### D28 · Studio 的 AI 边界:只转化,不判断

**决定**:唯一数据流是"确定性引擎算好的证据包 → 模型 → 严格 Zod 输出"。模型不得重新判断
热度、饱和度、新颖度、机会指数(system prompt 第 2 条写死),不得引入证据包之外的统计/
人物/事件/研究(第 4 条),争议话题必须并列立场并交回用户决定(第 3 条)。

**为什么**:确定性引擎已经负责"什么在变热";让 LLM 复述一遍判断只会引入不可复现的结论。
输出每条角度/标题都必须带 evidenceRefs,任何建议都能回查到具体证据编号(§10);
语法合规但证据包里不存在的编号同样会被标出来(`findUnknownEvidenceRefs`)。

### D29 · 无 AI 凭据 = 完整可用,而不是降级演示

**决定**:`STUDIO_API_KEY` 缺失时,设置 / 话题选择 / 证据包 / 确定性摘要 / 历史 / 人工标记
全部照常可读;只有 `generate` 返回 409,message 里点名缺哪个环境变量。**禁止**用规则生成
内容再标"AI 建议"(§16)。确定性摘要在 UI 上写作「证据摘要(确定性,非 AI)」。

**为什么**:交付标准是"没有密钥也能完整使用 TrendScope",同时不能出现假 AI / 假数据。

### D30 · 历史只追加,人工状态另表,机器结论与人工判断分离

**决定**:`topic_studio_runs` 每次生成追加一行(provider / model / promptVersion /
schemaVersion / evidenceVersion / evidenceHash / 输入快照 / 输出 / 护栏结果 / 耗时),
失败也落一行 `status=failed`,绝不覆盖历史;`topic_studio_marks` 单独存
saved / favorite / discarded(`none` 表示取消)。两表都带 FK,`foreign_keys=ON` 下有测试守护。

**为什么**:换 prompt 或换证据形状后,历史结论仍要能解释;人工判断不能污染机器结论 ——
与机会指数"人工决策不影响分数"是同一条规矩。

### D31 · Studio 测试注入点在装配层,凭证缺失用真删环境变量构造

**决定**:HTTP 契约测试通过 `createApp(db, runtime, { makeStudioProvider })` 注入
**带 Replay Transport 的真实 provider 实例**,而不是假对象 —— 被测的请求形状就是生产请求形状。
"没有密钥"这一档是把 `process.env.STUDIO_API_KEY` 真删掉来测的。冒烟脚本 `smoke:studio`
则走真实网络路径(已用本地假 AI 服务验证:认证、schema、不泄漏密钥)。

**为什么**:Stage 9.5 的教训是"没有测试经过 HTTP,470 个绿灯与 4 个死按钮共存"。
注入点放在装配层,既不牺牲真实性,也不需要 mock 掉自己要验的东西。

### D32 · 复用判据只含证据本身,不含时钟推算值

**决定**:`evidenceHash` 覆盖话题指标、引擎结论、被选中的内容 / 共性 / 角度以及各自的
`calculatedAt`,**不**覆盖 `ageHours`(由当前时刻推算)。陈旧提醒照旧展示,只是不参与
"相同证据"的判定。

**原因(实测)**:含了年龄时同一话题两次生成的哈希不同,"复用上次结果"形同虚设,
每次点生成都会真花钱调用模型。

### D33 · 一键全分析:编排进度独立成表,不回写引擎结论

**决定**:`analysis_runs(id,status,trigger_source,current_step,steps JSON,error,started_at,finished_at,duration_ms)`,
每一步的 `{key,label,state,startedAt,finishedAt,error,result}` 整体覆盖写进行记录;
各引擎自己的 current/snapshot 表仍然是唯一事实来源,编排表不复制任何业务结论。

**为什么**:进度必须扛过页面刷新(§38),也必须说清"哪一步失败、前面上面已经落库"(§39)。
把 steps 存成一整块 JSON 而不是子表:步骤数量有限、必须整体一致读,拆表只会让"读到跑一半的进度"成为可能。
本表没有任何外键引用(§73)—— 它引用的是流程,不是数据。

### D34 · 一键全分析只在首跑时自动聚类话题

**决定**:步骤顺序 = 更新内容向量 → 话题分析(仅当从来没有话题)→ 内容爆发指数 → 话题趋势 →
爆发共性与饱和度 → 选题机会指数;跳过必须给原因,写进步骤的 `error` 字段展示给用户。
AI 选题方案**永远不在**这条流水线里(§37)。

**为什么**:重新聚类会重写话题结构,而话题命名/合并/移动是人工治理结果,
不能被一个"刷新"按钮悄悄覆盖;跳过而不是报错,才符合"前序结果保留"的要求。

### D35 · 演示数据隔离靠两个库文件,不靠 WHERE

**决定**:演示模式 = `TRENDSCOPE_DEMO=1` + 独立文件 `data/trendscope-demo.db`(+ `TRENDSCOPE_DB`
可显式指定库路径)。`/api/demo/load`、`/api/demo/reset` 在非演示模式下**一律 409**;
两个端点都要求显式 confirm 字段;`npm run demo:reset` 删除前校验目标文件名。
演示模式下界面常驻"演示模式"横幅,首页按来源统计演示占比。

**为什么**:§35 的原文是"只能操作 Demo Database / Demo Records,禁止误删用户真实数据"。
在同一张表里靠 source_type 过滤来"安全删除",一旦哪天导入流程改了 source 标记就会毁真数据;
两个库文件把这类错误变成不可能。

### D36 · API 统一 no-store,前端不做缓存补丁

**决定**:`app.use("/api", ...) 设置 Cache-Control: no-store`。

**为什么**:进度类端点反复请求同一个 URL,浏览器的启发式缓存会让轮询读到旧数据 ——
修在边界一处,而不是每个页面各自给 fetch 加 cache 参数(那种补丁一定会漏)。

### D37 · 用户可见文案一律中文,原始 code 只留在悬停提示

**决定**:平台 / 内容类型 / 来源 / 连接器类型 / 能力 / 熔断状态 / 运行事件 / 运行错误码等枚举,
接口与数据库继续存英文 code(契约不变、测试继续按 code 断言),渲染统一走 `src/lib/format.ts`
里的标签表;`<th>`/按钮/横幅里不再出现裸 code。需要研发排查时,原始 code 放在 `title` 悬停提示。
服务端返回给界面的错误、健康详情、导入失败原因、zod 校验信息同步中文化
(`server/src/domain/zodMessage.ts` 统一按 issue.code 翻译,只有我们自己写的中文 message 原样保留)。

**为什么**:§78/§80 要求界面不明显中英混杂;而把枚举改成中文会破坏 HTTP 契约与既有断言。
"存 code、显示中文"两头都保住,且翻译集中在一处,不会每页各拼一次。

### D38 · 治理动作的输入用产品内对话框,不用 window.prompt

**决定**:话题重命名、话题合并的目标选择、模型复制的新标识,改用 `src/components/Dialogs.tsx`
(`PromptDialog` / `PickDialog`)。合并目标从"输入编号"改为下拉选择;非法输入在框内提示原因,
不关框。破坏性操作(删除任务、归档模型、确认合并)仍保留一次 `window.confirm` 兜底。

**为什么**:原生 `prompt` 不可样式化、可能被宿主环境拦截,一旦拦截按钮就等于"死的"(§67);
"输入编号"要求用户先读一段多行文本再回忆序号,是明显的错选来源。测试见 `tests/unit/dialogs.test.tsx`。

### D39 · 版本只有一个来源:package.json

**决定**:`package.json` 的 `version` 是唯一版本来源。前端通过 `vite.config.ts` / `vitest.config.ts`
的 `define.__APP_VERSION__` 注入(两份配置必须一致,否则测试里渲染 App 会引用未定义标识);
服务端 `server/src/version.ts` 运行时读取,启动日志、`npm run doctor`、侧栏"关于"都取同一值。
不在源码里再写一次 "1.0"。

**为什么**:发布时改两处必然漏一处,而"侧栏写 1.0、doctor 写 0.1.0"这种自相矛盾正是用户
判断"这到底是不是正式版"的依据。

### D40 · 侧栏显示当前实例真正打开的数据库文件

**决定**:`/api/demo/status` 返回 `dbDisplay`,由 `createApp(db, runtime, { dbFile })` 传入的
**当前连接实际文件**决定;位于默认目录时显示 `data/<文件>`,自定义 `TRENDSCOPE_DB` 时按绝对路径显示。
不再返回固定的演示库名。回归测试:`tests/unit/demo-status.test.ts` +
`tests/integration/analysis-workflow.test.ts` 的演示模式一节。

**为什么**:WP4 走查时发现正式实例的侧栏写着 `data/trendscope-demo.db`。本地工具里"我到底在动
哪个库"是用户决定要不要备份的唯一线索,写错比不写更糟。

### D41 · `npm run verify:release` 只放能被机器证明的闸门

**决定**:该脚本覆盖:交付元数据、`.env.example`/`.gitignore` 约定、静态扫描(中英混杂文案 /
`window.prompt` 残留 / 接口回显密钥)、类型检查、构建、全量测试、`doctor`、数据库完整性与迁移记账、
`eval:topics` 与 `eval:opportunity` 不回退、交付文档存在。浏览器逐路由走查、文案是否好读这类
需要人眼的项,记录在 `docs/RELEASE_NOTES_1.0.md`,不混进闸门。

**为什么**:闸门要能反复跑且退出码可信。把"看截图判断"塞进脚本只会制造要么长期 SKIP、
要么靠放宽阈值变绿的假信心。

### D42 · 导航按用户流程排,界面不再显示内部阶段编号;配置集中到「设置」页

**决定**:侧栏顺序改为用户实际动线(拿数据 → 看数据 → 采集/语义 → 话题 → 趋势 → 机会 → 候选 →
工作室 → 模型 → 设置),去掉 `01…12` 与页头 `NN /`、`A /`、`B /` 编号(共 22 处)。
四项外部能力(知乎接口 / 语义向量 / AI 选题服务 / 机会模型)的集中视图放在新的「设置」页;
工作室与语义中心只保留一行状态 + 跳转。设置页只报"已配置 / 未配置 + 环境变量名 + 非密钥参数"。

**为什么**:编号是开发期阶段划分的残留,对使用者没有信息量,还会在增加页面时集体错位(§115/§80);
同一份配置在两个页面各写一遍,改版时必然出现两处不一致(§116/§120)。

### D43 · 展示口径唯一化,并用测试钉住

**决定**:数字口径固定为"计数用千分位精确值 / 指标与坐标轴用万亿紧凑制",坐标轴不再出现 `k`;
时间统一 `fmtDateTime`(本地时区、空值显示"—");断行口径为"名称按词断、长 ID/URL 才按字符断";
平台 / 内容类型 / 来源 / 能力 / 去重原因 / 状态 / 运行事件 / 错误码 / 触发方式 / 熔断态等枚举
**必须**有中文标签,由 `tests/unit/display-conventions.test.ts` 对着服务端 domain 常量断言覆盖。

**为什么**:这三类缺陷的共同点是编译期看不出来 —— 枚举加了新取值就漏英文 code,
局部改一处 maxWidth 就把断行问题留给下一页。把口径收进单一函数 + 单一 CSS 规则 + 一个回归文件,
新增取值时测试会立刻变红,而不是靠人眼逐页扫。

### D44 · 通用 HTTP 连接器:多平台靠配置接入,不靠爬

1.0 只有知乎官方接口一个真实源,使用者要接别的平台就得先改代码 —— 这不对。新增
`generic-http`:任务配置里给 `url / itemsPath / query / headers / pagination / mapping / platform`,
就能把**任何你有权访问的 JSON 接口**接进现有采集运行时(限速、重试、熔断、断点、去重全部复用)。

- 字段映射复用导入侧同一套 `mapping`(目标名 = 规范字段),不新增第二套标准化路径。
- 鉴权只接受 `secretref:env:NAME`,明文密钥在 schema 层与建任务的 `lintSecrets` 双重拒绝;
  远程错误信息里的密钥值一律 `***` 脱敏。
- 只允许 GET、只允许 http/https、`maxPages` 硬上限 20。
  **这是"接入合法数据源"的开关,不是无节制抓取的开关。**
- 抖音 / 小红书 / B 站 / 微博这类平台:等它们官方开放平台拿到凭证后,直接写配置即可,无需改代码。
  不做绕过登录与风控的抓取器 —— 那会把条款风险转嫁给使用者,且三天两头失效。
- 平台归属由 `config.platform` 决定(通用连接器一个 id 服务多平台),未知代码原样显示,不猜测中文标签。
- 覆盖:`tests/integration/generic-http-connector.test.ts` 9 例(replay 传输,不碰公网),
  真机用一个公开无密钥的 JSON 接口(HN Algolia)2 页取回 30 条全部入库。

### D45 · 全分析的「话题」步骤改为增量归入,而不是"有话题就跳过"

旧语义:只要库里已有话题,一键全分析就跳过聚类,理由是"重新聚类会覆盖人工治理结果"。
真机后果是**新采的内容永远进不了话题 / 趋势 / 情报 / 机会**,自动化链路在入库之后就断了。

新语义:没有话题时全量聚类;有话题但存在未归类内容时,只对未归类内容做增量归入。
实测(知乎真实数据)增量运行不会改动已有话题的成员,人工命名的话题 `namingSource=manual`
与置信度保持不变 —— 所以人工治理结果仍然安全,而断掉的链路接上了。
需要**全量重聚类**仍然只能去「话题」页手动运行(那句提示保留,只是条件改对了)。

### D46 · 采完即算:采集运行入库后自动补一次分析

`CollectionRuntime` 增加 `onRunFinished` 挂点,启动装配里接 `startAutoAnalysis`:
本次真的 accepted>0 才触发,`cancelled` 不触发;进程内同一时刻只跑一个自动分析,
手动全分析正占线时记为 `skipped`(不算失败,下一轮采集还会再来),不排队堆积。
状态在 `GET /api/analysis/status` 的 `autoAnalysis` 里可见(是否开启 / 是否在跑 /
上次结果 / 跳过次数),分析运行以 `trigger_source="after-collection"` 留痕,可与手动运行区分。

- 开关是环境变量 `TRENDSCOPE_AUTO_ANALYSIS=0`(默认开),不需要改代码,也不需要在界面里加一个
  没人会去找的开关;关闭只用于调试或限流场景。
- **AI 选题方案不在自动范围内**:自动批量产内容不是本产品的职责,仍由用户在工作室点击生成。
- 覆盖:`tests/integration/auto-analysis.test.ts` 5 例,含真实采集链路触发一条 `after-collection` 运行。

### D47 · 本机已登录的 AI 命令行程序,是与外部 Key 同等级别的合法 AI 来源

目标链路(采集 → 向量聚类 → 选题)的后两步都依赖一个会写中文的模型,而个人项目通常没有
`STUDIO_API_KEY`。此前结果是:话题名永远停在关键词碎片(`magic9 荣耀 机发` 这种),
选题工作室只有确定性摘要 —— 功能存在但用户拿不到价值。

现在 `STUDIO_CLI_COMMAND=claude` 即可复用本机已经登录的命令行模型:

- 判定只有一份(`server/src/studio/chatBridge.ts`),**话题命名与选题工作室共用**。此前命名读
  `EMBEDDING_*`(指向一个只提供向量化的服务,根本没有 chat 接口)、工作室读 `STUDIO_*`,
  两处各说各话;`routes/topics.ts` 里还有第三份手写 fetch(检查 `STUDIO_API_KEY` 却用
  `EMBEDDING_API_KEY` 取值),已一并删除。
- 安全边界:命令名与 `--model` 只接受裸 token(无空格/引号/元字符),**提示词只走 stdin**;
  禁用工具调用;超时/取消杀进程;输出有上限。Windows 上通过 `cmd.exe /d /s /c` 显式启动而不用
  `shell:true`,少一条 Node 弃用告警,注入面仍然只有"常量参数 + 裸命令名"。
- 界面如实标注来源:`设置 → AI 选题服务` 显示「能力来源:本机命令 claude 的登录态,不调用外部 API」,
  并把接口地址 / 温度 / maxTokens 标为「不适用(本机命令)」;`secretStatus` 仍然如实说「未配置」,
  不会把"用登录态"伪装成"有密钥"。
- 关掉它:清空 `STUDIO_CLI_COMMAND` 即可,不改代码。
- 覆盖:`tests/unit/localCliProvider.test.ts` 9 例 —— 其中"命令真实启动后非 0 退出 → 可读错误"
  用真实进程(拿 `node` 当那个会失败的 CLI),不是 mock。

### D48 · 自动补算不用 AI 命名:按次消耗的东西不该被定时器驱动

`runFullRefresh` 现在把 `trigger` 传给每一步。`after-collection`(采完即算,含 30 分钟定时器)
这一路话题命名**只用关键词命名**;用户在「分析」页手动点一次全分析才会调用模型命名。

理由:AI 命名是"每个簇一次调用"。本机 CLI 单次十几秒到几十秒,且消耗的是使用者自己的登录额度 ——
让定时器每半小时悄悄发起二十次调用是不可接受的。命名结果本身不改变任何指标(聚类、趋势、机会全是
确定性引擎算的),所以自动路径保持便宜、可预测,想要更好的名字由人发起。

### D49 · 某一步失败时整轮不能记为 completed(报告与状态不许说谎)

真机事故:一键抓 4 个渠道时,`analysis_runs` 记 `completed`,而 `topic_analysis_runs` 里是
`failed:62 条内容…缺少向量`、话题 0 个 —— 因为 `runTopicAnalysis` 用**返回值**表达失败
(`{status:"failed"}`)而不是抛错,流水线只捕获异常,于是那一步被标成 completed。

两条修复:
1. 话题这一步现在检查返回值状态,失败就抛 → 整轮按既有规则变成 `partial`(前面步骤成功也不掩盖),
   `autoAnalysis.lastStatus` 随之如实显示 partial;失败原因留在 `topic_analysis_runs.error`。
2. 自动补算这一路本来就该自愈:采集运行与自动分析并行收尾时,聚类开始之后落库的内容没有向量,
   而**这一步的上一步就是向量化**。所以失败后补跑一次向量、再聚一次;补不出来才算失败。
   给人看的界面那句"请先运行向量化"保留(手动路径仍然提示),但自动流程里没有人去点按钮。

- 覆盖:`tests/integration/analysis-workflow.test.ts` 新增一例,钉住"话题步骤失败 → 整轮 partial +
  失败原因入历史 + 后续步骤不得继续"。

### D50 · 提示词里让模型复述版本号,会把合规输出判成非法

`renderEvidenceForPrompt` 的头两行是 `schemaVersion=…` / `promptVersion=…`,而它紧接在系统提示的
"【输出格式】…字段如下:"之后 —— 模型把它俩当成了 JSON 的前两个字段照抄回去,输出 schema 里没有这两个键,
`unrecognized_keys` 直接判失败。真机表现:一份引用完整、跨平台、纪律良好的方案被丢掉并报
"AI 输出不符合选题方案 schema"。

修在源头(而不是放松 schema):提示词改为明确声明"版本号由系统记录,不是你输出的字段",字段清单指向
证据文本末尾的要求部分;`STUDIO_PROMPT_VERSION` 升到 **studio-prompt-v2**(换提示词就要换版本号,
历史运行仍可按当时版本解释),两处钉住版本号的测试断言同步更新。
schema 保持 strict:不合规模型仍然是失败,不"尽力解析"半成品。

### D51 · 热点派生采集:热榜标题本身就是检索词,不要拿分词片段去搜

目标要求"采集热点话题**以及视频等创作内容**"。热榜渠道拿回来的是标题+热度+链接,
这类条目聚不成簇(实测 973 条里 823 条未归类)、趋势只能靠采集时间推断、选题停在标题层面。
所以加 `server/src/collection/hotCascade.ts`:把当日热榜条目派生成检索词,再用**已有凭证的
搜索接口**取回真正的创作内容(知乎官方搜索:回答正文、作者、赞数、发布时间)。

检索词的口径换过一次,原因值得记:
- 第一版用仓库现成的中文分词(TF×IDF 二字片段)抽词。真机派出的是
  「日本」「28」「生活」「长期」「实际」「其中」——二字片段要么泛到搜出各榜共有的高热回答
  (连续两轮 `accepted=0`,全是重复),要么是虚词片段(有新增但内容不相干)。
- 现在直接用**热榜标题本身**(去符号、截 30 字、按热度排序、前 8 字去重)。
  真机结果:检索词「美中加强农业合作是双赢之举」搜回 5 条,作者含人民日报国际/中国网,
  正文 719–1044 字,真实发布时间与赞数 30/63/69 —— 这才是可聚类、可算趋势、可写选题的数据。

其余边界都是刻意的:
- **任务数量恒定**:每个检索词占一个固定槽位任务(`热点派生 · 检索 #N`),复用而不新建,
  否则半小时一次的定时派生会把采集中心淹掉(有测试钉住"第二轮一个任务都不多")。
- **缺凭证就整轮零写入**:没有 `ZHIHU_ACCESS_SECRET` 时不建任务、不起运行,只回一句原因。
- **节流 + 冷却**:默认 30 分钟内不重复(`force` 供手动按钮绕过);派生过的标题 6 小时内不再搜。
- **自动触发只认热榜渠道**:挂点仍要求任务名以 `热点渠道:` 开头,用户自建搜索任务不会连环派生。
- 开关 `TRENDSCOPE_HOT_CASCADE=0`,派生源可用 `TRENDSCOPE_HOT_CASCADE_CONNECTOR` 换
  (集成测试用仓库自带的确定性源跑通真实入库路径,不打公网)。
- 聚合源的**发布时间与评论数**此前一直被丢掉,现在预置渠道映射了
  `created_at` / `active_time_at`(毫秒时间戳)与 `comment_cnt` —— "缺发布时间 501 条"里有一批本可避免。

### D52 · 排版缺陷必须机器可判:CSS 注释闭合 + 类名存在 + 真实窄屏溢出

使用者反馈"UI 还有显示 bug、排版要优化"。量出来三个**编译期与单测都看不见**的缺陷:

1. `global.css` 里一条中文注释漏了结束符 —— 浏览器把后面一整段规则当注释吃掉,
   `.section-head` / `.section-title` 全部失效(页面小标题的层级与间距静默退化);
2. `.content { min-width: 0 }` 这条规则**根本不存在**(注释里写着"是关键",规则却没落),
   grid 子项默认 `min-width:auto`,宽表格把整页撑出横向滚动;
3. `ReportCenter` 自己套了一层 `.shell > .main`,而 `.shell` 是 App 的「侧栏 + 内容」网格 ——
   报告内容被塞进 232px 的侧栏列里,表格撑出栏外(使用者截图里那条窄栏就是这个);
   并且它用的 `page-head/page-title/page-sub` 三个类**在样式表里没有任何定义**。

对应的三条机器检查(以后这类问题不再靠肉眼):

| 检查 | 位置 | 抓什么 |
| --- | --- | --- |
| 注释成对闭合 + 花括号成对 + 关键规则存在 | `tests/unit/css-integrity.test.ts` | 注释没闭合吞掉规则、`.content/.section-head/.card/table.ts` 规则丢失 |
| 页面写的 class 必须在样式表里有定义;只有 App 能套 `.shell/.content` | `tests/unit/display-conventions.test.ts` | 自造类名(静默无样式)、页面重复套布局容器 |
| 真实浏览器 3 宽度 × 9 路由无页面级横向溢出 | `npm run check:responsive` | flex/grid 子项没设 `min-width:0`、表格没套 `.table-wrap` |

写这条的时候自己也踩了同一个坑:新加的 `css-integrity.test.ts` 文件头注释里写了字面的
注释结束符,把块注释提前关掉,esbuild 报"Unterminated string literal" —— 正是这套检查要抓的形状。

- 顺带修掉的用户可见口径:分析步骤明细把 `averageCohesion / unclusteredRate / needsReviewCount /
  patternInsufficient / profileId balanced` 原样打给用户(标签表缺键时渲染函数回退成裸键名)。
  现在补齐标签,并用服务端真实返回形状钉住"明细里不出现 camelCase 键名与英文枚举值"。
- 报告正文同样不允许出现英文枚举码与 ISO 时间(`tests/integration/reports.test.ts` 里那条
  **必须带数据跑** —— 空库时"最近采集"是"尚无",ISO 断言会空过,这个坑真踩过一次)。

### D53 · WAL 下 `synchronous=NORMAL`,并给演示装载用例一个有实测依据的超时

`npm test` 里 `演示模式 reset` 用例超时(30s 上限)——它要把整个示例语料库(约 5300 行)
走两遍真实导入管线。查下来两件事:

1. **`synchronous` 从来没设过**,SQLite 默认 FULL:WAL 模式下每一行导入都 fsync 一次。
   改成 SQLite 官方推荐的 WAL 配对 `NORMAL` 后,单遍 15.0s → 13.3s、装载+重置 29.7s → 20.8s。
   取舍写进代码注释:进程崩溃仍然安全,只有"操作系统崩溃/断电"时可能丢最后几个事务;
   迁移前有自动备份,`npm run db:backup` 可手动落盘。对本地个人工具,这个交换是划算的 ——
   它同时让每一次采集与导入变快。
2. 剩下的 20.8s 不是 fsync,是逐行 dedup + 多条语句插入的固有成本
   (drizzle + better-sqlite3 的同步事务回调里不能 `await` 逐行异步查询,
   所以不能简单把导入循环包进事务 —— 那会静默改变提交时序,风险大于收益)。
   因此给这两条用例显式 90s 超时,并把实测数字写在注释里:
   **超时是为了留出"套件与本机应用抢 CPU"的余量,不是为了掩盖变慢**。
   若将来这条用例涨回 60s+,那是导入路径真的退化了,应当去查而不是再调大超时。

### D54 · 「热点渠道:*」任务的定时档归应用所有,用户改过的间隔不归

使用者反馈"还是没多平台的数据"。查下来不是采不到,是**采完就不再采**:
`POST /api/hot/capture` 第一次点的时候按渠道建任务,建的时候写死 `schedule: {type:"manual"}`,
12 条渠道任务里 7 条因此停在手动档 —— 调度器只看 `nextRunAt`,手动档永远不会被拾取。
用户视角就是"我点了一次有数据,之后就再没有过"。

取舍:这些任务是本接口按渠道预设建出来的,名字也由预设拼出(`热点渠道:${label}`),
**它归应用所有**,所以应用有权把它修回可运行状态;但用户可能进「采集中心」自己调过间隔,
那是明确的人类意图。于是规则是两条:

- 发现同名渠道任务不是 `interval` 档 → 补回预设档(默认 30 分钟,周榜类 6 小时)并 `enabled=true`;
- 已经是 `interval` → 一个字都不改(哪怕它不是 30 分钟)。

不做的事:不去比对 config 判断"这条任务是不是被改坏了",也不去改用户改过的采集内容。
按名字键控是这里唯一稳定的身份 —— `findOrCreateTask` 本来就只按名字找。

回归测试用 `fixture-remote` 顶替同名渠道任务离线跑真实代码路径(仓库自带的确定性源,
不打公网):一条钉"手动档被升回 30 分钟且不多建任务",一条钉"90 分钟不被改回 30 分钟"。
两条都做过变异验证 —— 把修复条件写死成 `false` 时第一条红,写死成 `true` 时第二条红,
不存在空过的断言。

### D55 · 补算重试以"再试一次"为准,不看那次补算报了几条成功

流水线里 `更新内容向量 → 话题分析` 相邻两步。采集一多,自动补算(采集完成时触发)和
用户手点的「刷新全部分析」会同时在跑,两者都会给缺向量的内容建向量化任务。

原先话题分析的重试条件是 `if (ej.succeeded > 0)`:本轮这个任务报 0 条成功就认定"补算没用",
直接把上一轮的 `44 条内容缺少向量` 抛出去。但**并行那个任务把向量补齐了**,本次任务当然无事可做 ——
`succeeded=0` 在这里的含义是"别人干完了",不是"补算失败"。界面上看到的就是一个自相矛盾的报错。

改成:补算之后固定再试一次聚类。代价可控 —— `runTopicAnalysis` 在进入聚类之前的第 2 步
就检查缺向量并返回 `failed`,不会白跑一整轮 O(n²) 的相似度计算。

真机依据:`analysis_runs#139` 的 `topics` 步骤带着 `reembeddedAfterMissing: 44` 完成,
47 个话题、平均内聚度 0.911;此前同一批数据这一步是 failed。

顺带记一条实测口径:`topics` 这一步耗时 277.9s(1,394 条内容)。聚类是全量重聚,
耗时随条目数接近平方增长 —— 30 分钟一轮的自动采集会让它越来越长。当前不会叠跑
(引擎锁 + 自动补算遇忙即跳),但库长到几千条之后该改成增量聚类,这是下一步的事,
现在先在文档里如实记着,不在界面上假装它很快。

> **编号说明(2026-09-29 补)**:本文件里没有 D56 这一节,也没有任何地方引用它,共 57 条决策。
> 原因没有记录可查 —— 留这一行是为了避免下次有人以为"丢了一条"而去翻历史。

### D57 · 浏览器采集:用真实浏览器读页面,但不做反检测

使用者要求:「接口探测不到就用 playwright 看热门话题,为避免移除尽可能模拟人的使用流程」。
这句话里有一半能做、一半是这条产品线的既有边界(见 D47:不伪造签名、不做检测规避),
所以拆开处理。

**做了什么** —— 一个新连接器 `browser-page`:用**使用者本机已装的 Chrome / Edge**
(`playwright-core`,不下载浏览器)打开页面,读渲染完成后的 DOM。配置只有地址、
条目选择器、字段取法三件事,一次开一个页面、只取一屏、并发 1、最小间隔 1 分钟。

**没做什么,以及为什么**:

| 不做 | 原因 |
| --- | --- |
| 伪造 `x-s` / `a_bogus` 之类的接口签名 | 那是逆向平台的访问控制,不是"换个方式看公开数据" |
| 无头模式开关、UA/TLS 指纹伪装、代理轮换 | 这些手段的唯一作用是让平台的反爬系统认不出来 —— 属于检测规避 |
| 破解验证码 / 代用户点登录 | 越过的就是"证明你是人"这道门 |
| 翻页爬取、点进详情页 | 热榜是一屏公开信息;往下钻就变成了批量抓取 |

实测把边界画清楚也有价值:同一台机器、同一个地址,
无头模式访问 `xiaohongshu.com/explore` 直接被判 `300012 IP存在风险`,
有头(看得见窗口)则正常打开 —— 说明"要不要被识别为自动化"正是那道门,
所以本产品的选择是**不藏**:窗口是看得见的,登录是用户自己点的,
被要求登录时报错停下来说明怎么做,而不是想办法绕过去。

**小红书因此没有一键渠道**:它的热榜登录后才渲染,而登录只能由用户本人完成。
应用提供的是「打开浏览器,我去登录」按钮 + 可配置的浏览器采集任务模板。
在用户登录之前,任何写死的小红书选择器都是猜的,猜的按钮比没有按钮更糟。

**抖音不需要浏览器**:它的公开热搜榜接口 `iesdouyin.com/.../billboard/word/`
零凭证、无签名就能拿到 50 条(实测),所以定时采集走接口;
浏览器路径留给"登录后才有的内容"。浏览器采集抖音热榜页面也真机跑通了
(能多拿到每条话题的链接,这是接口没有的),但它会弹窗口,不适合挂在 30 分钟定时档上。
(这一点在下一轮由 D58 的 `onDemandOnly` 落实成代码,而不只是口头约定。)

### D58 · 读页面自己收到的那份 JSON,而不是替页面去签名

D57 之后抖音只有"话题"没有"内容":接口给的是 `word_list`(话题名 + 热度值),
DOM 采集给的是热榜链接,而使用者要的是「视频等创作内容」。热榜页面确实显示了视频条目,
但那些条目不在 DOM 的 class 里可以稳定取到 —— 它们是页面自己发一个 XHR 拿回来再渲染的。

**决定**:连接器加第二种模式 `mode: "network"` —— 在 `goto` 之前挂 `response` 监听,
按 URL 片段筛出页面已经收到的那个响应,只读它的 JSON。
签名仍然由页面的脚本完成,我们只是**旁观它已经拿到的东西**;
没有构造请求、没有补参数、没有伪造任何 header,所以这不越过 D47/D57 划的那条线。

**边界靠结构保证,不靠自觉**:

| 约束 | 落点 |
| --- | --- |
| 只按白名单取字段 | `fields` 是点号路径的映射表,配置没写的键(如 `authentication_token`)不会进 item |
| 整包不入库、不入日志 | 只把映射后的行交给上层;日志只有条数,没有 body |
| 不接大响应 | 超过 8 MB 的响应直接丢弃,不解析 |
| 取一屏 | `maxItems` 合法范围 1..100(超出直接判配置非法);抖音这条渠道配的是 10 |
| 会弹窗口就不定时 | `onDemandOnly: true` → `channelSchedule()` 返回 `{type:"manual"}`,调度器永不拾取 |

真机:渠道「抖音热门视频(浏览器)」一次采回 10 条视频,含作者昵称、
点赞/评论/分享/收藏、发布时间(`create_time#unix` 转 ISO)、`contentType: "video"`
由配置常量写入。回归用例里有一条 `expect(JSON.stringify(r.items)).not.toContain("authentication_token")`,
专门钉住"白名单之外不留痕"这件事 —— 将来有人把映射改成整包透传,这条会先红。

**为什么抖音接口仍然是主路、浏览器只是补充**:零凭证的 `billboard/word/` 能定时、能自动、不弹窗;
浏览器模式每次都要有人看着。所以两者并存,界面里如实写成两个渠道,
而不是把接口那份数据伪装成"视频内容"。

### D59 · 熔断的粒度是"来源",不是"连接器"

隔夜的真实账目(2026-09-29 → 09-30 只读 SQL 查出来的):`generic-http` 一个连接器下 9 个渠道
各出现 **21 次 `RATE_LIMITED`**,而它们指向的是不同主机(B站、HN、IT之家、百度、头条、知乎聚合、贴吧、豆瓣…)。
根因不是远端限流,是本地的熔断器 `Map` 以 `connectorId` 为键 ——
一个聚合站连续 500 把 `generic-http` 的熔断打开,其余所有源的下一次运行直接被判 `RATE_LIMITED`。
界面上就是一片红,而这些源其实完全健康。

**决定**:熔断键 = `连接器 + 目标主机`(`sourceScope()` 从任务配置的 `url` 取 hostname;
取不到就退回连接器粒度,不改变原行为)。

| 为什么这样切 | 说明 |
| --- | --- |
| 熔断要保护的是"被打的那个源" | 限流/宕机是主机的事,与"用哪个连接器实现去请求"无关 |
| 同主机的多个渠道仍共享一个熔断 | 六条都走 60s 的渠道本来就是一个源,一起退避是对的,不是误伤 |
| 健康检查要说清是谁挂了 | 说明文案补上「当前挂掉的来源:xxx」;`breakerSnapshot()` 改为取该连接器名下**最坏**的那个源,不会把"有一个源在熔断"报成"一切正常" |

回归用例在 `tests/integration/collection.test.ts`:同一连接器、`bad.test` 与 `good.test` 两个任务,
把坏主机跑到熔断后,**好主机的任务必须仍然 completed**。
变异验证:把熔断键改回 `task.connectorId` → 该例立即变红;改回来 → 24 例全通过。

**顺带记一个不是 bug 的现象**:小红书聚合渠道 09-30 01:23Z 那轮 `completed`、fetched 20、**accepted 0 / dup 20** ——
上游恢复了,但榜面标题与库里已有的 29 条重合,所以没有新行。这是去重生效,不是采集失败。
使用者 2026-09-30 明确「小红书不行就不做了」,因此不做第一方采集、不预置猜测的选择器,
只保留这条聚合渠道(它会自动重试)。

### D60 · 任何被读来判"是否忙"的状态,都必须有启动时的收尾

同一个仓库里有两套"有没有任务在跑"的判据,但只有一套配了重启恢复:

| 状态表 | 谁读它 | 崩溃/重启后谁收尾 |
| --- | --- | --- |
| `collection_runs` | 调度器、界面运行历史 | **有** —— §16 `recover()` 标 `failed/INTERRUPTED`,checkpoint 留着可续 |
| `embedding_jobs` / `topic_analysis_runs` | `fullRefresh.busyReason()` 用它决定"这一步跳过" | **没有** —— 孤儿行永远停在 `running` |

后果不是"显示不准",而是**功能永久停摆**:`busyReason()` 只要数到一条 `queued/running`
就返回「已有同类任务在进行中,本次跳过(不重复启动)」,而这句在界面上看起来完全合理。
实测账目:3 条向量作业(最老 05:02Z)+ 1 条话题分析(11:53Z)是重启留下的,
向量化从 09-29 19:53 起到 09-30 10:01(本地)约 14 小时零增长(2,206 向量 vs 2,909 内容),
期间采集照常跑、每轮自动补算照常"完成",只有那两步一直显示已跳过。

**决定**:把这两张表并入同一个启动恢复钩子(`scheduler.recover()` 第 3 步),
标 `failed` + 中文原因 + `completedAt`,并在启动日志里报出释放条数。
**不引入心跳/租约**:本机单进程应用,进程刚起来时不可能有别的东西在替它跑,
`running` 出现在启动那一刻本身就是证据,不需要再用超时去猜。

**通用规则(下次加任何长任务照这条)**:凡是被读来判"是否忙"的状态,
必须同时回答"进程重启后谁来把它收尾";否则宁可让界面显示"上次异常中断,点这里重试",
也不要让它永远显示"正在进行中"。

真机验证:改动落地后开发服务器自动重启,4 条孤儿全部变 `failed`、
两张表的 `queued/running` 残留归零,新提交的向量作业立刻被接受并开始跑。
回归断言并入 `tests/integration/collection.test.ts` 的重启恢复用例。

### D61 · 死在"改成 running 之前"的任务,也要写终态(D60 的另一扇门)

D60 收的是"进程重启留下的孤儿"。2026-09-30 下午在**同一张表、同一个判据**上从另一个门又进来一次:
`runEmbeddingJob` 的顺序是「select 任务 → 探测向量空间(`ensureSpaceProbed`)→ 标 `running` → 干活」,
而 openai 兼容 provider 把 `dimension` 声明为 0、维度靠首次探针实测 —— 于是**服务连不上时异常发生在标 `running` 之前**,
那一行永远停在 `queued`,谁也不会再碰它。

| 现象 | 实测账目(本机) |
| --- | --- |
| 死行堆积 | BGE-M3 适配器 12:19 停掉,一小时内 `embedding_jobs` 堆出 **50 条 `queued`**(`started_at` 全空) |
| 判据被毒化 | `fullRefresh.busyReason()` 数到 `queued>0` → 每轮都「已跳过(已有同类任务在进行中)」 |
| 下游连带 | `topic_analysis_runs` 连续 20 轮 `failed`,原因「N 条内容在空间…缺少向量」 |
| 数据停滞 | 待向量化 289 → 355 条零进展;每轮采集完成还并行触发 6–11 次注定失败的全量聚类尝试 |

**决定**:探测包一层 catch —— **先写终态(`failed` + 中文原因「向量服务探测失败:…」+ `completedAt`),再把异常原样抛出去**。
不吞异常、不改调用方的错误处理、不新增"卡住任务回收"的定时扫描。

| 为什么这样收 | 说明 |
| --- | --- |
| 与 D60 同源但不同机制 | 重启收尾救不到"同一次运行里当场留下的行";凡把状态读成"是否忙",**写状态的一方就要保证任何出口都落终态** |
| 抛出而不是返回 | 调用方(fullRefresh 步骤、`POST /embedding/jobs`)已经在展示异常,改成"返回失败"会让它们以为任务正常跑完 |
| 界面因此说得清 | 向量化任务列表从"排队中(永远)"变成"失败 + 原因",使用者能一眼看出是向量服务没起 |

回归用例:`tests/integration/embedding.test.ts` §「向量服务不可达时的收尾」——
用 `dimension: 0` 且 `embedBatch` 必抛的 provider 跑一次任务,断言行状态为 `failed`、原因含中文前缀,
并断言不变量 `count(status in ('queued','running')) == 0`。
变异验证:把写终态改成写回 `queued`(等价于修复前)→ `expected 'queued' to be 'failed'`,用例红。

**没做的事**:自动分析在每轮采集后按渠道并行触发多次(向量服务正常时第一次成功、其余被
「没有未归类内容」挡掉,所以只在坏状态下才成为风暴)。给它加去抖要动调度语义,不在这一轮动。
库里那 50 条死行由 `tsx watch` 重启时 D60 的收尾自动标为 `failed`(实测 `queued` 50 → 0),未手改。

### D62 · 检查清单要从被测物派生,并且断言"量到的就是请求的那个"

`check:responsive` 手抄了一份路由清单,其中 `/content` 需要 `:id`,单独访问命中 `<Route path="*">`
被重定向回 `/dashboard`。探针只比 `scrollWidth > innerWidth`,对"停在哪个页面"一无所知,
于是这个检查连续多轮把"9 个页面"量成了 8 个,还每次都报 `ok`。
漏掉的 5 页里正好包括使用者这轮投诉的**重复治理**页(三栏网格 + 超长微博 URL,全站最容易溢出的就是它)。

**决定**:两条一起改,缺一不可。

| 改动 | 为什么 |
| --- | --- |
| 路由清单从 `src/App.tsx` 的侧栏导航数组现取 | 侧栏就是"使用者点得到的页面"的权威定义;手抄必然漂移。新增页面自动进清单,不用记得改脚本 |
| 探针额外回报 `finalHash` + 页面标题,停错地方判失败 | 只防"漂移"不够,还要防"量了 A 报成 B"。**一次检查要同时断言覆盖与命中** |
| 解析结果少于 10 条直接报错退出 | 否则正则失效 = 空清单 = "通过 0 项",这是最坏的假绿 |

三条都做过证伪:塞回 `/content` → `✗ 411px /content → 实际停在 /dashboard(「数据总览」),这一页没被量到`(exit 1);
把解析正则改坏 → `只解析出 0 条路由…拒绝以"通过"收场`(exit 1)。
改完 14 条 × 3 档 = 42 次真实渲染全过。

**通用规则**:凡是"清单型检查"(路由、渠道、枚举值、表名),清单本身要么从被测物派生,
要么加一条"清单与来源不一致就红";检查报告里必须带上"我这次量到的是谁"的可核对凭据(标题、ID、主机名),
否则漏测会以"全绿"的形式出现,永远看不出来。

### D63 · 唯一索引不含 `superseded_at`,那"标作废 + 重插同 hash"就是一次自我删除

`status.ts` 顶上写着"这是产品走到哪一步的唯一回答处,不允许每个页面各自拼 SQL,否则同一个事实会在三处给出三个答案"。
2026-09-30 下午真机就是三个答案:

| 谁在问"这条内容有向量吗" | 它的判据 | 当时给出的答案 |
| --- | --- | --- |
| `getAnalysisStatus().semantic` | `embedded` = `content_embeddings` 全表行数;`pending` = 不带过滤的 left join | **1 条待处理** |
| `runTopicAnalysis` | `listSpaceEmbeddings` = 激活空间 + `superseded_at is null` | **576 条缺少向量 → 本轮失败** |
| `embeddedItemIds`(向量化作业) | 同上 | 577 条待嵌 —— 于是每轮重嵌、每轮白烧 |

前两行才是"1 条 vs 576 条"这对矛盾的来源。而 577 条之所以**再也补不回来**:

```
唯一索引 uq_embedding_item_space_hash = (content_item_id, embedding_space_id, text_hash)   ← 不含 superseded_at
upsertEmbedding:① 把 (内容, 空间) 的活跃行标 superseded ② insert 同 hash 新行 + onConflictDoNothing
```

评分/指标刷新走 §28 把向量标作废时,**语义文本根本没变**,所以第 ② 步必然撞自己的索引、被静默丢弃。
实测账目:10:41 一次批量更新作废 579 行 → 之后约 4 小时里 577 条内容只有一行"已作废",
话题分析连续 20+ 轮 `failed`,`unclustered` 从 72 涨到 3,165,每轮还重新嵌一遍这 500 多条(约 12 分钟真实推理)再丢弃。

**决定**:

| 改哪 | 怎么改 | 为什么这样 |
| --- | --- | --- |
| `upsertEmbedding` 的冲突分支 | `onConflictDoNothing` → `onConflictDoUpdate`,**把那一行 `superseded_at` 清空并刷新 vector/updatedAt** | 同一个 hash 就是同一份语义文本,原向量仍然有效 —— 复活它比重新嵌入更省,也更符合 §28"保留历史"的意图 |
| `getAnalysisStatus` 的 `embedded` / `pending` | 统一成"激活空间 + 未作废"这一条判据,与聚类、向量化作业同源;没有激活空间时 `pending` 如实等于内容总数 | 首页那句"向量 N 条已建,M 条待处理"是使用者判断"要不要手点运行向量化"的唯一依据,它不能和引擎的判据不是一回事 |

**没有改索引**(`superseded_at` 加进唯一索引会让"同一份文本的历史行"只能留一条,§28 的保留历史就没了),
也**没有加"定期回收作废行"的扫描** —— 那是在给一个可以就地闭合的写路径打补丁。

回归用例两条,都做过证伪:
- `tests/integration/embedding.test.ts` §「D63」:嵌入 → `markSuperseded` → 再跑一次 `missing` → 该条目必须重新拥有活跃向量。
  改回 `onConflictDoNothing` → `expected false to be true`。
- `tests/integration/analysis-workflow.test.ts` §「同一判据」:两条已建、第三条待处理;把其中一条标作废之后
  必须立刻变成"1 已建 / 2 待处理"。去掉 `superseded` 过滤 → `expected 2 to be 1`。

真机自愈验证(不手改数据):代码落地后走产品自己的 `POST /api/embedding/jobs {scope:"missing"}`,
544 条一轮跑完,缺向量的条目数应归零、话题分析应重新 `completed`。数字记在 `docs/TEST_STATUS.md` 第 (十) 轮。
