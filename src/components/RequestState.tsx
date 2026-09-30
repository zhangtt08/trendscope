/** Shared request-state UI so pages stop inventing 8 different error banners. */
import { RotateCw } from "lucide-react";

/** Failed load + a way back. Never blanks the table the user was reading. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="banner err" role="alert">
      <span style={{ flex: 1 }}>{message}</span>
      <button className="btn secondary" onClick={onRetry} type="button">
        <RotateCw size={13} /> 重试
      </button>
    </div>
  );
}

/** Light in-flight hint shown while the previous result stays on screen. */
export function RefreshHint({ show = true, text = "正在更新…" }: { show?: boolean; text?: string }) {
  if (!show) return null;
  return (
    <span className="small muted refresh-hint" role="status" aria-live="polite">
      {text}
    </span>
  );
}
