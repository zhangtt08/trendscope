/**
 * Shared HTTP error mapping for all API routers.
 *
 * Why this exists: routers previously returned `500` for zod validation
 * failures (a *client* error), inconsistently across files, so a bad query
 * string looked like a server crash. Keep one rule here:
 *   ZodError / known client-side conditions -> 400 with a readable message
 *   anything else                           -> 500, logged with full detail
 */
import type { Response } from "express";
import { ZodError } from "zod";
import { describeZod } from "../domain/zodMessage";

export { describeZod };

/** 明确属于调用方造成的错误信息(服务层用 Error 抛出的那些)。 */
const NOT_FOUND = /not found|不存在|未找到/i;
const CLIENT_HINTS = /无效|not found|不存在|必须|禁止|已在运行|不足|未找到|cannot|already/i;

/**
 * 服务层显式携带 HTTP 状态的业务错误(如 Profile 治理的 409 冲突)。
 * 只认 4xx/5xx 的整数 status —— 原生驱动错误没有该字段,因此是纯增量行为。
 */
function explicitStatus(e: unknown): number | null {
  const s = (e as { status?: unknown } | null | undefined)?.status;
  return typeof s === "number" && Number.isInteger(s) && s >= 400 && s <= 599 ? s : null;
}

export function clientOrServerError(res: Response, tag: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof ZodError) {
    res.status(400).json({ error: describeZod(e) });
    return;
  }
  const status = explicitStatus(e);
  if (status !== null) {
    if (status >= 500) console.error(`[${tag}]`, msg);
    res.status(status).json({ error: msg });
    return;
  }
  if (NOT_FOUND.test(msg)) {
    res.status(404).json({ error: msg });
    return;
  }
  if (CLIENT_HINTS.test(msg)) {
    res.status(400).json({ error: msg });
    return;
  }
  console.error(`[${tag}]`, msg);
  res.status(500).json({ error: `服务器错误: ${msg}` });
}

/** 用于 id 之类的前置校验。 */
export function badRequest(res: Response, msg: string): void {
  res.status(400).json({ error: msg });
}
