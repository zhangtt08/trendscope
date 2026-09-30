/**
 * CSVAdapter — real CSV ingestion with per-file field mapping.
 * Uses papaparse; bad rows never abort the whole file (handled by import service).
 */
import Papa from "papaparse";
import type { NormalizeContext, SourceAdapter, RawValidationResult } from "./types";
import { NormalizationError } from "./types";
import { mappedRowToNormalized, detectMapping } from "./fieldMapping";

export interface CsvParseResult {
  headers: string[];
  rows: Record<string, unknown>[];
  errors: string[];
  detectedMapping: Record<string, string>;
}

export function parseCsv(content: string, previewOnly = false): CsvParseResult {
  const result = Papa.parse<Record<string, unknown>>(content, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
    preview: previewOnly ? 25 : undefined,
  });

  const headers = result.meta.fields ?? [];
  const rows = result.data.filter(
    (r) => r && typeof r === "object" && Object.keys(r).length > 0,
  );
  const errors = result.errors.map(
    (e) => `row ${typeof e.row === "number" ? e.row + 1 : "?"}: ${e.message}`,
  );
  return { headers, rows, errors, detectedMapping: detectMapping(headers) };
}

export class CSVAdapter implements SourceAdapter {
  readonly id = "csv-adapter";

  getSourceType(): string {
    return "csv";
  }

  getPlatform(): string {
    return "any"; // format adapter — platform comes from rows / user selection
  }

  getSourceTimezone(): string | null {
    return null; // chosen per-import by the user (mapping UI)
  }

  getCapabilities(): string[] {
    return []; // data import only; no live capabilities declared
  }

  validateRaw(input: unknown): RawValidationResult {
    if (input === null || input === undefined || typeof input !== "object") {
      return { ok: false, error: "CSV 每一行必须是对象" };
    }
    const row = input as Record<string, unknown>;
    if (Object.keys(row).length === 0) {
      return { ok: false, error: "CSV 行为空" };
    }
    return { ok: true };
  }

  normalize(input: unknown, ctx: NormalizeContext) {
    this.validateRawOrThrow(input);
    return mappedRowToNormalized(input as Record<string, unknown>, ctx, this.id);
  }

  private validateRawOrThrow(input: unknown): void {
    const v = this.validateRaw(input);
    if (!v.ok) throw new NormalizationError(v.error ?? "invalid CSV row", input);
  }
}
