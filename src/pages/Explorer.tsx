import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, ArrowUpDown, Search } from "lucide-react";
import { buildQuery, useDebounced, useResource } from "../lib/useResource";
import {
  fmtMetric,
  fmtDateTime,
  PLATFORM_LABELS,
  CONTENT_TYPE_LABELS,
  QUALITY_LABELS,
  EM_DASH,
} from "../lib/format";
import { LoadError, RefreshHint } from "../components/RequestState";
import { QualityBadge, PlatformTag } from "../components/badges";

interface Row {
  id: number;
  platform: string;
  platformContentId: string | null;
  contentType: string;
  title: string | null;
  authorName: string | null;
  publishedAt: string | null;
  collectedAt: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  dataQuality: string;
  hlTitle?: string | null;
  hlBody?: string | null;
}

interface ContentPage {
  rows: Row[];
  total: number;
  mode: "fts" | "like" | "plain";
}

const PLATFORM_OPTS = Object.entries(PLATFORM_LABELS);
const TYPE_OPTS = Object.entries(CONTENT_TYPE_LABELS);
const QUALITY_OPTS = Object.entries(QUALITY_LABELS);

/** Render [highlight] markers as React nodes — plain text split, never innerHTML. */
function Highlighted({ text }: { text: string | null | undefined }) {
  if (!text) return <span className="null-mark">{EM_DASH}</span>;
  const parts = text.split(/(\[[^\]]*\])/g).filter((p) => p !== "");
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("[") && p.endsWith("]") ? (
          <mark key={i} className="hl">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** 表头与检索横幅共用同一份中文标签,避免两处说法不一致 */
const SORT_LABELS = {
  title: "标题",
  authorName: "作者",
  publishedAt: "发布时间",
  views: "播放",
  likes: "点赞",
  comments: "评论",
  collectedAt: "采集时间",
  dataQuality: "质量",
} as const;

export default function Explorer() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({
    platform: "",
    contentType: "",
    quality: "",
    keyword: "",
    publishedFrom: "",
    publishedTo: "",
    collectedFrom: "",
    collectedTo: "",
  });
  const [sort, setSort] = useState<{ by: string; order: "asc" | "desc" }>({
    by: "collectedAt",
    order: "desc",
  });
  const [page, setPage] = useState(1);
  const pageSize = 20;
  // 检索时按相关度排序(服务端 bm25 已实现,此前 UI 从不发送 sortBy=relevance,
  // 而横幅却写着"默认按相关度排序" —— 现在让两者一致,并可显式关闭)
  const [relevanceFirst, setRelevanceFirst] = useState(true);

  const setFilter = (k: keyof typeof filters) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };

  // 关键词防抖:每敲一个字发一次请求没有意义。select/日期不加防抖。
  const debouncedKeyword = useDebounced(filters.keyword, 250);
  // 排序决策与请求参数都取防抖后的值,否则输入过程中"按相关度"的横幅与实际请求会错位
  const searching = debouncedKeyword.trim().length > 0;
  const relevanceOn = searching && relevanceFirst;

  const path = useMemo(
    () =>
      `/content${buildQuery({
        platform: filters.platform,
        contentType: filters.contentType,
        quality: filters.quality,
        publishedFrom: filters.publishedFrom,
        publishedTo: filters.publishedTo,
        collectedFrom: filters.collectedFrom,
        collectedTo: filters.collectedTo,
        keyword: debouncedKeyword || undefined,
        sortBy: relevanceOn ? "relevance" : sort.by,
        order: relevanceOn ? undefined : sort.order,
        page: String(page),
        pageSize: String(pageSize),
      })}`,
    [filters, debouncedKeyword, relevanceOn, sort, page, pageSize],
  );

  const res = useResource<ContentPage>(path);
  const rows = res.data?.rows ?? null;
  const total = res.data?.total ?? 0;
  const mode = res.data?.mode ?? "plain";

  const toggleSort = (by: string) => {
    setSort((s) => (s.by === by ? { by, order: s.order === "asc" ? "desc" : "asc" } : { by, order: "desc" }));
    setPage(1);
  };

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="fade-in">
      <div className="section-head">
        <h1 className="section-title">内容浏览器</h1>
        <span className="section-hint">
          {total.toLocaleString()} 条 · 未知显示为 {EM_DASH}(空白不是 0) · 互动量为紧凑格式(万/亿),点行进详情看精确值 <RefreshHint show={res.refreshing} />
        </span>
      </div>

      <div className="filter-bar">
        <div className="field" style={{ minWidth: 240 }}>
          <label>全文检索(标题、正文、作者、话题;多个关键词用空格分隔)</label>
          <input aria-label="全文检索(标题、正文、作者、话题;多个关键词用空格分隔)"
            value={filters.keyword}
            onChange={setFilter("keyword")}
            placeholder="例：牛肉面 探店"
          />
        </div>
        <div className="field">
          <label>平台</label>
          <select aria-label="平台" value={filters.platform} onChange={setFilter("platform")}>
            <option value="">全部</option>
            {PLATFORM_OPTS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>类型</label>
          <select aria-label="类型" value={filters.contentType} onChange={setFilter("contentType")}>
            <option value="">全部</option>
            {TYPE_OPTS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>质量</label>
          <select aria-label="质量" value={filters.quality} onChange={setFilter("quality")}>
            <option value="">全部</option>
            {QUALITY_OPTS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>发布时间 从</label>
          <input aria-label="发布时间 从" type="date" value={filters.publishedFrom} onChange={setFilter("publishedFrom")} />
        </div>
        <div className="field">
          <label>至</label>
          <input aria-label="发布时间 至" type="date" value={filters.publishedTo} onChange={setFilter("publishedTo")} />
        </div>
        <div className="field">
          <label>采集时间 从</label>
          <input aria-label="采集时间 从" type="date" value={filters.collectedFrom} onChange={setFilter("collectedFrom")} />
        </div>
        <div className="field">
          <label>至</label>
          <input aria-label="采集时间 至" type="date" value={filters.collectedTo} onChange={setFilter("collectedTo")} />
        </div>
      </div>

      {searching && (
        <div className="banner info" style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Search size={14} />
          {mode === "fts" && (
            <span>
              全文索引检索 ·{" "}
              {relevanceOn
                ? "按相关度排序"
                : `按${SORT_LABELS[sort.by as keyof typeof SORT_LABELS] ?? sort.by}排序`}
            </span>
          )}
          {mode === "like" && <span>全文索引查询无效，已回退为模糊匹配（结果仍可用）</span>}
          {filters.keyword && (
            <label className="small" style={{ marginLeft: "auto", display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={relevanceFirst}
                onChange={(e) => {
                  setRelevanceFirst(e.target.checked);
                  setPage(1);
                }}
              />
              优先相关度
            </label>
          )}
        </div>
      )}

      {res.error && <LoadError message={res.error} onRetry={res.reload} />}

      <div className="table-wrap">
        <table className="ts">
          <thead>
            <tr>
              <th scope="col">平台</th>
              {(Object.entries(SORT_LABELS) as [string, string][]).map(([key, label]) => (
                <th
                  key={key}
                  className={`sortable${["views", "likes", "comments"].includes(key) ? " num" : ""}`}
                  aria-sort={sort.by === key ? (sort.order === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => toggleSort(key)}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {label}
                    {sort.by === key && <ArrowUpDown size={11} />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {res.initialLoading ? (
              <tr>
                <td colSpan={9} className="spinner">
                  正在加载…
                </td>
              </tr>
            ) : rows && rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="muted">
                  {res.error
                    ? "本次未取到数据 — 可点上方「重试」"
                    : "没有符合条件的内容 —— 放宽筛选条件,或到导入中心先导入数据"}
                </td>
              </tr>
            ) : null}
            {rows?.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/content/${r.id}`)}>
                  <td>
                    <PlatformTag platform={r.platform} />
                  </td>
                  <td style={{ maxWidth: 380 }}>
                    <span
                      style={{
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {searching && r.hlTitle ? (
                        <Highlighted text={r.hlTitle} />
                      ) : r.title ? (
                        r.title
                      ) : (
                        <span className="null-mark">{EM_DASH}</span>
                      )}
                    </span>
                    <span className="mono small muted">
                      {r.contentType === "unknown" ? "" : CONTENT_TYPE_LABELS[r.contentType] ?? r.contentType}
                      {r.platformContentId ? ` · ${r.platformContentId}` : ""}
                    </span>
                    {searching && r.hlBody && (
                      <span
                        className="small muted"
                        style={{
                          display: "block",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <Highlighted text={r.hlBody} />
                      </span>
                    )}
                  </td>
                  <td>{r.authorName ?? <span className="null-mark">{EM_DASH}</span>}</td>
                  <td className="mono small">{fmtDateTime(r.publishedAt)}</td>
                  <td className="num">{fmtMetric(r.views)}</td>
                  <td className="num">{fmtMetric(r.likes)}</td>
                  <td className="num">{fmtMetric(r.comments)}</td>
                  <td className="mono small">{fmtDateTime(r.collectedAt)}</td>
                  <td>
                    <QualityBadge q={r.dataQuality} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <span className="mono small">
          page {page} / {pages} · {total.toLocaleString()} 条
        </span>
        <button title={page <= 1 ? "已是第一页" : undefined} className="btn secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          <ChevronLeft /> 上一页
        </button>
        <button title={page >= pages ? "已是最后一页" : undefined} className="btn secondary" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
          下一页 <ChevronRight />
        </button>
      </div>

      <div className="small muted" style={{ marginTop: 18 }}>
        提示:点击任意行进入内容详情,核对标准化结果、快照历史与原始记录。{" "}
        <Link to="/import" style={{ color: "var(--steel)" }}>
          前往导入中心 →
        </Link>
      </div>
    </div>
  );
}
