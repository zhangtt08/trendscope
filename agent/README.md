# TrendScope Agent API

TrendScope 已有常驻 Express 服务（默认 `127.0.0.1:5184`），所以**没有第二个 agent 进程、也没有第二个端口**：
契约四端点直接注册进现有服务，工具注册表在 `server/src/agent/`（`tools.ts` 定义能力、`schema.ts` 定义入参、
`errors.ts` 定义错误码）。契约见 `personal-agent-hub/docs/AGENT_API_STANDARD.md`。

```
GET  /api/health          健康、版本、工具数量、是否演示模式
GET  /api/agent/tools     工具清单（name / description / input_schema / risk）
GET  /api/agent/manifest  项目元信息 + 工具清单
POST /api/agent/tool      唯一调用入口，body = {tool, input}
```

## 工具（8 个）

| 工具 | 用途 |
| --- | --- |
| `trendscope.overview` | 总览：条目计数、平台分布、数据健康度 |
| `trendscope.search_contents` | 按平台/关键词/时间窗检索内容条目（分页） |
| `trendscope.content_detail` | 单条内容详情与其证据来源 |
| `trendscope.list_topics` | 选题列表与状态 |
| `trendscope.topic_detail` | 单个选题的评分构成与依据 |
| `trendscope.scoring_profile` | 爆发指数 / 生命周期 / 机会分此刻用的参数档 |
| `trendscope.generate_plan` | 生成选题计划（写动作，需 `confirm: true`） |
| `trendscope.export_panel` | 导出当前面板数据 |

工具直接调用服务层的真实查询，不读写死的示例数据；`demo_mode` 会在 `/api/health` 里如实报出来。

## 启动与挂载

```bash
npm run build:server && node dist-server/index.js   # 生产
npm run dev                                          # tsx watch，同样提供这四个端点
node agent/serve.mjs                                 # 没在跑时按需拉起（按 agent/launch.json）
node agent/mcp-server.mjs                            # 任意 MCP 客户端直接挂这一套工具
```

实际地址写入 `agent/.endpoint`（端口被占时服务会 +1）。

## 入站边界（调用方要知道的三件事）

服务是**本机服务**，所以有一条第一道中间件的闸门（`server/src/local-guard.ts`，在 `server/src/app.ts` 注册）：

1. `Host` 必须逐字是 `127.0.0.1:<端口>`、`localhost:<端口>` 或 `[::1]:<端口>`，且端口要等于服务实际监听的端口。
   用 `http://<局域网 IP>:5184` 或任何域名访问都会被 403 `forbidden_host` 拒掉——服务本身也只绑 `127.0.0.1`。
2. `Origin` / `Referer` 只要带了，就必须落在同一个回环 host:port。判定**从不**拿 `Origin` 跟请求自己的 `Host` 比，
   所以把域名解析到 127.0.0.1（DNS rebinding）那种"看着同源"的请求仍是 403。
3. 可选：`.env` 里设了 `TRENDSCOPE_LOCAL_TOKEN` 时，非 GET 请求必须带一致的 `x-agent-token` 头（常数时间比较）。
   留空 = 不启用。⚠ 设了它，浏览器界面里的写入也会被拒，除非调用方自己带这个头。

拒绝一律是 JSON（`{ok:false, code, message, error:{code,message}}`），不是 HTML 403——`agent/mcp-server.mjs`、
`agent/tools.mjs` 打的就是 `http://127.0.0.1:<端口>`，天然满足第 1 条。

> `server/src/routes/agent.ts` 里的 `baseUrlOf()` 只决定 manifest 里** advertise 出来的地址**，不是防御；
> 边界只由上面那道闸门负责。

## 一个必须知道的坑

`app.get('*')` 会把未知路径返成 SPA 的 HTML。Agent 契约端点必须注册在通配兜底**之前**，
且错误分支也要回 JSON（`{ok:false,error:{code,message,available}}`）而不是 HTML ——
`server/src/routes/agent.ts` 的 `fail()` 集中做这件事。
