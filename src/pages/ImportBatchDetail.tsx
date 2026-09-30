import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { api } from "../lib/api";
import { fmtDateTime, SOURCE_TYPE_LABELS, batchDisplayName } from "../lib/format";
import { BatchStatusChip, PlatformTag } from "../components/badges";

interface BatchDetail {
  batch: {
    id: number;
    name: string;
    sourceType: string;
    platform: string | null;
    startedAt: string;
    completedAt: string | null;
    totalRecords: number;
    successfulRecords: number;
    failedRecords: number;
    duplicateRecords: number;
    status: string;
    message: string | null;
    options: string | null;
  };
  failedRows: {
    id: number;
    rowIndex: number | null;
    note: string | null;
    payloadPreview: string;
  }[];
  candidatesCreated: number;
}

export default function ImportBatchDetail() {
  const { id } = useParams();
  const [data, setData] = useState<BatchDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<BatchDetail>(`/import/batches/${id}`)
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [id]);

  if (err)
    return (
      <div>
        <Link to="/import" className="backlink">
          <ArrowLeft size={14} /> 返回导入中心
        </Link>
        <div className="banner err" role="alert">{err}</div>
      </div>
    );
  if (!data) return <div className="spinner">正在加载…</div>;

  const { batch, failedRows, candidatesCreated } = data;
  let optionsPretty = "—";
  try {
    optionsPretty = batch.options ? JSON.stringify(JSON.parse(batch.options), null, 1) : "—";
  } catch {
    optionsPretty = batch.options ?? "—";
  }

  return (
    <div className="fade-in">
      <Link to="/import" className="backlink">
        <ArrowLeft size={14} /> 返回导入中心
      </Link>

      <div className="section-head">
        <span className="section-no">#{batch.id} /</span>
        <h1 className="section-title" style={{ fontSize: 17 }}>
          {batchDisplayName(batch.name)}
        </h1>
        <span style={{ marginLeft: "auto" }}>
          <BatchStatusChip status={batch.status} />
        </span>
      </div>

      <div className="card" style={{ display: "flex", gap: 26, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <div className="stat-label">来源</div>
          <div className="mono">{SOURCE_TYPE_LABELS[batch.sourceType] ?? batch.sourceType}</div>
        </div>
        <div>
          <div className="stat-label">平台</div>
          <div>{batch.platform ? <PlatformTag platform={batch.platform} /> : <span className="null-mark">—</span>}</div>
        </div>
        <div>
          <div className="stat-label">开始时间</div>
          <div className="mono small">{fmtDateTime(batch.startedAt)}</div>
        </div>
        <div>
          <div className="stat-label">结束时间</div>
          <div className="mono small">{fmtDateTime(batch.completedAt)}</div>
        </div>
        <div>
          <div className="stat-label">总行数</div>
          <div className="mono">{batch.totalRecords}</div>
        </div>
        <div>
          <div className="stat-label">OK</div>
          <div className="mono" style={{ color: "var(--ok)" }}>
            {batch.successfulRecords}
          </div>
        </div>
        <div>
          <div className="stat-label">重复</div>
          <div className="mono" style={{ color: "var(--warn)" }}>
            {batch.duplicateRecords}
          </div>
        </div>
        <div>
          <div className="stat-label">失败</div>
          <div className="mono" style={{ color: batch.failedRecords > 0 ? "var(--bad)" : undefined }}>
            {batch.failedRecords}
          </div>
        </div>
        <div>
          <div className="stat-label">疑似重复候选</div>
          <div className="mono">{candidatesCreated}</div>
        </div>
      </div>

      <div className="section-head">
        <span className="section-no">选项 /</span>
        <h2 className="section-title" style={{ fontSize: 14 }}>
          导入选项(字段映射 / 时区)
        </h2>
      </div>
      <pre className="rawjson" style={{ maxHeight: 140 }}>{optionsPretty}</pre>

      <div className="section-head">
        <span className="section-no">失败行 /</span>
        <h2 className="section-title" style={{ fontSize: 14 }}>
          失败记录（{failedRows.length}）
        </h2>
        <span className="section-hint">原始数据完整保留,失败原因可逐行查看</span>
      </div>
      {failedRows.length === 0 ? (
        <div className="card muted">本批次没有失败行。</div>
      ) : (
        <div className="table-wrap">
          <table className="ts">
            <thead>
              <tr>
                <th scope="col">行号</th>
                <th scope="col">失败原因</th>
                <th scope="col">原始数据预览</th>
              </tr>
            </thead>
            <tbody>
              {failedRows.map((f) => (
                <tr key={f.id}>
                  <td className="mono">{f.rowIndex ?? "—"}</td>
                  <td style={{ color: "var(--bad)", maxWidth: 340, overflowWrap: "anywhere" }}>{f.note}</td>
                  <td className="mono small" style={{ maxWidth: 520, overflowWrap: "anywhere" }}>
                    {f.payloadPreview}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {batch.message && <div className="banner warn">{batch.message}</div>}
    </div>
  );
}
