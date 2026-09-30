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
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `请求失败（HTTP ${res.status}）`;
    throw new Error(msg);
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
