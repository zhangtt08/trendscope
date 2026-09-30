/**
 * Minimal multi-series SVG line chart (Stage 3) — no chart library, matches the
 * industrial design system. null values break the line (unknown ≠ 0).
 * Rendered with hairline grid, mono axis labels, native <title> tooltips.
 */
import { fmtAxisNumber } from "../lib/format";

export interface ChartPoint {
  t: number; // ms epoch
  v: number | null;
}

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  points: ChartPoint[];
}

const PAD_L = 56;
const PAD_R = 12;
const PAD_T = 10;
const PAD_B = 22;

// §76:轴标签与全站共用同一套 万/亿 口径,不再出现第三种单位 k。
const fmtAxis = (v: number): string => fmtAxisNumber(v);

export default function LineChart({ series, height = 220 }: { series: ChartSeries[]; height?: number }) {
  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) {
    return <div className="small muted" style={{ padding: "12px 0" }}>暂无快照数据</div>;
  }

  const ts = allPoints.map((p) => p.t);
  const minT = Math.min(...ts);
  const maxT = Math.max(...ts);
  const vs = allPoints.filter((p) => p.v !== null).map((p) => p.v as number);
  const rawMinV = vs.length > 0 ? Math.min(...vs) : 0;
  const rawMaxV = vs.length > 0 ? Math.max(...vs) : 1;
  const padV = (rawMaxV - rawMinV) * 0.08 || Math.max(1, Math.abs(rawMaxV) * 0.1);
  const minV = rawMinV - padV;
  const maxV = rawMaxV + padV;

  const W = 720;
  const H = height;
  const x = (t: number) =>
    maxT === minT ? PAD_L : PAD_L + ((t - minT) / (maxT - minT)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - (v - minV) / (maxV - minV)) * (H - PAD_T - PAD_B);

  // 4 horizontal gridlines
  const gridVals = [0, 1, 2, 3].map((i) => minV + ((maxV - minV) * i) / 3);
  const fmtTick = (t: number) => {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" style={{ width: "100%", height: "auto", display: "block" }}>
        {gridVals.map((gv, i) => (
          <g key={i}>
            <line x1={PAD_L} y1={y(gv)} x2={W - PAD_R} y2={y(gv)} stroke="var(--hairline)" strokeWidth="1" />
            <text x={PAD_L - 6} y={y(gv) + 3} textAnchor="end" fontSize="9" fill="var(--ink-faint)" fontFamily="var(--mono)">
              {fmtAxis(gv)}
            </text>
          </g>
        ))}
        {minT !== maxT && (
          <>
            <text x={PAD_L} y={H - 6} fontSize="9" fill="var(--ink-faint)" fontFamily="var(--mono)">
              {fmtTick(minT)}
            </text>
            <text x={W - PAD_R} y={H - 6} textAnchor="end" fontSize="9" fill="var(--ink-faint)" fontFamily="var(--mono)">
              {fmtTick(maxT)}
            </text>
          </>
        )}
        {series.map((s) => {
          // build polyline segments, breaking on null
          const segments: string[] = [];
          let current: string[] = [];
          for (const p of s.points) {
            if (p.v === null) {
              if (current.length > 0) segments.push(current.join(" "));
              current = [];
              continue;
            }
            current.push(`${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
          }
          if (current.length > 0) segments.push(current.join(" "));
          return (
            <g key={s.key}>
              {segments.map((seg, i) =>
                seg.includes(" ") ? (
                  <polyline key={i} points={seg} fill="none" stroke={s.color} strokeWidth="1.8" strokeLinejoin="round" />
                ) : (
                  <circle
                    key={i}
                    cx={Number(seg.split(",")[0])}
                    cy={Number(seg.split(",")[1])}
                    r="3"
                    fill={s.color}
                  >
                    <title>{`${s.label} ${fmtAxis(s.points.find((p) => p.v !== null)?.v ?? 0)}`}</title>
                  </circle>
                ),
              )}
              {s.points.map((p, i) =>
                p.v !== null ? (
                  <circle key={`pt-${i}`} cx={x(p.t)} cy={y(p.v)} r="2.2" fill={s.color}>
                    <title>{`${s.label} · ${fmtTick(p.t)} · ${p.v.toLocaleString()}`}</title>
                  </circle>
                ) : null,
              )}
            </g>
          );
        })}
      </svg>
      <div className="mono small" style={{ display: "flex", gap: 14, marginTop: 4, flexWrap: "wrap" }}>
        {series.map((s) => (
          <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 14, height: 2, background: s.color, display: "inline-block" }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
