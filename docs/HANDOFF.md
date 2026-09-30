# TrendScope 项目交接（HANDOFF）

> 写给接手这份项目的下一个 Agent 或开发者。读完这一页即可开工。
> 最后更新：**2026-09-30(晚)** · 搬到第三台机器后全量复验通过(720 例 / 14 项闸门 / 42 次渲染)+ 精简交付包已产出 —— 见 docs/TEST_STATUS.md 第 (十) 轮。
> 上一版:**2026-09-27** · **Release 1.0 已交付**（WP1 AI 选题工作室 / WP2 完整产品工作流 / WP3 安装与数据库安全 / WP4 全产品走查 / WP5 发布交付）
> 发布说明:docs/RELEASE_NOTES_1.0.md · 更新记录:CHANGELOG.md · 闸门:npm run verify:release
> 本轮实测账本（7 个真实缺陷的复现与验证方式）在 docs/TEST_STATUS.md 的 2026-09-27 两节
> 审查的完整证据链（每条缺陷的验证方式）在 `docs/AUDIT-2026-09-25.md`，本文只给结论与操作。

## 0. 一句话

跨平台内容趋势与选题决策系统：多平台内容标准化入库（**永不丢原始数据**）→ append-only
指标快照 → 趋势动量 → 语义向量 → 相似内容 → 话题聚类 → 人工治理 → 内容爆发指数 / 话题
趋势指数 / 生命周期（Stage 7）→ 共性 / 饱和度 / 新颖度（Stage 8）→ 选题机会指数 + 决策
（Stage 9）。纯本地：SQLite + Express + React，零云依赖，**无任何 API Key 也能全链路运行**
（词法回退）。

**当前状态：Release 1.0 已交付(版本号只写在 package.json)。用户验收仍未做。**  
历史阶段编号(Stage 1–9.5)保留在各自文档里作为口径出处,不再作为开工单位;§9 的旧"Stage 10 候选"清单仍按原约束**勿自动开工**。
9.5 只收口三件事：筛选竞态根治、机会模型可治理、趋势分数可解释 —— **没有新增任何分析算法**。

## 1. 项目位置 / 搬迁

当前路径（Windows）：`C:\Users\Administrator\Desktop\trendscope`
（2026-09-27 迁到 `C:\Users\EDY\Desktop\trendscope`,**2026-09-30 又搬回 Administrator 这台机器**。
`node_modules` 不跟着搬 —— better-sqlite3 是原生模块,跨机器拷贝必挂,到新机器一律重装。
交付副本在 `C:\Users\Administrator\Desktop\TrendScope-1.0.0`(304 MB,只含生产依赖与已构建产物);
**Windows 路径不区分大小写**,`Desktop\TrendScope` 就是 `Desktop\trendscope` 本身,做副本时目标名必须真正不同。）

**本仓库不是 git 仓库，没有任何版本控制。** 改坏了无法 `git checkout` 回滚 —— 动手前先
按 §1.1 备份，并且**不要对源码跑宽泛的正则批量替换**（§6.10 有真实事故记录）。

迁移打包（排除 node_modules 与构建产物 —— better-sqlite3 是原生模块，跨机器拷贝必挂）：

```bash
cd C:\Users\EDY\Desktop
tar -czf trendscope-handoff.tar.gz --exclude=node_modules --exclude=dist --exclude=dist-server -C . trendscope
```

- **必须带**：`server/ src/ tests/ drizzle/ docs/ scripts/ package.json package-lock.json` 及各 tsconfig / vite 配置
- **必须带**：`data/` **整个目录**（含 `trendscope.db-wal`）；只拷 `.db` 单文件会丢数据，见 §1.1
- **不要带**：`node_modules/ dist/ dist-server/`

## 1.1 备份与 WAL（必读 —— 上一版的备份方式是错的）

库运行在 SQLite WAL 模式下。**只复制 `data/trendscope.db` 主文件得到的是一份自洽但陈旧的
库**，因为近期写入可能全部还在未检查点的 `-wal` 里。

接手时实测到的事故：主文件停在 9/24 23:41，而 Stage 6B–9 的全部数据（话题 / 评分 / 情报 /
机会，约 4.1 MB）只存在于 `trendscope.db-wal`；`data/backup/` 里三个"迁移前备份"就是用
`cp 主文件` 生成的，各只有 23 张表、缺 Stage 6B–9 全部表 —— 真出事时按它们回滚会**静默
抹掉四个 Stage 的成果**。

正确做法（已落地为脚本）：

```bash
npm run db:backup                  # SQLite 在线备份 API（读穿 WAL）+ 表数/行数/integrity 逐项校验
npm run db:backup -- --checkpoint  # 备份后再把 WAL 折叠回主文件，使单文件自包含
npm run db:backup -- --verify-only # 只体检不写文件
```

当前真机库状态（2026-09-26）：45 表 / 529 行 / integrity ok，**已 checkpoint 成自包含单
文件**，可用备份为 `data/backup/trendscope-20260926-150753.db`。
`data/backup/` 里三个 `trendscope-pre-000{8,9,10}-*.db` 是上一版留下的**残缺副本，保留未删
但不可当作可用备份**。

> **2026-09-30 更正(使用者要求精简文件夹)**:上面提到的 `data/backup/` **整个目录已删除**
> (36 个快照、318 MB,含那句里的"可用备份 `trendscope-20260926-150753.db`"),
> 同时删掉的还有 `data/browser-probe/`(80 MB 探测脚本残留)与 `TrendScope交接/`(09-27 的项目快照 tarball)。
> 删除前先验过当前库:`PRAGMA integrity_check = ok` / 3,209 条内容 / 88 话题 / 29 任务。
> **所以现在本机没有备份** —— 要备份就跑 `npm run db:backup -- --checkpoint`(约 1 GB,
> 因为库里有 53 万行评分快照,见 TEST_STATUS 第 (八) 轮末尾那条增长账)。
> 本节上面那些指向 `data/backup/...` 的句子保留作历史,读的时候按已删除处理。

## 2. 立刻能跑的命令

```bash
cd C:\Users\Administrator\Desktop\trendscope
npm run typecheck        # client + server strict，当前 0 error
npm test                 # vitest run → 720/720 PASS（63 文件,本机 154.58s）
npm run build            # tsc(server) + vite(前端)
npm start                # node dist-server/index.js → http://localhost:5184
npm run db:backup        # 动真机库之前先跑这个（见 §1.1）
npm run eval:topics      # 话题聚类质量（golden，词法基线）
npm run eval:scoring     # 评分引擎（fixture A–H + 生命周期）
npm run eval:opportunity # 机会引擎（golden A–F，输出排序与原因）
npm run smoke:zhihu      # 无凭证 → SKIPPED_NO_CREDENTIAL（exit 0，设计行为不是失败）
npm run smoke:embedding  # 同上
npm run check:responsive   # 需要应用已在跑;浏览器候选是 Chrome → Edge(本机只有 Edge)
```

**运行环境：系统 Node v24（ABI 137）。** 本机为 v24.19.0。上一版文档要求统一用
`.workbuddy\...\node\versions\22.22.2-3` 的 managed node，**已作废**：`better-sqlite3`
的原生二进制当时按 Node 22（ABI 127）编译，而本机默认是 v24，导致 `npm test` 有 17 个
文件直接崩在模块加载上（`NODE_MODULE_VERSION 127 vs 137`）。现已在 Node 24 下装好
ABI-137 prebuild，**请用系统 node；切回 node 22 会以同样的 ABI 错误崩溃**。

**★2026-09-27 新增（不看会以为套件坏了）**：`better-sqlite3` **12.11.1** 在 Node 24.19 下
会让 vitest worker 在退出阶段原生 abort（`Assertion failed: (env) != nullptr`，栈含
`Statement::~Statement`），31 个文件里 11 个崩、`npm test` 退出码 1 且结果不落盘。
已把依赖收紧为 `~12.10.1`（caret 版本会解析回 12.11.1），详见 `docs/DECISIONS.md` **D23**。
判据：`npm test` 输出 `Tests 426 passed (426)` 且日志中崩溃标记为 0。

换机器或换 Node 大版本后，若再遇到 `NODE_MODULE_VERSION` 不匹配：

```bash
cd node_modules/better-sqlite3 && node ../prebuild-install/bin.js
```

（本机无 Visual Studio，`npm rebuild` 走不通；prebuild 成功就不需要它。）

## 3. Stage 完成史（明细见 docs/PROJECT_STATE.md）

| Stage | 内容 | 状态 |
| --- | --- | --- |
| 1 | 数据底座：RawRecord/ContentItem/MetricSnapshot/ImportBatch + csv/json/manual/fixture Adapter | ✅ |
| 2 | 时间语义（TZ 假设显式）、FTS5、Duplicate Governance、Data Quality | ✅ |
| 3 | Raw Momentum（改名 + 平台权重）、Trends、Candidate Workbench、Snapshot Timeline | ✅ |
| 4 | Collection Runtime：Task/Run/Scheduler/Queue/RateLimit/Retry/Breaker/Checkpoint/Resume/Partial/Cancel/SchemaDrift/SecretRef/Event + Collection Center UI | ✅ |
| 5 | Zhihu Official Connector（官方 API、Replay 契约测试、Live Smoke 待凭证）+ DiscoveryObservation（0005） | ✅ |
| 6A | SemanticTextBuilder / EmbeddingProvider 抽象 / Lexical Fallback / OpenAI-Compatible / EmbeddingSpace / VectorRepository / Similar Content / Embedding Job（0006） | ✅ |
| 6B | Topic Clustering（投影预筛图聚类）/ Reconciler 稳定 ID / TopicSnapshot append-only / Evolution Event / 人工治理（重命名·合并·拆分·移动·watch）/ 话题 UI（0007） | ✅ |
| 7 | 内容爆发指数（Cohort/Percentile/Creator Baseline/Missing-aware）+ Topic Trend（5 组件）+ Lifecycle（6 态 + 滞回）+ 趋势中心 UI（0008） | ✅ |
| 8 | 爆发共性（匹配控制组 + Lift）+ 话题饱和度（角度相似/重复率/集中度）+ 新颖度（新兴角度簇）+ 话题洞察 UI（0009） | ✅ |
| 9 | 选题机会指数（六组件 + 置信分离 + reason codes / delta / whyChanged）+ 机会工作台 + 人工决策（0010） | ✅ |
| 9.5 | 请求可靠性层 useResource（7 页迁移）· Opportunity Profile 落库 + 版本化 + 治理 UI · 趋势分解服务端唯一真源（0011/0012）· 44 例新测试 | ✅ 2026-09-27 |
| — | **全量接手审查与修复**（环境 / WAL 备份 / 14 项后端 / 约 20 项前端 / 设计打底 / HTTP 契约测试） | ✅ 2026-09-25 |

UI（前端为 **HashRouter**，路由带 `#/`）：01 数据总览（含机会统计）/ 02 导入中心 /
03 内容浏览器 / 04 重复治理 / 05 趋势（话题趋势 + 内容爆发）/ 06 内容候选工作台 /
07 采集中心 / 08 语义中心 / 09 话题（趋势区 + 洞察区 + 机会区）/ 10 选题机会工作台 / 11 机会模型（Profile 治理）。
**话题详情现可深链**：`#/topics/:id`。

## 4. 代码地图（全部相对 `server/src/`）

```
app.ts               HTTP 层装配（★新：从 index.ts 拆出，让测试能直接打真实路由）
index.ts             启动：迁移 → FTS 回填 → scheduler → createApp().listen()
routes/errors.ts     ★新：统一错误映射（zod/参数→400，not found→404，其余 500 且落日志）
services/engineLock  ★新：跨路由引擎锁，四个分析引擎的防重入（含 wait:true 与 full-refresh）
routes/              api / collection / embedding / topics / scoring / intelligence / opportunity
                     机会路由另含 /api/analysis/full-refresh（Stage 7→8→9 编排，只调用不拥有逻辑）
db/schema.ts         40 张声明表（实库含 FTS 影子表共 46 张）；迁移 drizzle/0000-0012
                       启动自动原地应用，禁删库
db/client.ts         openDb / migrate（迁移记账按文件名 hash，**改已应用的 SQL 不会重放**）
adapters/            SourceAdapter（csv/json/manual/fixture/zhihu）—— 唯一 RawRecord→Normalized 路径
services/import.ts   唯一导入管线（RawRecord→Item+Snapshot）
services/trendService.ts       动量 / 趋势（含话题上下文）
services/collection/ Stage 4 运行时（runtime / scheduler / service）
services/secrets/    secretResolver（secretref:env:NAME 唯一解密点）
semantic/            6A 语义层（builder / lexical / openai / vectorRepository）
topics/              6B（config / clustering / keywords / analysis / governance / eval / goldenDataset）
scoring/             Stage 7（profiles / percentile / cohort / metricProfile / creatorBaseline /
                     confidence / contentBurst / topicTrend / lifecycle / repository / service）
intelligence/        Stage 8（features / semanticFeatures / angleText / viralPattern /
                     saturation / novelty / profiles / repository / service）
opportunity/         Stage 9（profiles / engine / repository / service）+ 9.5 profileStore（治理唯一入口）
connectors/ + domain/  Connector contract / HTTP base / registry / 错误分类·限速·重试·断路器
前端  src/pages/     11 个导航页；src/components/ 共享件（MomentumTable / ScoringBadges / TrendBreakdown /
                     TopicIntelligence / BurstScoreCard / FeatureDebugCard / LineChart / badges）
前端  src/lib/       api.ts（fetch 封装，放行 AbortError）/ **useResource.ts（取数唯一入口：abort + 代次守卫）** / format.ts（null→"—"、无假精确）
测试  tests/         unit/ + integration/；★新增 http-contract.test.ts、engine-lock.test.ts
```

三个模型文档是理解评分的唯一正解：`SCORING_MODEL.md`（7）、`CONTENT_INTELLIGENCE.md`（8）、
`OPPORTUNITY_MODEL.md`（9）。

## 5. 关键决策（完整记录见 docs/DECISIONS.md D1–D22，勿凭感觉推翻）

- **D1** 表名 `topic_picks` / 列名 `momentum_score` 保留（兼容决策）；域层叫 ContentPick；
  未来真正的 Topic Engine 不得复用该概念。
- **D3** 动量分一律叫 **Raw Momentum（原始互动动量）**，禁用 Viral/Trend/Opportunity Score 称谓。
- **D5** 知乎 ContentID 用 `contentType:id` 组合键（question / article 数字 ID 独立空间）。
- **D9** 文本更新 → 旧向量标 superseded，不物理删除。
- **D10** 检索 = 确定性随机投影（32 维）预筛 + 精确 cosine；5 万条以上再评估 sqlite-vec。
- **D11** 词法向量 bigram3/unigram0.5/word2 + **模板词停用表**（讨论/内容/分享… 会跨主题
  桥接成垃圾簇 —— 6B 实测教训，勿删）。
- **D20** Pattern 无行 = unknown（不是 0）；"分析了但无模式"与"样本不足"暂不可区分。
- **6B** `topicIdentityThreshold=0.3`、lexical `similarityThreshold=0.3` 集中在
  `server/src/topics/config.ts`（golden 实测校准）；空语义文本条目永不向量化，归 unclustered。
- **通用红线**：`null ≠ 0`；unscorable 永远显示"数据不足"而不是 0 分；UI 禁因果/推荐话术
  （导致 / 因此会爆 / 提升爆款率 / 系统推荐 / 最佳选题 / 必做 / 稳赢）。

## 6. 环境坑（本机实测，不看必踩）

1. **★不要对源码跑宽泛的正则批量替换。** 本次审查中一条"删除空括号"的规则连带删掉了代码
   里所有真实的 `()`，16 个 `.tsx`、约 350 处语法错误（`useEffect(() =>`、`new Map()`、
   IIFE 尾括号、`useParams()`、`q.toString()`、`void load()` 全中）。因为无 git，恢复极其
   昂贵。**批量改代码前：先确认有可用还原点，规则要能证明是窄的，改完必须真机渲染验证。**
2. **`tsc` 干净 ≠ 正确。** 上述事故里 `q.toString`（缺 `()`）和 `void load` 都能通过类型
   检查，但内容浏览器渲染出 **0 条**。前端只能靠浏览器逐页核对"有没有渲染出数据"来验收。
3. **交接 tarball 里的源码不是可靠还原点。** `TrendScope交接/trendscope-handoff.tar.gz`
   是 9/24 打的，早于 Stage 4/7 之后的改动 —— 用它恢复会**静默回退功能**。要用快照前先做
   判据校验（能否逐字节复现当前文件），不能只看文件名。
4. **浏览器缓存会伪装成"修复没生效"。** `express.static` 下改完前端要带 query（如
   `?v=2`）强刷，否则跑的是旧 bundle。
5. **npm registry 极慢**：装依赖用
   `node <node_dir>\node_modules\npm\bin\npm-cli.js ci --prefer-offline --no-audit --no-fund --ignore-scripts`。
6. **esbuild postinstall EBUSY**（新机器）：`npm ci --ignore-scripts` 后手动把
   `node_modules\@esbuild\win32-x64\esbuild.exe` 复制为 `node_modules\esbuild\bin\esbuild`
   （嵌套同名目录逐层处理）；better-sqlite3 用 §2 的 prebuild-install 命令补。
7. **HashRouter**：页面路由全在 `#/` 后（`http://localhost:5184/#/topics`），直接访问
   `/topics` 404。
8. **drizzle builder 是 lazy 的**：`void db.insert(...)` **不会执行**，必须 await。
   （注：better-sqlite3 是同步 dialect，`db.run()/.get()/.all()/transaction` 会立即执行，
   本次实测评分/情报/FTS 写入均正常；但**新代码一律显式 await**，别赌。）
9. **Git Bash 内联脚本的反引号 / `${}` 不可靠**（eval 会吃掉），且 `grep -P` 与含 `$(` 的
   模式经常直接报错。批量文本处理一律写成临时 `.py` 文件再执行，改完 grep 复核。
   **`/tmp` 在 Git Bash 与 Node 里指向不同位置** —— Node 脚本传 `/tmp/x.json` 会
   `ENOENT`，请用 `C:/tmp/...` 或工作区内路径。
10. **Git Bash `curl -d` 发中文 JSON 会写坏数据**（GBK 字节被按 UTF-8 解析成 mojibake 入库）。
    带 non-ASCII 的请求用 python urllib 或 `curl --data-binary @utf8文件`。
11. **迁移索引名全局唯一**（0007 的 idx_run_status 与 0003 撞名炸过）。
12. **迁移记账只看文件名**：改一个已应用的 `000X.sql` 不会重放也不会报错，会静默漂移。
    要改 schema 就新增 `0011_*.sql`。
13. 同一文件不要并行 Edit；Edit 失败 EBUSY 等几秒重试。
14. 本机 git 全局身份未配；上传代码用桌面「Git一键上传」（`gup.bat`），别手拼 git push。

## 6.1 本地向量服务(BGE-M3):重启之后怎么起来

> **2026-09-30 更正(本机现状)**:这一节写的是 `C:\Users\EDY` 那台机器。Administrator 这台机器上
> `multi-agent-orchestrator` 目录、`.venv`/`.venv-ml` 与 `tools/embeddings_http_server.py` 都在,
> 但 `models--BAAI--bge-m3` 权重**不在任何用户的 HF 缓存里**(约 8.7 GB),所以服务起不来。
> 按使用者决定:`.env` 的三个 `EMBEDDING_*` 已清空 → 系统走本地词法基线,
> 语义中心的激活空间已从 `openai-compatible:BAAI/bge-m3:1024` 切到 `lexical-hash:zh-lexical-v1:512`。
> **3,923 条 BGE-M3 向量一条没删**,仍在历史空间里;服务起得来时可在界面上激活回去(D9:历史空间不物理删除)。

本机 `.env` 现在指向一个**跑在本地的** OpenAI 兼容向量服务:

```
EMBEDDING_API_KEY=<任意非空占位,本地服务不校验>
EMBEDDING_BASE_URL=http://127.0.0.1:8899/v1
EMBEDDING_MODEL=BAAI/bge-m3
```

三个键**必须同时非空**才会启用 API 模式(`providerFactory.ts` 判的就是这三个),
本地服务不需要真密钥,但留空会直接判成"未配置"。

这个服务不在本仓库里 —— 它是使用者另一台项目 `C:\Users\EDY\Desktop\multi-agent-orchestrator`
的 `tools\embeddings_http_server.py`(复用该项目已有的模型加载与 provider,权重已缓存在
`C:\Users\EDY\.cache\huggingface\hub\models--BAAI--bge-m3`,约 8.7 GB,不需要再下载)。启动:

```
cd /c/Users/EDY/Desktop/multi-agent-orchestrator
MEMORY_EMBEDDING_INTERPRETER="$PWD/.venv-ml/Scripts/python.exe" \
MEMORY_EMBEDDING_MODEL_PATH=BAAI/bge-m3 \
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \
./.venv/Scripts/python.exe tools/embeddings_http_server.py
```

验证(必须用**中文**验,ASCII 通过不代表能用 —— 见下):

```
curl -s http://127.0.0.1:8899/health      # {"loaded":true,"dimension":1024,"available":true,...}
```

三个必须知道的坑:

1. **`PYTHONUTF8=1` 不是可选**。Windows 下 worker 子进程的 stdin 用 cp936 解码,
   任何中文输入都会 503 / `TextEncodeInput must be Union[...]`。此前只用 ASCII 探通过,
   连续两轮得出"服务端没问题"的错误结论。
2. **它是单线程的**(长驻管道,一次一个请求)。客户端批次与超时已经收在 provider 内部
   (`EMBEDDING_BATCH_SIZE` 默认 8、`EMBEDDING_TIMEOUT_MS` 默认 180s),
   不要再在各个调用点各自 `new OpenAICompatibleEmbeddingProvider(...)` ——
   之前 6 处各建一份、吃内置 30s/32 默认值,导致向量化任务 219/219 全超时,
   而手发同样的请求却成功。
3. **服务没起来时系统仍然完整可用**,只是退回本地词法基线,界面与日志会如实写
   「未配置 Embedding 服务…已使用本地词法基线」。语义模式的差距是实测过的:
   话题平均内聚度 0.805 → 0.892(见 CHANGELOG 1.0.0「语义话题真正可用」)。

## 6.2 桌面形态:原生 exe 怎么出、以及为什么不走 Tauri

**已交付的原生程序**:`desktop\bin\TrendScope.exe`(90 KB;窗口、图标、自起服务、
"关窗口只带走自己起的 node" 都真机验证过)。构建一条命令:

```
desktop\build-win.bat
```

它用 **Windows 自带的 `csc`**(`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`)
编译 `desktop\TrendScope.cs`(WinForms + WebView2)。引用的两个托管 DLL 与
`WebView2Loader.dll` 来自 `Microsoft.Web.WebView2` 这个 NuGet 包(nupkg 就是 zip,
解在 `desktop\vendor\pkg`,已 gitignore);运行时只依赖机器上本来就有的 WebView2 Runtime。
**不需要 Visual Studio、不需要 Windows SDK、不需要管理员权限。**

`start-trendscope.bat` 会优先启动这个 exe;没构建 exe 时退回用本机 Chrome / Edge 的
`--app` 模式开独立窗口(那条路也真机验证过,窗口标题与图标一致)。
开始菜单快捷方式由 `desktop\install-shortcut.ps1` 生成 —— **刻意做成手动跑一次**,
应用与测试都不碰开始菜单/桌面。图标源文件 `desktop/icon-source.png`,
全套尺寸(含 `icon.ico`)由 `npx tauri icon` 生成。

**为什么不用 Tauri**:`src-tauri/` 脚手架是完整的,但 `cargo build` 链接阶段一律
`LNK1181: cannot open input file 'kernel32.lib'` —— 这台机器装了 MSVC 工具集
(`14.44.35207`)**却没装 Windows 10/11 SDK**(`C:\Program Files (x86)\Windows Kits\10` 不存在)。
补 SDK 要几个 GB 且需要管理员权限,而目标只是"一个能双击打开的桌面程序",
用系统自带的 csc 明显划算。真要走 Tauri:先由使用者执行

```
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vs_installer.exe" modify `
  --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" `
  --add Microsoft.VisualStudio.Component.Windows11SDK.22621 --passive --norestart
```

再跑 `desktop\build-desktop.bat` 或 `npm run desktop:build`。

**编码这条在桌面端是功能问题,不是观感问题**:`.bat` 必须 ASCII + CRLF
(UTF-8 中文注释在 cmd 的 cp936 下字节错位,会把命令行本身吃掉);
`.cs` 源码含中文时编译必须带 `-codepage:65001`,否则 `csc` 按本机 ANSI 码页读源码,
**乱码会被写进二进制** —— 窗口标题就是错的。验证手段:`desktop\capture-window.ps1`
用 PrintWindow 抓单个窗口(`PW_RENDERFULLCONTENT=2`,WebView2 这种合成表面才抓得到);
整屏截图在无交互会话里会得到一张白图,别拿它当"没渲染"的证据。

**两个已经踩过的构建坑(别再踩)**:

1. **`link.exe` 会被 Git for Windows 抢走**。rustc 按名字找链接器,而 `PATH` 里有
   `D:\Git\usr\bin\link.exe`(Unix 的 `link`),报错长得像 `link: extra operand ...`,
   看起来反而像 Rust 代码写错了。`desktop/build-desktop.bat` 先 `call vcvars64.bat`
   把真正的 MSVC 链接器放到 `PATH` 前面,就是为了这个。
2. **crates.io 直连很慢**(实测一次索引拉取 20s+ 且不稳)。构建脚本只在本次进程里设
   `HTTPS_PROXY=http://127.0.0.1:7897`,**没有写进任何 cargo 全局配置**。

## 6.3 浏览器采集:登录态、两种模式、两个必踩的坑

代码在 `server/src/connectors/browserPage.ts` + `server/src/collection/browserLogin.ts`,
决策写在 D57 / D58。接手时先记住这四件事:

- **用的是本机已装的 Chrome / Edge**(`playwright-core`,渠道 `chrome` → `msedge`)。
  没有浏览器就报 `NETWORK_ERROR`,**永远不会下载浏览器**。登录态落在
  `data/browser-profile/`(已在 `.gitignore`),不入库、不出本机。
- **`mode:"network"` 才是拿到"内容"的那一半**:热榜页面的条目是页面自己发 XHR 拿回来再渲染的,
  这个模式在 `goto` **之前**挂 `response` 监听,只读页面已经收到的 JSON(不构造请求、不补签名)。
  `pickPath` 写点号路径(如 `aweme_list`),留空则自动挑最长的对象数组;
  字段规范支持 `statistics.digg_count` 这种嵌套路径和 `create_time#unix` 这种转换。
- **`onDemandOnly` 是语义,不是标签**:带这个标记的渠道 `channelSchedule()` 返回 `{type:"manual"}`,
  `/api/hot/channels` 的 `intervalMinutes` 是 `null`。改这个契约时记得 `hot-routes.test.ts`
  里有按分支写的断言 —— 上一轮就是因为加了第 16 个渠道,那条"所有渠道 ≥ 30 分钟"的断言变红。
- **两个坑**:(1) `page.evaluate(闭包)` 会把 esbuild 注入的 `__name` helper 一起序列化进页面,
  运行时报 `ReferenceError: __name is not defined` —— DOM 取值一律在 Node 侧用 `$$` /
  `getAttribute` / `innerText`。(2) 抖音热榜的 `href` 会从相对变成绝对,
  `a[href^="/hot/"]` 当场采出 0 条 —— 用 `*=` 而不是 `^=`,并且**改选择器后先「试采一次」再存任务**。

**小红书的两条路各自的前提**:聚合源 `60s…/v2/rednote` 是第三方,它自己会挂
(2026-09-29 实测 `500 Cannot read properties of undefined (reading 'map')`,而当天 03:39 UTC 还采回过 29 条);
未登录的第一方页面**一条内容请求都不发**(网络层实测:7 条响应全是 config/user-me/system-config),
所以第一方只能等使用者在「打开浏览器,我去登录」的窗口里自己登录,再用「试采一次」把选择器核出来。
在那之前不预置小红书浏览器渠道 —— 猜出来的选择器是一个必定失败的按钮。

## 6.4 审查方法:看隔夜运行数据,别看代码(两个静默停摆都这么来的)

09-29 → 09-30 无人点击地跑了 13 小时(2,005 → 2,962 行),然后只读 SQL 两问:
"每个任务最近一次运行是什么状态" + "24 小时内每个任务失败多少次"。两个绿灯永远照不到的缺陷当场现形:

1. **熔断按连接器记**(D59):一个聚合站连续 500,把 `generic-http` 下 9 个健康渠道各锁出 21 次
   `RATE_LIMITED`。现在按"连接器 + 目标主机"熔断。
2. **孤儿 `running` 行没人收尾**(D60):`fullRefresh.busyReason()` 数 `queued/running` 决定"跳过",
   但只有 `collection_runs` 有启动恢复 —— 4 条重启残留让向量化与话题分析**每次自动补算都跳过**,
   界面只显示"已跳过",看起来完全合理。现在两张表并入同一个启动恢复钩子。

**通用规则**:凡是被读来判"是否忙"的状态,必须同时回答"进程重启后谁来收尾"。
新增任何长任务表时,把它的 `queued/running` 一并加进 `scheduler.recover()`。

**跑门禁前的两条卫生检查**(这次是被自己的负载毁了一整遍链换来的):
`embedding_jobs` 里 `queued/running` 是否为 0、`Get-Process python*` 的 CPU 增量是否还在涨 ——
本地 BGE-M3 推理会吃满约 8 核,那时跑 `npm test` 会得到**假的失败**
(实测:演示 reset 110s 超时、§64 性能用例 64s 不过、外加 2 条 vitest worker RPC 超时)。

## 7. 验收基线（历史快照 —— 当前基线看下面的引用块）

```
npm run typecheck   PASS（client + server strict，0 error）
npm test            PASS  470/470（36 文件；原 426 一例未删未改弱）

> 上面是 Stage 9.5 时的快照，仅作演进留痕。**当前基线(2026-09-30 15:50):`npm test` 718 例 / 63 文件
> 连续两轮全绿(15:33、15:37,两遍之间未改源码);`npm run verify:release` 14 项闸门连续两轮全绿(14 通过 · 0 跳过 · 0 失败);
> `check:responsive` 3 宽度 × 14 条路由(42 次真实渲染)无页面级横向溢出**;逐闸门数字与本轮做了什么见 docs/TEST_STATUS.md 最后一节(第 (九) 轮)。
> 数字会随功能漂移 —— **引用前先读 TEST_STATUS 的最新一节,不要引用本文件这一行。**
> 另两条跑链前必读的实测(都写在本轮 TEST_STATUS 里):
> (a) 10:32 那遍有 1 例性能失败是本地向量推理抢满 CPU;(b) 14:38 那遍 716/2 失败、耗时 764s(基线 152s),
> 是**调度器每几分钟一轮采集 + 每轮 6–11 次注定失败的全量聚类尝试**在同一个 CPU 上打架。
> 结论:**跑链前把 5184/5185 两个后台实例整个进程树停掉**,跑完再启回来 ——
> 静止的判据用 `collection_runs` 最后一行时间 vs 当前时间(本轮实测:07:25:17Z vs 07:32:49Z)。
> 第 (九) 轮第一遍链也是真红的(716/1):代码用了没定义的 CSS class,补规则后重跑全绿 ——
> 不是放宽断言,这是"链不绿先查是不是自己改坏"的样本。
                      连跑两次稳定；vitest 已设 fileParallelism:false（理由见 D27）
npm run build       PASS
npm run eval:opportunity  PASS
      A=71.1 > C=60.1 > F=52.7 > B=47.3 > E=40.2 > D=17.7（与设计一致，非"最该做"排序）
真机 npm start      PASS（full-refresh 200 / trends?minOpportunity 200 / 非法参数 400 /
                         机会指数 32.9·medium 复算一致）
真机 UI 走查        PASS（13 条路由逐页渲染数据，console 零报错；动量表 15 表头 = 15 单元格）
npm run db:backup   PASS（逐项一致 + WAL 折叠，主文件自包含）
```

- 测试构成：原 365 例**一例未删** + 56 例 HTTP 层契约测试 + 5 例引擎锁单测。
- **为什么新增 HTTP 契约测试**：此前没有任何测试经过 HTTP 层，所以"UI 用 POST 打 PUT-only
  路由（404）""筛选参数触发 500""文档里的端点路径根本不存在""主数据表整列错位"这些真实
  故障都能在 365 个绿灯下长期存在。**改路由/改响应字段时请同步维护该文件。**
- 唯一一处断言演进（有注释）：6A golden 的 `sim(A,C) > sim(A,D)` 在 6B 引入模板词停用表后
  改为 `ab/ae > ad` —— C 与 A 无字面重叠，词法模型不可区分，属预期。
- Golden 话题评测：6 主题 Pairwise P/R/F1 100%、Noise 14.3%、Avg Cohesion 63.2%（词法基线）。
- 性能：500 话题机会计算 <1s（实测约 50ms）；6B 5000×512 邻居检索+聚类 <30s；similar topK 54.6ms。
- Live Smoke（知乎 / embedding）均 SKIPPED_NO_CREDENTIAL —— **这不是失败**，是设计行为。

## 8. 当前待办（按优先级）

1. **用户验收未做。** 路径：`npm start` → `#/opportunity` → 点「刷新全部分析」→ 看机会指数 /
   置信 / 档位 → 点话题名（点数字上的虚线，或直接进 `#/topics/1`）展开机会证据（六组件 /
   正向 / 限制 / 变化来源）→ 入选·观察·搁置决策 → 话题详情（趋势区 + 洞察区 + 机会区）→
   趋势中心机会列 → Dashboard 机会统计。
   **注意：当前库是 fixture 数据，所有引擎输出都是诚实空态或低分，真实结论需要真实数据积累。**
   ↑ **这句已经不成立(2026-09-29 更正)**:库内现在是 **2,005 行真实采集内容 / 12 个平台值**(20:07 实测)
   (`data/trendscope.db`,不是演示库 `trendscope-demo.db`);知乎凭证已配好并真机在跑,
   向量走本机 BGE-M3(§6.1)。第 1、2、3 项因此从"待办"变成"已完成,日常在跑"。
   仍然成立的是"用户验收未做"这一句:界面路径需要使用者本人走一遍。
2. 知乎凭证：`developer.zhihu.com/profile` 申请 → 设 `ZHIHU_ACCESS_SECRET` → `npm run smoke:zhihu`
   → 建 Search/Hotlist 任务采真实数据（评分引擎自动受益，代码零改动）。
3. Embedding 凭证：`EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL` → `npm run smoke:embedding`
   → 语义中心切 API 模式 → 重跑话题分析 + 评分对比。
4. **已知未修（下次接手从这里继续，见 AUDIT 文档 §5）**：
   - **筛选竞态未根治**：`api()` 本身支持透传 `signal`，但多数列表页调用点没有 abort / 序号
     守卫，慢网络下旧请求可能覆盖新结果。根治需要 `useResource()` + `<DataTable>` 抽象
     （22 处手写表格、56 处 fetch、13 个徽章组件），本次按"targeted 修复 + 设计打底"范围
     界定**刻意未做**。
   - Trends 行展开的 breakdown 需服务端在 `topic_score_current` 补字段（前端
     `TopicsExplorer` 另有一份写死权重的重复实现，会漂移）。
   - Profile 编辑 UI 未做（Balanced / EarlyDiscovery 代码内置，API 已暴露元数据）。
   - per-topic pattern 状态未落库（D20：无法区分"无模式"与"样本不足"）。
   - `topic_memberships` 无外键（已在应用层校验挡住新孤儿，历史孤儿已确认为 0；要彻底解决
     需重建表加 FK）。
   - 权重/阈值均为设计初始值，校准须 bump 版本 + 记 DECISIONS（禁为 fixture 调参）。
5. **红线**：不要用 `void` 发数据库写入；不要为 pass 改阈值；unscorable 永远显示"数据不足"
   而不是 0 分；UI 禁推荐/因果话术；**改真机库前先 `npm run db:backup`**。

## 9. Stage 10 建议（未开始，勿自动开工）

① 凭证接入后的真实数据校准（EMBEDDING → 语义话题/语义角度；ZHIHU → 真实趋势）；
② per-topic pattern 状态落库（拆分"无模式"与"样本不足"，见 D20）；③ Profile 版本化编辑 UI；
④ 第二个平台 Connector；⑤ Publication Feedback Calibration（Stage 9 明确禁止，是 Stage 10+
的自然方向）。前置：Stage 7–9 用户验收 + 真实数据源。

## 10. 文档索引

| 文档 | 内容 |
| --- | --- |
| **docs/AUDIT-2026-09-25.md** | **接手全量审查记录：每条缺陷的验证方式、WAL 事故、以及我自己造成的正则事故** |
| docs/SCORING_MODEL.md | Stage 7 评分模型全解（权重/置信度/生命周期/校准） |
| docs/CONTENT_INTELLIGENCE.md | Stage 8 情报模型全解（共性/饱和/新颖/版本化） |
| docs/OPPORTUNITY_MODEL.md | Stage 9 机会模型全解（六组件/置信分离/决策/新鲜度） |
| docs/TEST_STATUS.md | 测试与验收走查账本 |
| docs/NEXT_ACTION.md | 断点续传（接手从这里开始） |
| docs/PROJECT_STATE.md | 各 Stage 完成明细 + 最近测试输出 + Known Issues |
| docs/DECISIONS.md | D1–D22 决策记录 |
| docs/COLLECTION_RUNTIME_AUDIT.md | Stage 4 采集地基审计 |
| docs/connectors/ZHIHU_API_RESEARCH.md | 知乎官方 API 核对（Last Verified 2026-09-24） |
| docs/connectors/vendor-zhihu/http-api.md | 知乎官方文档原文（权威；冲突时修代码不改文档） |
| docs/ARCHITECTURE.md | 系统架构总览（Stage 3 撰写，方向有效） |
| `TrendScope交接/` | ~~上一版交接归档(含源码 tarball)~~ **2026-09-30 已删除**(09-27 的项目快照,比当前树旧;不是还原点,见 §6.3) |
