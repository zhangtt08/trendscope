/**
 * 产品内的文本输入对话框(取代 window.prompt —— 原生弹窗在桌面产品里既不可样式化,
 * 也可能被宿主环境拦截,导致按钮看起来是死的)。
 */
import { useEffect, useRef, useState } from "react";

export interface PromptSpec {
  title: string;
  /** 说明文案,写清楚取值规则 */
  hint?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** 返回去掉首尾空格的值;返回 null/undefined 表示取消 */
  onSubmit: (value: string | null) => void;
  /** 返回 true 才允许提交,否则把原因显示在框内 */
  validate?: (value: string) => string | null;
}

export function PromptDialog({ spec, onClose }: { spec: PromptSpec; onClose: () => void }) {
  const [value, setValue] = useState(spec.initialValue ?? "");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function submit() {
    const v = value.trim();
    if (!v) {
      setError("不能为空");
      return;
    }
    const reason = spec.validate?.(v) ?? null;
    if (reason) {
      setError(reason);
      return;
    }
    onClose();
    spec.onSubmit(v);
  }

  return (
    <div
      className="dialog-mask"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
          spec.onSubmit(null);
        }
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={spec.title}>
        <div className="dialog-title">{spec.title}</div>
        {spec.hint && <div className="small muted" style={{ marginBottom: 8 }}>{spec.hint}</div>}
        <input
          ref={ref}
          className="input"
          style={{ width: "100%" }}
          aria-label={spec.title}
          placeholder={spec.placeholder}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") {
              onClose();
              spec.onSubmit(null);
            }
          }}
        />
        {error && <div className="small" style={{ color: "var(--bad)", marginTop: 6 }}>{error}</div>}
        <div className="dialog-foot">
          <button
            className="btn secondary"
            type="button"
            onClick={() => {
              onClose();
              spec.onSubmit(null);
            }}
          >
            取消
          </button>
          <button className="btn accent" type="button" onClick={submit}>
            {spec.confirmLabel ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 单选对话框(取代"输入编号"这种 window.prompt 用法)。
 * options 为空时提示没有可选项,而不是弹一个空框。
 */
export function PickDialog({
  title,
  hint,
  options,
  emptyText = "没有可选项",
  confirmLabel = "确定",
  onCancel,
  onPick,
}: {
  title: string;
  hint?: string;
  options: { value: string; label: string }[];
  emptyText?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onPick: (value: string) => void;
}) {
  const [sel, setSel] = useState(options[0]?.value ?? "");
  return (
    <div
      className="dialog-mask"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-title">{title}</div>
        {hint && <div className="small muted" style={{ marginBottom: 8 }}>{hint}</div>}
        {options.length === 0 ? (
          <div className="small muted">{emptyText}</div>
        ) : (
          <select className="input" style={{ width: "100%" }} aria-label={title} value={sel} onChange={(e) => setSel(e.target.value)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        <div className="dialog-foot">
          <button className="btn secondary" type="button" onClick={onCancel}>
            取消
          </button>
          <button
            className="btn accent"
            type="button"
            disabled={options.length === 0}
            title={options.length === 0 ? "没有可选项" : undefined}
            onClick={() => {
              onCancel();
              onPick(sel);
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
