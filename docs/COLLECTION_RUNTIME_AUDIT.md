# Collection Runtime 审计（Stage 4 §1）

> 审计范围:`server/src/connectors/`(562 行)、`server/src/domain/collection.ts`、
> schema 中 connectors / collection_tasks / collection_runs / collection_run_events、
> `drizzle/0003_stage3.sql`、importService 溯源接口、未接路由代码。
> 原则:优先修复与复用,不为"代码更漂亮"重写。

## 总体结论

地基质量高于预期,架构方向与 Stage 4 规范一致(Connector/SourceAdapter 分离、
平台细节不下沉调度器、Secret 只存引用、事件 redact)。**已有代码全部保留**,
Stage 4 的工作是:补齐 taxonomy 缺口、暴露溯源管线、实现 collector/scheduler
编排层、接路由、接 UI、补测试。不需要重写任何已有模块。

## 分类明细

### Already Implemented(直接复用)

| 模块 | 内容 | Stage 4 用途 |
| --- | --- | --- |
| `domain/collection.ts` | ConnectorError(11 code)+ retryable 集合;computeBackoff(exponential + full jitter);RateLimitConfigSchema(rps/rpm/minIntervalMs/concurrency);RateLimiter(spacing + 并发上限 + 等待队列 + abort 传播);PageResult / RemotePageRequest(§9 语义完全一致);ConnectorCircuitBreaker(closed/open/half_open、canExecute 单探针、recordSuccess/Failure) | Retry / Rate Limit / Pagination / Circuit Breaker 四大件 |
| `connectors/types.ts` | Connector contract(metadata/validateConfig/healthCheck/collectPage + configSchema/itemSchema/defaultPolicy);SECRET_REF_PATTERN(§23);redactData(§24);RunLogger / ConnectorRunContext | Connector Contract 正式稳定 |
| `connectors/fixtureRemote.ts` | 场景 A–H 全部实现;opaque cursor codec;per-run 一次性故障标记;跨 Run 指标增长 | FixtureRemoteConnector 主体直接复用 |
| `connectors/httpClient.ts` | timeout / AbortSignal / 5MB 上限 / 敏感头 redact / HTTP 状态→错误码映射 | HttpConnectorBase 底座,Stage 5 所有 API Connector 复用 |
| `connectors/registry.ts` | HttpConnectorBase(模板方法)/ BrowserConnectorBase(contract only,§27 明确不做 Playwright)/ register / get / list | Registry 即用 |
| schema + `0003_stage3.sql` | connectors、collection_tasks、collection_runs(含 checkpoint/request_count/retry_count/task_name 冗余)、collection_run_events 四表;raw_records 溯源三列 | 零重复建表,§40 满足 |
| `importService.processRow` | 已预留 `CollectionProvenance` 参数(collectionRunId/connectorId/connectorVersion) | 采集 → 原管线的挂点 |

### Incomplete(有接口、缺实现,补齐即可)

1. **错误 taxonomy 缺 2 码**:`SCHEMA_DRIFT`、`INTERRUPTED`(§22 要求 13 码,现 11 码)。
2. **RUN_EVENT_TYPES 缺 4 类**:RUN_QUEUED、PAGE_REQUESTED、RECORD_IMPORTED(现为
   RECORD_NORMALIZED,更名对齐 §25)、RUN_PARTIAL。
3. **`runImport` 未暴露 provenance**:`processRow` 支持 `CollectionProvenance`,但
   `runImport` 签名不传——采集管线无法把 run 溯源带进每一行。需要给 runImport
   加可选参数(向后兼容)。
4. **成功行的 raw_records 不写溯源**:processRow 两个成功分支(新建/重复)的事务内
   insert rawRecords 均未带 collectionRunId/connectorId/connectorVersion,只有
   失败行的 saveRaw 带 → §6 "RawRecord 走原管线"的血缘断链,必须修。
5. **BrowserConnectorBase.healthCheck 文案过时**("Stage 3 contract only"),随版本更新。
6. **无 scheduler / collector / queue / health 聚合 / restart recovery**:
   编排层整个不存在——这是 Stage 4 的主要增量(不是重构)。

### Broken(缺陷,修复)

1. **RateLimiter.acquire 在 spacing 等待中 abort 时 inFlight 泄漏**:
   并发槽已 +1 后进入 spacing sleep,abort 抛错但槽未释放(依赖调用方 run() 的
   finally 兜底;直接用 acquire/release 的调用方会踩)。修复:abort 分支内先
   `inFlight -= 1` 并唤醒队列。
2. **CircuitBreaker half_open 探针可能永久卡死**:canExecute() 置位
   halfOpenProbeInFlight 后,若调用方从未调用 recordSuccess/recordFailure
   (如任务排队时被取消),breaker 永远拒绝。修复:提供 `resetProbe()` 并在
   collector 的 finally 路径调用。
3. **FixtureRemoteConnector 全局模块态**(runCounters / onceFlags 为模块级
   static):并行测试用相同 taskId 会互相污染。修复:暴露 resetState()(已有)
   并约定测试用唯一 taskId;不改为实例态,避免动 API。

### Unused(未接线,本阶段接入)

- connectors 模块零引用于 routes/api.ts —— 无 /api/collection/* 路由。
- collection_* 四表无任何读写方。
- 前端无 Collection Center。

### Safe To Reuse(不动)

- connectors 全部 5 文件(domain/collection.ts + 4 个 connectors/*)。
- 0003 迁移与四张表结构。
- importService 管线(仅按上述 Incomplete #3/#4 小改)。

### Needs Refactor(小改,非重写)

- `domain/collection.ts`:补 2 个错误码(保持既有 code 列表顺序风格)。
- `connectors/types.ts`:补 4 个事件类型。
- `importService.ts`:runImport 透传 provenance;成功分支 raw 落溯源。
- `fixtureRemote.ts`:放宽 totalItems/pageLimit 上限以支持 §35 的 1000 条性能
  场景;新增 PERCEIVED 场景参数即可,不改结构。

## 遗留风险(记录,不阻塞)

1. breaker 状态不持久化:重启后从 closed 开始。§16 Restart Recovery 以
   run 状态为准,breaker 丢失可接受(冷却期重新计算)。
2. Scheduler 为单进程内存实现(§18 明确不引 Redis/Kafka),持久化依赖
   collection_tasks.next_run_at 列,重启重算(§16)。
3. checkpoint 存 collection_runs.checkpoint(JSON):单机场景够用;
   多任务并发上限用进程内 Map 保护。
