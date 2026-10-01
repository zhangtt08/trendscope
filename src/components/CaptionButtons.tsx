import { useEffect, useState } from "react";

// 仅在 TrendScope 桌面壳（WebView2 + IsNonClientRegionSupportEnabled）里可用：
// 三键经 postMessage 调原生窗口动作，拖拽区由 CSS app-region 声明（见 global.css）。
function inShell(): boolean {
  return typeof window !== "undefined" && !!(window as { chrome?: { webview?: unknown } }).chrome?.webview;
}

function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!inShell()) return;
    const webview = (window as unknown as { chrome: { webview: { addEventListener: (t: string, cb: (e: CustomEvent) => void) => void; removeEventListener: (t: string, cb: (e: CustomEvent) => void) => void } } }).chrome.webview;
    const onMessage = (e: Event) => {
      const data = (e as unknown as { data?: string }).data;
      if (data === "window:maximized:true") setMaximized(true);
      if (data === "window:maximized:false") setMaximized(false);
    };
    webview.addEventListener("message", onMessage as EventListener);
    return () => webview.removeEventListener("message", onMessage as EventListener);
  }, []);
  return maximized;
}

function post(cmd: string): void {
  (window as unknown as { chrome: { webview: { postMessage: (m: string) => void } } }).chrome.webview.postMessage(cmd);
}

/** 窗口三键：桌面壳内的自绘标题栏按钮（浏览器里不渲染）。 */
export function CaptionButtons(): JSX.Element | null {
  const maximized = useMaximized();
  if (!inShell()) return null;
  const btn = "caption-btn";
  return (
    <div className="caption-buttons">
      <button aria-label="最小化" className={btn} onClick={() => post("window:minimize")} type="button">
        <svg height="10" viewBox="0 0 10 10" width="10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button
        aria-label={maximized ? "还原" : "最大化"}
        className={btn}
        onClick={() => post("window:toggle-maximize")}
        type="button"
      >
        {maximized ? (
          <svg height="10" viewBox="0 0 10 10" width="10">
            <path d="M2.5 2.5V1h7v7H8" fill="none" stroke="currentColor" strokeWidth="1" />
            <rect fill="none" height="6.5" stroke="currentColor" strokeWidth="1" width="6.5" x="0.5" y="2.5" />
          </svg>
        ) : (
          <svg height="10" viewBox="0 0 10 10" width="10">
            <rect fill="none" height="8" stroke="currentColor" strokeWidth="1" width="8" x="1" y="1" />
          </svg>
        )}
      </button>
      <button aria-label="关闭" className={`${btn} caption-btn-close`} onClick={() => post("window:close")} type="button">
        <svg height="10" viewBox="0 0 10 10" width="10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
    </div>
  );
}
