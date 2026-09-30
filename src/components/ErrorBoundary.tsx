import React from "react";

interface State {
  error: Error | null;
  /** 每次"重试"自增,用于强制重挂载失败的子树 */
  attempt: number;
}

/** Global guard: render a readable panel instead of a white screen. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ui]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-panel">
          <h2 style={{ fontFamily: "var(--mono)" }}>界面出现异常</h2>
          <p className="muted" style={{ maxWidth: 640, margin: "0 auto" }}>
            {this.state.error.message}
          </p>
          <p style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button
              className="btn secondary"
              onClick={() => this.setState({ error: null, attempt: this.state.attempt + 1 })}
            >
              重试
            </button>
            <button className="btn" onClick={() => location.reload()}>
              重新加载
            </button>
          </p>
        </div>
      );
    }
    // 原先"重试"只清 error,导致同一棵会崩溃的子树立刻再崩一次,按钮看起来是坏的。
    // display:contents 让这层包装不产生盒子,.shell 的栅格布局不受影响。
    return (
      <div style={{ display: "contents" }} key={this.state.attempt}>
        {this.props.children}
      </div>
    );
  }
}
