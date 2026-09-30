import { CircleCheck, TriangleAlert, CircleDashed, CircleX } from "lucide-react";
import { PLATFORM_LABELS } from "../lib/format";

export function QualityBadge({ q }: { q: string }) {
  const icon =
    q === "complete" ? (
      <CircleCheck />
    ) : q === "partial" ? (
      <TriangleAlert />
    ) : q === "minimal" ? (
      <CircleDashed />
    ) : (
      <CircleX />
    );
  return (
    <span className={`chip q-${q}`} title={`数据质量: ${ {complete:"完整",partial:"部分",minimal:"极简",invalid:"无效"}[q] ?? q }`}>
      {icon}
      { {complete:"完整",partial:"部分",minimal:"极简",invalid:"无效"}[q] ?? q }
    </span>
  );
}

export function BatchStatusChip({ status }: { status: string }) {
  const icon =
    status === "completed" ? (
      <CircleCheck />
    ) : status === "partial" ? (
      <TriangleAlert />
    ) : status === "failed" ? (
      <CircleX />
    ) : (
      <CircleDashed />
    );
  return (
    <span className={`chip b-${status}`}>
      {icon}
      { {completed:"已完成",partial:"部分成功",failed:"失败",pending:"排队中",processing:"处理中"}[status] ?? status }
    </span>
  );
}

export function PlatformTag({ platform }: { platform: string | null }) {
  if (!platform) return <span className="null-mark">—</span>;
  // §78:颜色类用 code,文字一律中文;翻译放在这一处,避免每个页面各拼一次。
  return <span className={`plat-tag ${platform}`}>{PLATFORM_LABELS[platform] ?? platform}</span>;
}

export function Null({ children }: { children: React.ReactNode }) {
  if (children === null || children === undefined || children === "") {
    return <span className="null-mark">—</span>;
  }
  return <>{children}</>;
}
