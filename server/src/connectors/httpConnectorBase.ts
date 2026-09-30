/**
 * HttpConnectorBase (Stage 3 §42, moved out of registry.ts in Stage 5 to break
 * a circular import registry ↔ zhihuOfficial). Timeout/retry/rate-limit/
 * structured-error plumbing on top of HttpClient — real platform subclasses
 * only implement page parsing. Retry + rate limiting live in the runtime.
 */
import { z } from "zod";
import { ConnectorError, type PageResult, type RemotePageRequest } from "../domain/collection";
import { HttpClient, type HttpTransport } from "./httpClient";
import type {
  Connector,
  ConnectorMetadata,
  ConnectorPolicy,
  ConnectorRunContext,
} from "./types";
import { validateWithSchema } from "./types";

export abstract class HttpConnectorBase implements Connector {
  abstract readonly metadata: ConnectorMetadata;
  abstract readonly configSchema: z.ZodTypeAny;
  abstract readonly itemSchema: z.ZodTypeAny;
  abstract readonly defaultPolicy: ConnectorPolicy;
  protected readonly http: HttpClient;

  constructor(
    httpDefaults?: { timeoutMs?: number; maxBytes?: number },
    /** Stage 5 §36: inject a replay transport for contract tests (production: omit) */
    transport?: HttpTransport,
  ) {
    this.http = new HttpClient(httpDefaults, transport);
  }

  validateConfig(config: unknown): { ok: boolean; error?: string } {
    return validateWithSchema(this.configSchema, config);
  }

  async healthCheck(ctx: { signal?: AbortSignal }): Promise<{ healthy: boolean; detail?: string }> {
    // default: light metadata endpoint — subclasses override for real checks
    try {
      await this.http.fetchJson(this.healthUrl(), {
        timeoutMs: 5_000,
        signal: ctx.signal,
        maxBytes: 64 * 1024,
      });
      return { healthy: true };
    } catch (e) {
      return {
        healthy: false,
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }

  protected healthUrl(): string {
    throw new ConnectorError("INVALID_CONFIG", "healthUrl not configured");
  }

  abstract collectPage(
    req: RemotePageRequest,
    config: unknown,
    ctx: ConnectorRunContext,
  ): Promise<PageResult<unknown>>;
}

export abstract class BrowserConnectorBase implements Connector {
  abstract readonly metadata: ConnectorMetadata;
  abstract readonly configSchema: z.ZodTypeAny;
  abstract readonly itemSchema: z.ZodTypeAny;
  abstract readonly defaultPolicy: ConnectorPolicy;

  validateConfig(config: unknown): { ok: boolean; error?: string } {
    return validateWithSchema(this.configSchema, config);
  }

  /** Browser automation is contract-only (Stage 4 §27) — never healthy */
  async healthCheck(_ctx: { signal?: AbortSignal }): Promise<{ healthy: boolean; detail?: string }> {
    return { healthy: false, detail: "浏览器采集运行时未实现(仅接口契约)" };
  }

  async collectPage(
    _req: RemotePageRequest,
    _config: unknown,
    _ctx: ConnectorRunContext,
  ): Promise<PageResult<unknown>> {
    throw new ConnectorError("INVALID_CONFIG", "browser connector not implemented (contract only)");
  }
}
