/**
 * FixtureAdapter — loads bundled fixture files used by tests and by the
 * "load fixture" button in the Import Center. Fixture envelope:
 *
 * {
 *   "name": "douyin-like", "platform": "douyin", "sourceType": "fixture",
 *   "mapping": { ... optional canonical->source key map ... },
 *   "rows": [ { ...platform-shaped raw rows, deliberately heterogeneous... } ]
 * }
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { NormalizeContext, SourceAdapter, RawValidationResult } from "./types";
import { NormalizationError } from "./types";
import { mappedRowToNormalized } from "./fieldMapping";
import { canonicalizeUrl } from "../domain/url";

export const FixtureEnvelopeSchema = z.object({
  name: z.string().min(1),
  /** 面向用户的中文名(§78);缺省时前端回退到 name。 */
  title: z.string().min(1).nullish(),
  platform: z.string().min(1),
  sourceType: z.string().min(1).default("fixture"),
  /** timezone for timezone-NAIVE dates in this fixture (Stage 2) */
  sourceTimezone: z.string().min(1).nullish(),
  mapping: z.record(z.string()).nullish(),
  rows: z.array(z.record(z.unknown())).min(1),
});
export type FixtureEnvelope = z.infer<typeof FixtureEnvelopeSchema>;

/** Fixtures dir: bundled with server build; falls back to repo path for tsx/tests. */
export function fixturesDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "server", "fixtures"),
    path.resolve(__dirname, "../../../server/fixtures"),
    path.resolve(__dirname, "../../fixtures"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export function listFixtures(): { name: string; title: string; file: string; rowCount: number }[] {
  const dir = fixturesDir();
  if (!fs.existsSync(dir)) return [];
  const out: { name: string; title: string; file: string; rowCount: number }[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const env = FixtureEnvelopeSchema.parse(
        JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")),
      );
      out.push({ name: env.name, title: env.title ?? env.name, file: f, rowCount: env.rows.length });
    } catch {
      // unparseable fixture files are skipped, never crash the listing
    }
  }
  return out;
}

export function loadFixture(file: string): FixtureEnvelope {
  const dir = fixturesDir();
  const full = path.join(dir, path.basename(file)); // basename: no traversal
  const raw = JSON.parse(fs.readFileSync(full, "utf-8"));
  return FixtureEnvelopeSchema.parse(raw);
}

export class FixtureAdapter implements SourceAdapter {
  readonly id = "fixture-adapter";

  getSourceType(): string {
    return "fixture";
  }

  getPlatform(): string {
    return "any";
  }

  getSourceTimezone(): string | null {
    return null; // fixtures declare sourceTimezone per envelope
  }

  getCapabilities(): string[] {
    return [];
  }

  validateRaw(input: unknown): RawValidationResult {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, error: "示例数据行必须是对象" };
    }
    return { ok: true };
  }

  normalize(input: unknown, ctx: NormalizeContext) {
    const v = this.validateRaw(input);
    if (!v.ok) throw new NormalizationError(v.error ?? "invalid fixture row", input);
    const record = mappedRowToNormalized(
      input as Record<string, unknown>,
      ctx,
      this.id,
    );
    // fixture rows may carry pre-canonical urls; canonicalize for consistency
    record.canonicalUrl = canonicalizeUrl(record.url);
    return record;
  }
}
