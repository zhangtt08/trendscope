/**
 * 长耗时操作的等待反馈。
 *
 * 为什么不是单纯一个转圈:本机实测过 —— 1.3GB 的库上,第一次 GET /api/health 要 **35 秒**
 * (冷文件缓存下几条全库聚合查询逐页读盘;热了以后 0.1 秒),选题工作室一次真实生成
 * 实测 73 秒。那段时间界面上只有一句"正在加载",与"软件卡死了"看起来一模一样,
 * 用户唯一的出路是刷新或重启 —— 而那恰恰会让它更慢。
 *
 * 所以这里给三样东西:① 已经等了多久(按秒走,不编 ETA);② 为什么可能慢;③ 慢的时候
 * 有什么别的事可以做(不是让用户白等)。数字与提示都按实测写,不写"约 3 秒"这种没测过的话。
 */
import { useEffect, useState } from "react";
import { elapsedZh } from "../lib/format";

export function PendingHint({
  show,
  why,
  alt,
  slowAfterMs = 3000,
}: {
  show: boolean;
  /** 这一步在做什么、为什么可能慢(一句话,来自调用处的真实语境) */
  why?: string;
  /** 等待期间的替代动作,例如"可以先看内容浏览器" */
  alt?: string;
  /** 超过这个时长才露面:快请求不该多一块噪声 */
  slowAfterMs?: number;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!show) {
      setElapsed(0);
      return;
    }
    const t0 = Date.now();
    const tick = window.setInterval(() => setElapsed(Date.now() - t0), 500);
    return () => window.clearInterval(tick);
  }, [show]);

  if (!show || elapsed < slowAfterMs) return null;

  return (
    <div className="pending" role="status" aria-live="polite">
      <span className="pending-elapsed">已等待 {elapsedZh(elapsed)}</span>
      <span className="pending-why">
        {why ?? "这一步在本机要跑一会儿。"}
        {elapsed > 20_000 ? " 别刷新页面 —— 请求还在跑,刷新只会从头再来一次。" : ""}
      </span>
      {alt ? <span className="small muted">可以先去做:{alt}</span> : null}
    </div>
  );
}
