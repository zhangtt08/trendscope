/**
 * Date normalization. Accepts the shapes real-world exports actually use:
 * ISO strings, epoch seconds/ms, "2024/01/02 03:04", "2024年1月2日", plain dates.
 * Anything unparseable → null (never guessed, never defaulted to now).
 *
 * Timezone policy (deterministic, machine-independent): timezone-naive strings
 * are interpreted as UTC. Strings carrying an explicit offset (Z / +08:00) keep
 * that offset. This keeps pipeline output reproducible across machines.
 */

const DATE_ONLY = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
const NAIVE_DATETIME =
  /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;
const CN_DATETIME = /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s+(\d{1,2}):(\d{2}))?$/;
const EPOCH_SECS = /^\d{9,11}$/;
const EPOCH_MS = /^\d{12,17}$/;

export function parseDateToIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return epochToIso(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || isUnknownToken(trimmed)) return null;

    if (EPOCH_SECS.test(trimmed)) return epochToIso(Number(trimmed));
    if (EPOCH_MS.test(trimmed)) return epochToIso(Number(trimmed));

    const dm = trimmed.match(DATE_ONLY);
    if (dm) {
      return buildIso(Number(dm[1]), Number(dm[2]), Number(dm[3]), 0, 0, 0);
    }

    const nm = trimmed.match(NAIVE_DATETIME);
    if (nm) {
      return buildIso(
        Number(nm[1]),
        Number(nm[2]),
        Number(nm[3]),
        Number(nm[4]),
        Number(nm[5]),
        Number(nm[6] ?? 0),
      );
    }

    const cm = trimmed.match(CN_DATETIME);
    if (cm) {
      return buildIso(
        Number(cm[1]),
        Number(cm[2]),
        Number(cm[3]),
        Number(cm[4] ?? 0),
        Number(cm[5] ?? 0),
        0,
      );
    }

    // explicit-offset ISO strings (Z, +08:00) → Date.parse is exact
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
    return null;
  }
  return null;
}

function epochToIso(n: number): string | null {
  const ms = n > 1e11 ? n : n * 1000; // seconds vs milliseconds heuristic
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function buildIso(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  ss: number,
): string | null {
  if (mm > 59 || ss > 59 || hh > 23) return null;
  const date = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null; // e.g. 2024-02-30
  }
  return date.toISOString();
}

export function isUnknownToken(s: string): boolean {
  const t = s.trim().toLowerCase();
  return (
    t === "" ||
    t === "null" ||
    t === "none" ||
    t === "n/a" ||
    t === "na" ||
    t === "-" ||
    t === "—" ||
    t === "undefined" ||
    t === "未知" ||
    t === "无"
  );
}
