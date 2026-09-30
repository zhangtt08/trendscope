# NEXT_ACTION

> 长任务断点续传文件。任何 agent 接手:读本文件 → 跑 Commands → 从 Current Task 继续。
> 全局上下文见 docs/HANDOFF.md;实测账本见 docs/TEST_STATUS.md(最新一节是 2026-09-30 第 (十) 轮);
> 发布说明见 docs/RELEASE_NOTES_1.0.md,更新记录见 CHANGELOG.md。

## Last Completed

- 2026-09-30(晚):**搬到新机器 `C:\Users\Administrator\Desktop\trendscope` 后全量复验 + 精简交付。**
  本机重新实测:`typecheck` 0 错误 · `npm test` **720 通过 / 63 文件** · `build` PASS ·
  `verify:release` **14 项全通过 · 0 跳过 · 0 失败** · eval 四项与冻结值逐字一致 ·
  `check:responsive` 3 宽度 × 14 路由 = 42 次真实渲染无溢出。
  - 修掉一个真实缺陷:`check:responsive` 的浏览器候选路径只写 Chrome,本机只有 Edge →
    这项检查在上一台机器之后第一次跑就直接退出。**它不在 14 项闸门里,所以闸门全绿时没人发觉。**
    现按 `browserPage.ts` 的既有口径补 `chrome → msedge` 回退。
  - 这台机器缺 `.env` 里那个 `127.0.0.1:8899` 的 BGE-M3 向量服务(属于上一台机器的另一个项目,
    权重不在本机任何 HF 缓存里)。按使用者决定:清空 `EMBEDDING_*` 退回词法基线,
    并把激活空间切到 `lexical-hash:zh-lexical-v1:512`;**3,923 条 BGE-M3 向量一条没删**,
    留在历史空间,起得来服务时可在界面激活回去。
  - 真机功能:调度器自己采到新内容(3,921 → 4,045)、自动补齐词法向量到 4,044 条、
    **一键全分析 run 453 六步全部 completed**(269 活跃话题 / 8,800 已评分 / 291 话题趋势 / 121 机会)、
    15 个路由走查 0 控制台报错、交付副本的 `TrendScope.exe` PrintWindow 抓到真实窗口。
  - 数据库:先 `npm run db:backup` 得到逐项一致的 1,041,104,896 bytes 备份
    (`data/backup/trendscope-20260930-131524.db`,这台机器此前一个备份都没有),
    再按使用者指示删掉 `content_score_snapshots`(546,001 行 / 787 MB)+ `VACUUM` →
    **1,017 MB → 185 MB**,其余表行数逐项未变、integrity ok。
  - 交付包:`C:\Users\Administrator\Desktop\TrendScope-1.0.0`,**304 MB**
    (源目录含 1 GB 备份时约 1.45 GB)。`npm prune --omit=dev` 后 106 MB / 131 包,
    原生模块实测可用;新增 `PREBUILT.txt` + `start-trendscope.bat` 判定,让交付包跳过
    已裁掉工具链的构建步骤,双击路线已实测可用。
- 2026-09-27:**FINAL RELEASE 1.0 交付完成**(WP1–WP5,账本见 TEST_STATUS 对应各节)。

## Current Task

**没有待写代码。** Release 1.0 的五个交付包完成,且已在本机(第三台机器)全量复验通过。
等使用者本人做两件事:

1. **验收**:双击 `C:\Users\Administrator\Desktop\TrendScope-1.0.0\start-trendscope.bat` →
   按 docs/RELEASE_NOTES_1.0.md 的"真实九条路径"走一遍。亲自看三处:
   ① 首页"一键全分析"的分步进度与失败说明;② 语义中心当前激活空间显示
   `lexical-hash … 本地词法基线`(本机没有向量服务,这是如实状态不是坏掉);
   ③ 侧栏左下角的数据文件名就是该副本自己的 `data/trendscope.db`。
2. **定夺两件已量出但未做的事**(见 TEST_STATUS 第 (八) 与 (十) 轮):
   - 快照保留期。`content_score_snapshots` 这次是**整表删掉**的,没有加保留策略 →
     它会从 0 重新长,约 100 MB / 天。要根治得加"只留最近 N 天 + 当前值另表"的策略(动 schema 与调度语义,未做)。
   - 交付副本与源目录是**两份独立的库**,同时用会分叉。日常只用交付副本;源目录留作源码树。

不要自行开工新特性。旧 HANDOFF §9 的候选清单仍按"勿自动开工"约束保留。

## Commands To Run

```bash
cd C:\Users\Administrator\Desktop\trendscope
# 用系统 node(本机 v24.18.0 / ABI 137)。不要切 managed node 22 —— 会以 ABI 错误崩溃。
npm run doctor                                     # 本机实测 11 项全通过
npm run typecheck && npm test && npm run build     # 0 错误、720/63、dist+dist-server
npm run verify:release                             # 14 项闸门,退出码 0(约 8–10 分钟)
npm run eval:topics && npm run eval:scoring && npm run eval:opportunity && npm run eval:studio
npm run db:backup -- --checkpoint                  # 动真机库前先备份
npm start                                          # → http://localhost:5184
# check:responsive 需要应用已在跑;本机用 Edge(脚本已支持 Chrome/Edge 两条路线)
```

## Expected Result

- typecheck 0 error;**720/720 全绿(63 文件)**;build 成功。
- `verify:release` 14 项全 PASS(扫描项若新报命中,先判断是注释误报还是真实文案,不许放宽阈值)。
- eval 冻结值:`topics` F1 100% / 纯度 100% / 噪声 14.3% / 一致性 63.2%;
  `opportunity` 排序 A=71.1 > C=60.1 > F=52.7 > B=47.3 > E=40.2 > D=17.7。
- `check:responsive`:3 宽度 × 14 条路由(42 次真实渲染)无页面级横向溢出;
  停在的路由不是请求的路由即判失败(防"9 条里有 1 条是重定向"那类空测)。
- 浏览器逐页:控制台 0、溢出 0、表头列数=单元格列数、无死按钮、中文逐字断行 0、内部编号残留 0。

## Known Risks

- **本仓库无版本控制。** 改坏不能回滚;改真机库前先 `npm run db:backup`。
  本机现有唯一一份备份:`data/backup/trendscope-20260930-131524.db`(1.0 GB,删快照前的状态)。
- **不要对源码跑宽泛正则批量替换。** 历史上一条"删空括号"规则毁掉 16 个 `.tsx`。
- **`tsc` 干净 ≠ 前端正确。** 改 UI 后 jsdom 组件测试 + 真实浏览器走查两样都要跑。
- 本机较慢:perf 断言已留余量;**禁止调大 timeout 变绿**。跑链前把 5184/5185 后台实例整个进程树停掉,
  静止判据用 `collection_runs` 最后一行时间 vs 当前时间。
- Git Bash `curl -d` 发中文 = mojibake 入库;Node 不认 `/tmp`(用 `C:/tmp/...`);
  robocopy 的 `/E` 会被 MSYS 当路径转换,需要 `MSYS_NO_PATHCONV=1`。
- **Windows 路径不区分大小写**:`Desktop\TrendScope` 与 `Desktop\trendscope` 是同一个目录,
  做交付副本时目标名必须真正不同(本轮用 `TrendScope-1.0.0`)。
- 真机库治理态(watch / 手动命名 / 合并记录)勿随手改;库里的内容全部来自真实采集与示例导入,
  首页用"演示 / 回放数据占比"横幅明示 —— 不要为了"好看"删掉它们。
- Windows 上 `taskkill` 杀 npm 包装进程不会杀掉 node 子进程,会留下孤儿实例占着端口与库;
  停服务要按端口找 PID。控制台退出请用 `Ctrl+Break`。

## Do Not Break

- 720 测试断言(Stage 9.5 的 470 一例未删未改弱)—— 尤其 `tests/integration/http-contract.test.ts`
  (防"按钮 404 / 筛选 500")、`tests/unit/useResource.test.tsx`(防筛选竞态)、
  `tests/integration/opportunity-profile.test.ts`(锁死版本不可原地改)、
  `tests/unit/dialogs.test.tsx` + `tests/unit/demo-status.test.ts` + `tests/unit/display-conventions.test.ts`
  (界面写的 class 必须在样式表里有定义)
- Raw Momentum 语义(D2/D3/D8);`null ≠ 0` 红线;unscorable ≠ 0 分
  (`Trends.tsx:278`、`TopicsExplorer.tsx:517` 先判 `detail.scorable` 再渲染分数)
- Topic.status ≠ Lifecycle;append-only 快照表(评分 3 + 情报 3 + 机会 1 + 运行/方案历史)
- profiles 权重调整必须 bump 版本 + 记 DECISIONS(D12 / D16–D22)
- UI 禁因果与推荐话术:导致 / 因此会爆 / 提升爆款率 / 系统推荐 / 最佳选题 / 必做 / 稳赢
- **表头列数必须等于单元格数**;**界面文案不得出现裸枚举 code**(D37)
- **不要在 `onConflictDoUpdate` 里漏列**;**被读来判"是否忙"的状态必须有启动收尾**(D60 / D61)
- 取数只走 `useResource`;新页面不要再手写 `useCallback(load)+useEffect`
- 机会模型历史版本 immutable;"顺手改旧权重"必须变成"另存新版本"
- Secret 只以 `secretref:env:<NAME>` 引用,值永不进接口 / 日志 / 数据库(D28 / §61)
- 版本号的唯一来源是 `package.json`;新增显示位一律取 `__APP_VERSION__` 或 `appVersion()`(D39)
- 历史向量空间不许物理删除(D9):本机词法基线是**降级**,不是把 BGE-M3 那 3,923 条清掉
