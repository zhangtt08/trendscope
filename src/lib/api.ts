/** Typed API client — every failure surfaces as a readable Error, never a white screen. */

/** True for an aborted request — a cancelled request is not a user-facing error. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  return err instanceof Error && err.name === "AbortError";
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch (e) {
    // Let cancellation pass through untouched: callers must be able to tell
    // "superseded/unmounted" apart from "server unreachable".
    if (isAbortError(e)) throw e;
    throw new Error("无法连接到服务器（API 不可达）");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-json response body — fall through to status check
  }
  if (!res.ok) {
    // 错误体有两种既有形状,都必须读出人话:
    //   · `{error:"字符串"}` —— 本仓业务端点一贯的写法;
    //   · `{error:{code,message}}` + 顶层 `message` —— Agent 契约与本机边界闸门(403)的写法。
    // 只认第一种的话,被闸门拒掉时界面会显示 `[object Object]`,而那句中文拒绝理由
    // ("这一条拒绝与你的登录状态无关")就永远到不了用户眼前。
    const raw = body && typeof body === "object" ? (body as { error?: unknown; message?: unknown }) : null;
    const nested = raw && typeof raw.error === "object" && raw.error !== null
      ? (raw.error as { message?: unknown }).message
      : undefined;
    const candidates = [
      typeof raw?.error === "string" ? raw.error : undefined,
      typeof nested === "string" ? nested : undefined,
      typeof raw?.message === "string" ? raw.message : undefined,
    ];
    const msg = candidates.find((c) => c && c.trim()) ?? `请求失败（HTTP ${res.status}）`;
    throw new Error(String(msg));
  }
  return body as T;
}

export function post<T>(path: string, payload: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(payload) });
}

export function patch<T>(path: string, payload: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(payload) });
}

export function del<T>(path: string, payload?: unknown): Promise<T> {
  return api<T>(path, {
    method: "DELETE",
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
