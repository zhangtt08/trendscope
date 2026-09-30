/**
 * Unified HttpClient (Stage 3 §43/44, Stage 5 §36 transport injection) — every
 * future API Connector goes through this: timeout, AbortSignal, size limit,
 * safe headers, structured errors. No browser/anti-detection logic lives here.
 *
 * Stage 5: a custom `transport` may be injected so that REAL connectors (e.g.
 * ZhihuOfficialConnector) can be contract-tested against recorded official
 * responses without a live secret. Production passes no transport → real HTTP.
 */
import { ConnectorError, isAbortError } from "../domain/collection";

export interface HttpOptions {
  timeoutMs?: number; // default 15_000
  maxBytes?: number; // default 5 MB
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** 默认 GET。POST 请求必须显式给 body —— 之前类型里没有这两个字段,
   *  任何"POST"调用实际发出去的都是空 body 的 GET。 */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string;
}

export interface HttpJsonResult<T = unknown> {
  status: number;
  body: T;
  durationMs: number;
  bytes: number;
}

/**
 * Transport abstraction (Stage 5 §36). Production = real HTTP (default);
 * tests inject a replay transport that returns recorded official responses.
 */
export type HttpTransport = (
  url: string,
  init: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    method?: string;
    body?: string;
  },
) => Promise<{ status: number; body: unknown }>;

/** Header names that must never be logged or persisted. */
const SENSITIVE_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i;

export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = SENSITIVE_HEADERS.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

export class HttpClient {
  private readonly transport: HttpTransport | null;

  constructor(
    private readonly defaults: { timeoutMs?: number; maxBytes?: number } = {},
    transport?: HttpTransport,
  ) {
    this.transport = transport ?? null;
  }

  async fetchJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<HttpJsonResult<T>> {
    const timeoutMs = opts.timeoutMs ?? this.defaults.timeoutMs ?? 15_000;
    const maxBytes = opts.maxBytes ?? this.defaults.maxBytes ?? 5 * 1024 * 1024;
    const started = Date.now();

    // ---- injected transport (Stage 5 §36 replay/contract tests): the replay
    //      owns its data; only status mapping applies below. ----
    if (this.transport) {
      // An already-aborted caller must not reach the transport: replay paths
      // have no real socket to cancel, so honour the signal at this boundary.
      if (opts.signal?.aborted) throw new ConnectorError("CANCELLED", "请求已取消");
      const out = await this.transport(url, {
        headers: opts.headers,
        signal: opts.signal,
        method: opts.method ?? "GET",
        body: opts.body,
      });
      if (out.status < 200 || out.status >= 300) {
        throw mapHttpStatus(out.status, out.body);
      }
      return {
        status: out.status,
        body: out.body as T,
        durationMs: Date.now() - started,
        bytes: JSON.stringify(out.body ?? null).length,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const onOuterAbort = () => controller.abort(new Error("cancelled"));
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
      });
      const buf = await res.arrayBuffer();
      const durationMs = Date.now() - started;
      if (buf.byteLength > maxBytes) {
        throw new ConnectorError("INVALID_RESPONSE", `响应体过大:${buf.byteLength} 字节,上限 ${maxBytes} 字节`);
      }
      if (!res.ok) {
        const bodyText = new TextDecoder("utf-8").decode(buf).slice(0, 4096);
        throw mapHttpStatus(res.status, safeParse(bodyText), {
          headers: redactHeaders(Object.fromEntries(res.headers.entries())),
        });
      }
      let body: T;
      try {
        body = JSON.parse(new TextDecoder("utf-8").decode(buf)) as T;
      } catch (e) {
        throw new ConnectorError("INVALID_RESPONSE", `响应不是合法 JSON:${e instanceof Error ? e.message : e}`);
      }
      return { status: res.status, body, durationMs, bytes: buf.byteLength };
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      if (isAbortError(e) || (e instanceof Error && e.name === "AbortError")) {
        // distinguish timeout vs outer cancel
        const msg = e instanceof Error ? e.message : "";
        if (/timeout/i.test(msg)) throw new ConnectorError("TIMEOUT", `${timeoutMs}ms 内未返回,已超时`);
        throw new ConnectorError("CANCELLED", "请求已取消");
      }
      if (e instanceof TypeError) {
        // fetch network-layer failure
        throw new ConnectorError("NETWORK_ERROR", `网络错误:${e.message}`);
      }
      throw new ConnectorError("UNKNOWN", e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Shared HTTP status → ConnectorError mapping (real HTTP and replay alike). */
function mapHttpStatus(status: number, body: unknown, extra?: Record<string, unknown>): ConnectorError {
  const code =
    status === 429
      ? "RATE_LIMITED"
      : status === 401
        ? "AUTH_ERROR"
        : status === 403
          ? "PERMISSION_DENIED"
          : status >= 500
            ? "REMOTE_5XX"
            : "INVALID_RESPONSE";
  return new ConnectorError(code, `HTTP ${status}`, {
    status,
    providerErrorCode: extractProviderCode(body),
    ...(extra ?? {}),
  });
}

/** Pull a provider error code (e.g. Zhihu's Code field) from an error body — never a secret. */
export function extractProviderCode(body: unknown): unknown {
  if (body && typeof body === "object" && "Code" in (body as Record<string, unknown>)) {
    return (body as Record<string, unknown>).Code;
  }
  return undefined;
}
