# ZHIHU_API_RESEARCH — 知乎开放平台官方 API 核对

> **Last Verified Date: 2026-09-24**
> 来源(均为知乎官方第一手资料,非第三方转述):
> 1. 官方文档中心 `https://developer.zhihu.com/docs`(WebFetch 确认可达)
> 2. 官方 CDN 发布的 zhihu-cli skill 包 `https://developer-cdn.zhihu.com/zhihu-cli/releases/stable/skill/zhihu-cli-skill.zip`
>    内 `references/http-api.md`(核验时间 2026-07-16)与 `references/open-platform.md`(核验时间 2026-08-25)
> 本文件是 Connector 实现的唯一字段依据。代码与本文冲突时,修代码,不改本文(§55)。

## Official Documentation

| 入口 | URL |
| --- | --- |
| 开放平台 | https://developer.zhihu.com/ |
| 文档中心 | https://developer.zhihu.com/docs |
| Access Secret 申请 | https://developer.zhihu.com/profile |
| HTTP API 参考 | 官方 skill 包 `references/http-api.md`(828 行,含请求/响应示例与错误码) |
| 联系 | openplatform@zhihu.com(周一至周五 09:00-18:00 北京时间) |

## Authentication(官方 http-api.md「Bearer 鉴权说明」)

| Header | 值 | 说明 |
| --- | --- | --- |
| `Authorization` | `Bearer <your_access_secret>` | Bearer + 一个空格 + Access Secret |
| `X-Request-Timestamp` | `1742822400` | **秒级** Unix 时间戳 |
| `Content-Type` | `application/json` | JSON 接口固定值 |

- 服务端同时校验 `Authorization` 与 `X-Request-Timestamp`。
- Access Secret 在个人中心申请;等同于完整 API 访问权限;泄露后删除重申(不可恢复)。
- 官方明确要求:不要在回答、日志或文件中重复完整 Access Secret。

## Endpoints(本阶段使用)

### 知乎搜索 API(zhihu_search)

- `GET https://developer.zhihu.com/api/v1/content/zhihu_search`
- Query:`Query`(String,必填,不能为空)、`Count`(Int32,可选,默认 10,**最大 10**,>10 服务端截断;≤0 回退 10)
- **分页机制:`Data.HasMore` 当前实现固定返回 `false` —— 即该接口当前为单页返回,无翻页参数。**
  Connector 的 PageResult 如实透传 `HasMore=false`;checkpoint 语义保留(与未来官方开放翻页兼容)。
- 响应外层:`{ Code: Int, Message: String, Data: { HasMore: Bool, SearchHashId: String, Items: Item[], EmptyReason?: String } }`

Item 字段(**官方标注"必返"**):

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| Title | String | 内容标题 |
| ContentType | String | 内容类型(示例值:`"Answer"`、`"Article"`;接口说明提及问题/回答/文章) |
| ContentID | String | 内容标识(稳定 Token,示例 `"1903044959663284716"`) |
| ContentText | String | 内容摘要(搜索高亮用 `<em>` 标签) |
| Url | String | 内容链接(**带溯源 UTM 参数**) |
| CommentCount | Int32 | 评论数 |
| VoteUpCount | Int32 | **赞同数** |
| AuthorName | String | 作者昵称(匿名显示"知乎用户") |
| AuthorAvatar | String | 作者头像 |
| AuthorBadge / AuthorBadgeText | String | 认证图标/文案 |
| EditTime | Int32/Int64 | **发布时间或更新时间戳(Unix 秒)** |
| AuthorityLevel | String | 权威等级("1"~"4") |
| RankingScore | Float32 | 排序分数 |
| CommentInfoList | Array(可选) | 精选评论 `{Content: String}[]` |

**未提供**:views / shares / favorites / collections → 一律 null(§22/§23)。
**未提供 author id** → authorId = null,仅 authorName(§21)。

### 知乎热榜 API(hot_list)

- `GET https://developer.zhihu.com/api/v1/content/hot_list`
- Query:`Limit`(Int32,可选,默认 30,最大 30;≤0 或 >30 回退 30)
- 响应外层:`{ Code, Message, Data: { Total: Int64, Items: Item[] } }`

Item 字段(**官方标注"必返"**):

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| Title | String | 热榜标题 |
| Url | String | 知乎链接(如 `https://www.zhihu.com/question/123456789`、`https://zhuanlan.zhihu.com/p/987654321`) |
| ThumbnailUrl | String | 缩略图,无封面时为 `""` |
| Summary | String | 摘要,无摘要时为 `""` |

- 官方说明:"当前仅返回问题和文章两类热榜内容"。
- **无显式 metrics、无 author、无时间字段、无显式 rank 字段。**
- **Rank 语义**:官方按榜单顺序返回 Items —— rank = 数组下标 + 1(确定性,可复核;记录于 DiscoveryObservation,不写 ContentItem)。
- **ID 提取**:Url 属于知乎稳定公开格式 —— `zhihu.com/question/{id}` → contentType=question;`zhuanlan.zhihu.com/p/{id}` → contentType=article。符合任务 §19"URL 规则属于稳定公开格式,可在 Adapter 明确构造/提取"。无法解析的 URL → ContentID=null(URL 仍保留)。
- metrics 全部 null;publishedAt null(官方无时间字段);author null。

## Pagination(汇总)

| 接口 | 分页 |
| --- | --- |
| zhihu_search | 无翻页参数;HasMore 恒 false(官方注明"当前实现固定返回 false") |
| hot_list | 无翻页参数(单次返回 ≤30 条) |
| (参考)question_answers | Offset/Limit + `Paging.IsEnd/NextOffset` —— 本阶段不接入该接口 |
| (参考)knowledge items | Cursor/NextCursor —— 不接入 |

## Rate Limits / Quota(官方 open-platform.md「当前邀测免费额度」,2026-08-25 核验)

| 能力 | 每日额度 |
| --- | ---: |
| 全网搜索 global_search | 5,000 次/日 |
| **知乎搜索 zhihu_search** | **5,000 次/日** |
| **知乎热榜 hot_list** | **100 次/日** |
| 知乎直答 | 100 次/日 |

- 同一账号所有 Access Secret 共享同一额度池;额度耗尽返回 `30001`。
- "频率、并发限制和日额度耗尽均返回 30001;遇到限制时按需查询对应能力组的剩余额度,避免持续重试"(官方原文)。
- **未公布每秒/每分钟频率上限** → Connector 采用保守默认(1 req/s 级,见 Connector defaultPolicy),不虚构官方数值(§32)。
- 额度查询 API:`GET https://developer.zhihu.com/api/v1/quota?APIIDs=zhihu_search,hot_list` → `Data[] { APIID, APIName, TotalQuota, TotalUsed, RemainingQuota }`(该查询本身不消耗业务额度)→ 用于 Test Connection 展示(P1)。

## Response Fields(归一化映射依据,详见 ZhihuSourceAdapter)

| 官方字段 | TrendScope 落点 |
| --- | --- |
| ContentID | platformContentId(稳定、可重复采集) |
| ContentType(`Answer`/`Article`/…,官方示例英文) | contentType:answer/article/question/video/text_post/unknown |
| Url | url(保留官方 UTM 溯源参数;canonicalizeUrl 只按现有白名单剥离,不破坏溯源参数——utm_* 在剥离白名单内,溯源参数 utm_source 的值是否保留由现有 canonicalize 规则决定,RawRecord 永远保留原文) |
| Title | title |
| ContentText | text(摘要就是官方给的全部内容,**不补全文**) |
| AuthorName | authorName(authorId 无来源 → null) |
| VoteUpCount | **upvotes**(§23:语义对应,不硬塞 likes) |
| CommentCount | comments |
| EditTime(Unix 秒) | publishedAt(UTC ISO;provenance 标 explicit epoch) |
| 官方未提供 | views/shares/favorites/authorId → **null,绝不 0** |

热榜补充:Title→title;Summary→text(空串→null);Url→url;ThumbnailUrl 不入主表(留 RawRecord)。

## Error Codes(官方,两个 Endpoint 均列出)

| Code | 说明 | TrendScope 映射 |
| --- | --- | --- |
| 0 | 成功 | — |
| 10001 | 参数错误 | INVALID_RESPONSE(不可重试) |
| 20001 | 鉴权失败 | AUTH_ERROR(不可重试) |
| 30001 | 频率限制(含并发与日额度耗尽) | RATE_LIMITED(可重试一次,退避) |
| 90001 | 内部错误/请求失败 | REMOTE_5XX(可重试) |
| HTTP 层 401/403 | — | AUTH_ERROR / PERMISSION_DENIED |
| HTTP 层 5xx / 网络层失败 | — | REMOTE_5XX / NETWORK_ERROR |

错误响应保留 `providerErrorCode`(知乎 Code)+ safe message;Secret 永不出现在错误信息。

## Known Limitations

1. **zhihu_search 当前单页**(HasMore 恒 false):无法翻页深挖,单次最多 10 条 —— 官方"当前实现"语义,Connector 如实透传。
2. **hot_list 无 metrics/author/时间**:热榜数据价值在"发现 + rank 时序",指标为 null 是官方事实,不是缺陷。
3. 热榜日额度仅 100 次:采集间隔不宜低于 15 分钟(96 次/日),Connector 默认策略按此保守设定。
4. EditTime 是"发布时间或更新时间戳"(官方措辞),不保证是首发时间 —— provenance 如实标注。
5. ContentType 官方文档未给完整枚举(示例仅 Answer/Article)→ Adapter 用白名单映射 + unknown 兜底,**不猜测**。
6. 邀测阶段,额度与规则可能调整;以 `/api/v1/quota` 实时查询为准。
7. Search 高亮 `<em>` 标签:入库前剥离(emphasis 标签不是内容)。

## 本阶段接入范围

- **接入**:zhihu_search(search capability)、hot_list(hotlist capability)、/api/v1/quota(health/test connection,不耗业务额度)
- **不接入**:global_search、直答、question_recommendations、question_answers、knowledge、tools、OAuth、用户数据 API(§56)
