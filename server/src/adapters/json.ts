/**
 * JSONAdapter — accepts a single object or an array of objects.
 * Objects already using canonical keys work with no mapping; otherwise the
 * caller supplies a field mapping (same machinery as CSV).
 */
import type { NormalizeContext, SourceAdapter, RawValidationResult } from "./types";
import { NormalizationError } from "./types";
import { mappedRowToNormalized, detectMapping } from "./fieldMapping";

export function parseJsonPayload(content: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new NormalizationError(
      `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      null,
    );
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === "object") return [parsed];
  throw new NormalizationError("JSON 内容必须是对象或对象数组", null);
}

export function detectJsonMapping(rows: unknown[]): Record<string, string> {
  const keys = new Set<string>();
  for (const r of rows.slice(0, 50)) {
    if (r && typeof r === "object") {
      Object.keys(r as Record<string, unknown>).forEach((k) => keys.add(k));
    }
  }
  return detectMapping([...keys]);
}

export class JSONAdapter implements SourceAdapter {
  readonly id = "json-adapter";

  getSourceType(): string {
    return "json";
  }

  getPlatform(): string {
    return "any";
  }

  getSourceTimezone(): string | null {
    return null; // declared per-import via adapter config / mapping UI
  }

  getCapabilities(): string[] {
    return [];
  }

  validateRaw(input: unknown): RawValidationResult {
    if (input === null || input === undefined || typeof input !== "object") {
      return { ok: false, error: "JSON 记录必须是对象" };
    }
    if (Array.isArray(input)) {
      return { ok: false, error: "JSON 记录必须是单个对象(不能是数组)" };
    }
    return { ok: true };
  }

  normalize(input: unknown, ctx: NormalizeContext) {
    const v = this.validateRaw(input);
    if (!v.ok) throw new NormalizationError(v.error ?? "invalid JSON record", input);
    return mappedRowToNormalized(input as Record<string, unknown>, ctx, this.id);
  }
}
