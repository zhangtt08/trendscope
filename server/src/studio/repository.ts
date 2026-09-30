/** Studio 持久层(§18-§21):运行历史只追加;人工状态独立表,不写回生成结果。 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { topicStudioMarks, topicStudioRuns } from "../db/schema";

export type StudioRunRow = typeof topicStudioRuns.$inferSelect;

export interface NewStudioRun {
  topicId: number;
  kind: "ai" | "evidence_brief";
  provider: string | null;
  model: string | null;
  promptVersion: string;
  schemaVersion: string;
  evidenceVersion: string;
  evidenceHash: string;
  inputSnapshot: string;
  demoData: boolean;
  staleEvidence: boolean;
  evidenceTruncated: string;
  startedAt: string;
  createdAt: string;
}

export async function insertRun(db: DB, row: NewStudioRun): Promise<StudioRunRow> {
  const [created] = await db
    .insert(topicStudioRuns)
    .values({
      ...row,
      status: "running",
      demoData: row.demoData ? 1 : 0,
      staleEvidence: row.staleEvidence ? 1 : 0,
    })
    .returning();
  return created;
}

export async function finishRun(
  db: DB,
  id: number,
  patch: Partial<Pick<StudioRunRow, "status" | "output" | "unsupportedClaims" | "usage" | "error" | "completedAt" | "durationMs">>,
): Promise<StudioRunRow | null> {
  const [row] = await db.update(topicStudioRuns).set(patch).where(eq(topicStudioRuns.id, id)).returning();
  return row ?? null;
}

export async function listRuns(db: DB, topicId: number, limit = 20): Promise<StudioRunRow[]> {
  return db
    .select()
    .from(topicStudioRuns)
    .where(eq(topicStudioRuns.topicId, topicId))
    .orderBy(desc(topicStudioRuns.id))
    .limit(limit);
}

export async function getRun(db: DB, id: number): Promise<StudioRunRow | null> {
  const [row] = await db.select().from(topicStudioRuns).where(eq(topicStudioRuns.id, id));
  return row ?? null;
}

/** §19:同一话题、同一证据哈希、已成功的最近一次 —— 复用判据。 */
export async function findReusableRun(db: DB, topicId: number, evidenceHash: string): Promise<StudioRunRow | null> {
  const [row] = await db
    .select()
    .from(topicStudioRuns)
    .where(
      and(
        eq(topicStudioRuns.topicId, topicId),
        eq(topicStudioRuns.evidenceHash, evidenceHash),
        eq(topicStudioRuns.status, "completed"),
        isNull(topicStudioRuns.error),
        sql`${topicStudioRuns.output} IS NOT NULL`,
      ),
    )
    .orderBy(desc(topicStudioRuns.id))
    .limit(1);
  return row ?? null;
}

export type StudioMarkRow = typeof topicStudioMarks.$inferSelect;

export async function upsertMark(
  db: DB,
  input: { runId: number; topicId: number; angleIndex: number | null; state: string; note: string | null; now: string },
): Promise<StudioMarkRow> {
  const [existing] = await db
    .select()
    .from(topicStudioMarks)
    .where(
      and(
        eq(topicStudioMarks.runId, input.runId),
        input.angleIndex === null
          ? isNull(topicStudioMarks.angleIndex)
          : sql`${topicStudioMarks.angleIndex} = ${input.angleIndex}`,
      ),
    );
  if (existing) {
    const [updated] = await db
      .update(topicStudioMarks)
      .set({ state: input.state, note: input.note, updatedAt: input.now })
      .where(eq(topicStudioMarks.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(topicStudioMarks)
    .values({
      runId: input.runId,
      topicId: input.topicId,
      angleIndex: input.angleIndex,
      state: input.state,
      note: input.note,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return created;
}

export async function deleteMark(
  db: DB,
  input: { runId: number; angleIndex: number | null },
): Promise<number> {
  const gone = await db
    .delete(topicStudioMarks)
    .where(
      and(
        eq(topicStudioMarks.runId, input.runId),
        input.angleIndex === null
          ? isNull(topicStudioMarks.angleIndex)
          : sql`${topicStudioMarks.angleIndex} = ${input.angleIndex}`,
      ),
    )
    .returning({ id: topicStudioMarks.id });
  return gone.length;
}

export async function listMarks(db: DB, topicId: number): Promise<StudioMarkRow[]> {
  return db.select().from(topicStudioMarks).where(eq(topicStudioMarks.topicId, topicId));
}
