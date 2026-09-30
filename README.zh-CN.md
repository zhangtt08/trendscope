[English](./README.md) | 简体中文

# TrendScope · 本地趋势工作台 v1.0.0

本地优先的跨平台内容趋势与选题决策工具:把抖音 / 小红书 / 知乎 / B站 / 微博 / 手动录入的内容
标准化到一台机器上的 SQLite 库里,算出爆发指数、话题趋势、内容情报与选题机会,再按话题生成
可追溯到证据的 AI 选题方案。数据不出本机,密钥只留在 `.env` 里。

---

## 30 秒跑起来

**不想敲命令:在资源管理器里双击 `start-trendscope.bat`。**
它会按需装依赖、构建、起服务,然后打开**原生窗口「TrendScope 趋势工作台」**(自己的任务栏入口与图标;
没构建过 exe 时才退回用本机 Chrome / Edge 开一个 `--app` 独立窗口)。关掉那个窗口就是停止。
换端口:在同目录放一个 `port.txt`,里面只写端口号(例如 `5199`)。

命令行方式:

```bash
npm install      # 需要 Node 20.19+ / 22.x / 24.x(见 package.json engines)
npm run build    # 编译服务端与前端
npm start        # http://localhost:5184
```

打开浏览器访问 `http://localhost:5184` 即可。首次启动会自动创建数据库
`data/trendscope.db` 并执行全部迁移,不需要手工建表,也不需要 Docker 或外部数据库。

端口被占用时:

```bash
# Windows cmd
set PORT=5199 && npm start
# PowerShell
$env:PORT='5199'; npm start
```

## 当桌面软件用

双击 `start-trendscope.bat`(或开始菜单里的 **TrendScope** 快捷方式)即可:
装依赖 → 构建 → 启动 **`desktop\bin\TrendScope.exe`**(原生窗口,自己的任务栏入口与图标,
不是浏览器里的标签页)。关掉那个窗口,软件自己起的本机服务也一起停。

原生程序用 **Windows 自带的 C# 编译器**构建,不需要 Visual Studio、不需要 Windows SDK、
不要管理员权限:

```
desktop\build-win.bat
```

快捷方式由你自己生成一次(应用和测试都不会往开始菜单/桌面写东西):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\install-shortcut.ps1
# 想同时放一个到桌面:再加 -Desktop
```

图标源文件在 `desktop/icon-source.png`,全套尺寸(含 `icon.ico`)由 `npx tauri icon` 生成,
同一个图也用作网页 favicon,所以标题栏、任务栏和浏览器标签显示的都是它。
`src-tauri/` 里另有一条 Tauri 路线,但编译它需要 Windows SDK(本机没装),
细节与两个必踩的坑写在 `docs/HANDOFF.md` §6.2。

## 小红书:两条路,各有各的前提

**第一条(已预置,零凭证)**:「小红书热点(聚合源)」渠道,公开聚合接口返回热榜标题 + 热度 + 搜索链接,
挂在定时档上自动跑。它是第三方服务 —— 它自己的抓取失效时返回 500(2026-09-29 实测过一次),
那一次运行会在采集中心如实显示失败,不是本机配置问题。

**第二条(第一方内容,需要你本人登录一次)**:小红书未登录的 `explore` 页面**根本不发内容请求** ——
本机实测:浏览器采集读到该页自己收到的 7 条 JSON 响应,全是 `config` / `user/me` / `system/config`,
没有任何笔记或热榜数据。所以第一方内容只能由你自己的登录态换来:
数据总览底部有「打开浏览器,我去登录」,它会打开一个**看得见**的窗口,
你在里面自己登录一次,登录态只落在本机 `data/browser-profile/`(不进数据库、不出本机、界面不显示任何 Cookie)。
登录后到「采集中心」选「浏览器页面采集」连接器,用「试采一次(不入库)」把 URL / 选择器 / 字段核对出来,
确认能取到条目再保存成任务 —— 软件不预置猜出来的小红书选择器,猜的按钮比没有按钮更糟。

软件**不会**伪造平台接口签名、不会做指纹/无头伪装、不会代你点登录或绕过验证码 ——
被挡住时就如实报错告诉你下一步该做什么(见 `docs/DECISIONS.md` D57、D58)。

## 想先看效果:`npm run demo`
```bash
npm run demo          # 独立演示库 data/trendscope-demo.db,端口 5185
npm run demo:reset    # 清空演示库重新装载
```

演示模式使用**另一个数据库文件**,不会读写你的正式库;界面顶部常驻“演示模式”横幅并显示
当前库文件与示例内容条数。演示数据可完整体验采集 → 导入 → 分析 → 选题全链路(内置一个
模拟远程数据源的演示连接器,无需任何平台密钥)。

## 第一次使用

首页会按你当前的数据状态给出下一步:

1. **拿到数据** —— 导入中心(CSV / JSON / 手动录入 / 示例数据)或采集中心(定时任务 + 运行记录)。
   「抓取 N 个渠道的热点」与「按今日热点深挖内容」都会显示实时进度:
   第几条 / 共几条、当前渠道名、已等待多久、这一条已经跑了多久,以及每条渠道的入库与去重数 ——
   渠道是逐个串行采的,慢的时候一条就要一两分钟,进度条的作用就是让你分得清"在跑"和"卡住"。
2. **一键全分析** —— 向量化 → 话题聚类 → 内容评分 → 话题趋势 → 内容情报 → 机会指数,
   界面显示每一步的进度、跳过原因或失败原因;某一步失败不会回滚前面已经算好的结果。
3. **看结论** —— 趋势、内容候选工作台、话题、选题机会;每个分数都能展开看组件分解、
   有效权重、正向信号与限制因素。
4. **做选题** —— 选题工作室按话题打包证据生成 AI 方案,可保存 / 收藏 / 丢弃,方案历史只追加。

## 外部能力全部可选

不配置任何密钥也能完整使用;缺什么,界面会点名缺哪个环境变量。复制 `.env.example` 为 `.env`
后按需填写(重启生效):

| 能力 | 变量 | 不配置时会怎样 |
| --- | --- | --- |
| 知乎官方接口采集 | `ZHIHU_ACCESS_SECRET` | 官方连接器显示“凭证未配置”,演示连接器与导入链路照常可用 |
| 语义向量 | `EMBEDDING_API_KEY` · `EMBEDDING_BASE_URL` · `EMBEDDING_MODEL` | 使用确定性词法基线(可算、可解释,精度较低,界面标注为词法基线) |
| AI 选题方案 | `STUDIO_API_KEY` · `STUDIO_BASE_URL` · `STUDIO_MODEL` | 选题工作室提供“证据摘要(确定性,非 AI)”,生成按钮禁用并说明需要哪个变量 |

密钥的值**永远不返回前端**:设置页与体检只显示“已配置 / 未配置 + 变量名”,接口响应、日志、
运行事件里也不出现密钥。

## 数据、备份与退出

- 数据文件:`data/trendscope.db`(侧栏底部始终显示当前实例真正在用的文件;可用
  `TRENDSCOPE_DB` 指定别处)。运行在 SQLite WAL 模式下,因此 `trendscope.db-wal` /
  `-shm` 是正常工作状态,**不要只复制单个 .db 文件**。
- 备份:

  ```bash
  npm run db:backup                    # 在线备份 + 完整性/表数/行数逐项校验
  npm run db:backup -- --checkpoint    # 备份后把 WAL 折叠回主文件,得到单文件自包含备份
  npm run db:backup -- --verify-only   # 只校验最近一份备份
  ```

- 升级 schema:迁移在启动时自动应用;应用前如果发现有待执行迁移且库内已有数据,会**先自动备份**
  再执行。迁移失败会整体回滚(不会留下半个 schema),报错里会指出是哪一份迁移以及怎么还原。
- 退出:在运行的终端按 `Ctrl+C`(Windows 控制台用 `Ctrl+Break` 更可靠)。程序会先停调度器、
  断开进行中的连接、把 WAL 检查点回主文件,再关闭数据库 —— 日志里能看到“已正常退出”。
  即使进程被强制结束,下次启动 SQLite 会自动回放 WAL,数据不会丢(本项目实测过)。

## 体检与发布闸门

```bash
npm run doctor         # Node 版本 / 原生模块 / 数据目录可写 / 迁移状态 / 三项密钥 / 端口 / 构建产物 / 备份
npm run verify:release # 交付闸门:元数据 + 配置模板 + 静态扫描 + 类型 + 构建 + 全量测试 + 体检 +
                       # 数据库健康 + 两项评估不回退 + 文档齐备(约 8–10 分钟,任一失败退出码 1)
```

## 界面

侧栏按实际使用顺序排列:数据总览 · 导入中心 · 内容浏览器 · 重复治理 · 采集中心 · 语义中心 ·
话题 · 趋势 · 选题机会 · 内容候选工作台 · 选题工作室 · 机会模型 · 设置;内容详情从任意列表点入。
「设置」是四项外部能力(知乎接口 / 语义向量 / AI 选题服务 / 机会模型)的集中视图,
只报"已配置 / 未配置 + 环境变量名",并显示当前实例真正使用的数据文件。

全界面中文(枚举值内部仍用 code,展示走中文),缺失值显示 `—`,计数用千分位、指标用万/亿。
窄屏(411px)不横向溢出,长中文名称按词断行;加载失败给“错误 + 重试”而不是白屏;
某一路由渲染出错只影响该页,切到别的路由自动恢复。

## 它不会做的事(原则)

1. **未知就是未知** —— 缺失指标显示 `—`,绝不显示 0;算不出来的分数显示“数据不足”,绝不给 0 分或满分。
2. **不编造** —— 演示数据、词法基线、确定性摘要都明确标注来源;AI 方案必须引用证据编号,
   无依据的句子会被标出,不伪装成模型结论。
3. **不下因果结论** —— 指数描述的是“内容之间的相对表现”,界面不提供“一定会爆 / 建议做”这类措辞。
4. **历史只追加** —— 指标快照、方案历史、生命周期迁移、合并审计都保留,不覆盖、不物理删除。
5. **Schema 由迁移管理** —— 不删库升级,不手改表结构。
6. **原始数据不丢** —— 原始 payload 存在 `raw_records`,标准化结果与来源链可逐条回溯。
7. **密钥不外泄** —— 只接受 `secretref:env:<NAME>` 引用,禁止明文入库/入日志/进前端。

去重策略:`platform + 内容 ID`(唯一)→ 去跟踪参数后的规范化 URL(唯一)→ 指纹
(平台+作者+标题+发布日),指纹命中**只标记疑似重复,需人工确认**才合并。

## 开发

```bash
npm run dev           # 服务端 :5184(tsx watch)+ 前端 :5183(Vite 代理 /api)
npm run typecheck     # 前端 + 服务端严格模式类型检查
npm test              # Vitest 全量(unit + integration + 前端组件)
npm run build         # 生产构建
npm run db:generate   # 改动 server/src/db/schema.ts 后生成迁移
npm run eval:topics   # 聚类质量评测     npm run eval:scoring
npm run eval:opportunity              # 机会指数排序评测
```

技术栈:React 18 + TypeScript(strict)+ Vite;Express + Node;SQLite(better-sqlite3,WAL)+
Drizzle ORM;Zod 统一入参闸门;Vitest。前端取数一律走 `src/lib/useResource.ts`
(abort + 请求代次守卫,只有搜索框 debounce)。

目录:`server/src/domain`(常量与规则)· `server/src/adapters`(标准化)·
`server/src/services`(导入/采集/分析)· `server/src/db`(schema/连接/迁移)·
`server/fixtures`(示例数据)· `drizzle`(SQL 迁移)· `src`(前端)· `tests` · `docs`。

## 已知限制

- 词法基线是字符级近似:话题关键词里可能出现重叠片段,话题名偏“关键词拼盘”;配置向量服务后
  聚类与相似度质量更高,两簇文本相同的话题也**不会自动合并**,合并始终由人确认。
- Node 大版本切换后 `better-sqlite3` 的原生二进制可能与新 ABI 不匹配(`NODE_MODULE_VERSION` 报错)。
  在 `node_modules/better-sqlite3` 目录执行
  `node node_modules/prebuild-install/bin.js` 即可拉取匹配预编译包,无需 Visual Studio。
  `npm run doctor` 会直接告诉你当前 ABI 是否可用。

## 文档

- `CHANGELOG.md` —— 1.0.0 的新增 / 修复 / 变更
- `docs/RELEASE_NOTES_1.0.md` —— 发布说明与验收结果
- `docs/PROJECT_STATE.md` · `docs/TEST_STATUS.md` · `docs/DECISIONS.md` —— 进度、测试账本、决策记录
- `docs/SCORING_MODEL.md` · `docs/CONTENT_INTELLIGENCE.md` · `docs/OPPORTUNITY_MODEL.md` —— 三个模型的算法与口径
- `docs/ARCHITECTURE.md` —— 分层与数据流
