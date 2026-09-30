/**
 * FTS5 search index service (Stage 2 §6/7/8/9/10).
 *
 * Sync strategy: APPLICATION-LAYER sync (documented in ARCHITECTURE.md §7).
 * The app writes CJK-bigram-expanded documents into the FTS5 table so the
 * default unicode61 tokenizer supports Chinese phrase matching without native
 * segmentation. Every create/update/merge path calls syncItemAfterWrite.
 *
 * Safety: MATCH queries are parameterized; user terms are stripped of FTS
 * syntax characters and wrapped as quoted phrases — no SQL injection, and a
 * malformed MATCH surfaces as an error the caller can fall back from.
 */
import { sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { contentItems } from "../db/schema";
import { eq } from "drizzle-orm";

const FTS_TABLE = "fts_documents";

/** Insert a space between adjacent CJK chars and at CJK↔ASCII boundaries. */
export function cjkSpace(s: string): string {
  return s
    .replace(/([A-Za-z0-9])([\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af])/g, "$1 $2")
    .replace(/([\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af])([A-Za-z0-9])/g, "$1 $2")
    .replace(
      /([\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af])(?=[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af])/g,
      "$1 ",
    );
}

function tagsToText(hashtagsJson: string | null): string {
  if (!hashtagsJson) return "";
  try {
    const arr = JSON.parse(hashtagsJson);
    return Array.isArray(arr) ? arr.map((t) => cjkSpace(String(t))).join(" ") : "";
  } catch {
    return "";
  }
}

export interface FtsDoc {
  title: string;
  body: string;
  author: string;
  tags: string;
}

export function docForItem(item: typeof contentItems.$inferSelect): FtsDoc {
  return {
    title: cjkSpace(item.title ?? ""),
    body: cjkSpace(`${item.text ?? ""} ${item.transcript ?? ""}`.trim()),
    author: cjkSpace(`${item.authorName ?? ""} ${item.authorId ?? ""}`.trim()),
    tags: tagsToText(item.hashtags),
  };
}

/** Reindex one item (skips + cleans up merged items). Safe on missing rows. */
export async function syncItemAfterWrite(db: DB, contentItemId: number): Promise<void> {
  const [item] = await db
    .select()
    .from(contentItems)
    .where(eq(contentItems.id, contentItemId))
    .limit(1);
  if (!item) return;
  const remove = db.run(sql`DELETE FROM ${sql.raw(FTS_TABLE)} WHERE rowid = ${contentItemId}`);
  void remove;
  if (item.mergedIntoContentItemId !== null) return; // merged source leaves the index
  const doc = docForItem(item);
  db.run(
    sql`INSERT INTO ${sql.raw(FTS_TABLE)}(rowid, title, body, author, tags)
        VALUES (${contentItemId}, ${doc.title}, ${doc.body}, ${doc.author}, ${doc.tags})`,
  );
}

export function deleteItemFromIndex(db: DB, contentItemId: number): void {
  db.run(sql`DELETE FROM ${sql.raw(FTS_TABLE)} WHERE rowid = ${contentItemId}`);
}

/** Rebuild the whole index from content_items. */
export function rebuildFts(db: DB): void {
  db.run(sql`DELETE FROM ${sql.raw(FTS_TABLE)}`);
  const items = db.select().from(contentItems).all();
  for (const item of items) {
    if (item.mergedIntoContentItemId !== null) continue;
    const doc = docForItem(item);
    db.run(
      sql`INSERT INTO ${sql.raw(FTS_TABLE)}(rowid, title, body, author, tags)
          VALUES (${item.id}, ${doc.title}, ${doc.body}, ${doc.author}, ${doc.tags})`,
    );
  }
}

/**
 * Boot-time idempotent backfill: rebuild when the index count diverges from
 * live (non-merged) item count. Makes the Stage1→Stage2 migration seamless.
 */
export function ensureFtsBackfilled(db: DB): { rebuilt: boolean; indexed: number } {
  const ftsCount = (
    db.get(sql`SELECT count(*) AS n FROM ${sql.raw(FTS_TABLE)}`) as { n: number } | undefined
  )?.n;
  const liveCount = (
    db.get(
      sql`SELECT count(*) AS n FROM content_items WHERE merged_into_content_item_id IS NULL`,
    ) as { n: number } | undefined
  )?.n;
  if (ftsCount !== liveCount) {
    rebuildFts(db);
  }
  return { rebuilt: ftsCount !== liveCount, indexed: liveCount ?? 0 };
}

/**
 * Build a safe FTS5 MATCH expression from user input.
 * - each whitespace-separated term becomes a quoted phrase
 * - CJK terms become char-spaced phrases ("探 店") matching our bigram docs
 * - ASCII terms get a prefix star ("vlog"*)
 * - FTS syntax characters are stripped; empty result → null (caller falls back)
 */
export function buildMatchQuery(input: string): string | null {
  const terms = input
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["*(){}:^\-]/g, "").trim())
    .filter((t) => t.length > 0 && /[\p{L}\p{N}]/u.test(t));
  if (terms.length === 0) return null;
  return terms
    .map((t) => {
      const spaced = cjkSpace(t).trim();
      return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)
        ? `"${spaced}"`
        : `"${spaced}"*`;
    })
    .join(" AND ");
}

/** BM25 rank of a match expression over the index (for tests/diagnostics). */
export function ftsSearchIds(db: DB, match: string, limit: number): number[] {
  const rows = db
    .all(
      sql`SELECT rowid FROM ${sql.raw(FTS_TABLE)}
          WHERE ${sql.raw(FTS_TABLE)} MATCH ${match}
          ORDER BY bm25(${sql.raw(FTS_TABLE)}) ASC
          LIMIT ${limit}`,
    ) as { rowid: number }[];
  return rows.map((r) => r.rowid);
}
