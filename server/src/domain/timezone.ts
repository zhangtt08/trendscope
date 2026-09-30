/**
 * DateNormalizationService — Stage 2 time semantics.
 *
 * Policy:
 * - Everything stored in the DB is UTC (ISO string).
 * - Strings carrying an explicit offset (Z / +08:00 / -05:00) keep that offset
 *   (assumption = explicit_offset).
 * - timezone-NAIVE strings are interpreted in the declared sourceTimezone
 *   (assumption = adapter_default | user_selected), NOT unconditionally UTC.
 * - No sourceTimezone at all → UTC with assumption = unknown (documented
 *   fallback; import paths always declare one in practice).
 * - Invalid / empty → null. Never guessed to "now".
 *
 * Zero-dependency IANA support via Intl.DateTimeFormat (Node ships full ICU).
 */

const CJK_ALARM = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  hour12: false,
});

export type TimezoneAssumption =
  | "explicit_offset"
  | "adapter_default"
  | "user_selected"
  | "unknown";

export interface NormalizedInstant {
  /** UTC ISO string, or null when unparseable */
  iso: string | null;
  /** how the interpretation was chosen */
  assumption: TimezoneAssumption;
  /** the source timezone actually applied (null when explicit offset / none) */
  appliedTimezone: string | null;
}

const DATE_ONLY = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
const NAIVE_DATETIME =
  /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;
const CN_DATETIME = /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s+(\d{1,2}):(\d{2}))?$/;
const EPOCH_SECS = /^\d{9,11}$/;
const EPOCH_MS = /^\d{12,17}$/;
/** has explicit zone: Z suffix or ±HH:MM / ±HHMM (never bare ±HH — that
 *  would misread plain dates like 2026-09-24 as offsets) */
const HAS_OFFSET = /(Z|z)$|[+-]\d{2}:\d{2}$|[+-]\d{4}$/;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `tz` at the given UTC instant. */
function tzOffsetMs(tz: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0; // some ICU versions emit 24h
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return asUtc - instant.getTime();
}

/** Interpret naive wall-clock components as wall time in `tz` → UTC instant. */
function naiveToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  ss: number,
  ms: number,
  tz: string,
): string | null {
  if (mm > 59 || ss > 59 || hh > 23) return null;
  // pretend-UTC then subtract the tz's offset at that instant (2 iterations
  // covers DST-boundary ambiguity; China has none but user timezones might)
  let guess = Date.UTC(y, m - 1, d, hh, mm, ss, ms);
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMs(tz, new Date(guess));
    guess = Date.UTC(y, m - 1, d, hh, mm, ss, ms) - off;
  }
  const date = new Date(guess);
  // wall-clock round-trip guard (e.g. 2024-02-30)
  const dtf = CJK_ALARM;
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  void get;
  return date.toISOString();
}

/**
 * Parse any real-world date shape into a UTC instant + provenance.
 * `sourceTimezone` applies ONLY to timezone-naive input.
 */
export function normalizeDate(
  value: unknown,
  sourceTimezone?: string | null,
  provenance: "adapter_default" | "user_selected" = "adapter_default",
): NormalizedInstant {
  if (value === null || value === undefined) return { iso: null, assumption: "unknown", appliedTimezone: null };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { iso: epochToIso(value), assumption: "explicit_offset", appliedTimezone: null };
  }
  if (typeof value !== "string") return { iso: null, assumption: "unknown", appliedTimezone: null };
  const trimmed = value.trim();
  if (!trimmed || isUnknownToken(trimmed)) {
    return { iso: null, assumption: "unknown", appliedTimezone: null };
  }

  if (EPOCH_SECS.test(trimmed) || EPOCH_MS.test(trimmed)) {
    return { iso: epochToIso(Number(trimmed)), assumption: "explicit_offset", appliedTimezone: null };
  }

  // explicit offset / ISO-with-zone → respect as-is
  if (HAS_OFFSET.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return { iso: new Date(parsed).toISOString(), assumption: "explicit_offset", appliedTimezone: null };
    }
    return { iso: null, assumption: "unknown", appliedTimezone: null };
  }

  const dm = trimmed.match(DATE_ONLY);
  if (dm) {
    return interpretNaive(Number(dm[1]), Number(dm[2]), Number(dm[3]), 0, 0, 0, 0, sourceTimezone, provenance);
  }
  const nm = trimmed.match(NAIVE_DATETIME);
  if (nm) {
    return interpretNaive(
      Number(nm[1]),
      Number(nm[2]),
      Number(nm[3]),
      Number(nm[4]),
      Number(nm[5]),
      Number(nm[6] ?? 0),
      Number((nm[7] ?? "0").padEnd(3, "0")),
      sourceTimezone,
      provenance,
    );
  }
  const cm = trimmed.match(CN_DATETIME);
  if (cm) {
    return interpretNaive(
      Number(cm[1]),
      Number(cm[2]),
      Number(cm[3]),
      Number(cm[4] ?? 0),
      Number(cm[5] ?? 0),
      0,
      0,
      sourceTimezone,
      provenance,
    );
  }

  // last resort: Date.parse without zone info → JS treats as LOCAL; that is
  // machine-dependent, so reject rather than guess (determinism requirement)
  return { iso: null, assumption: "unknown", appliedTimezone: null };
}

function interpretNaive(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  ss: number,
  ms: number,
  sourceTimezone: string | null | undefined,
  provenance: "adapter_default" | "user_selected",
): NormalizedInstant {
  // wall-clock validity guard (2024-02-30 etc.) independent of timezone
  if (mm > 59 || ss > 59 || hh > 23 || m < 1 || m > 12 || d < 1 || d > 31) {
    return { iso: null, assumption: "unknown", appliedTimezone: null };
  }
  const probe = new Date(Date.UTC(y, m - 1, d, hh, mm, ss, ms));
  if (
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return { iso: null, assumption: "unknown", appliedTimezone: null };
  }
  if (sourceTimezone && isValidTimezone(sourceTimezone)) {
    const iso = naiveToUtc(y, m, d, hh, mm, ss, ms, sourceTimezone);
    return { iso, assumption: provenance, appliedTimezone: sourceTimezone };
  }
  // no usable timezone → deterministic UTC fallback, flagged as unknown
  const utc = new Date(Date.UTC(y, m - 1, d, hh, mm, ss, ms));
  return { iso: utc.toISOString(), assumption: "unknown", appliedTimezone: null };
}

function epochToIso(n: number): string | null {
  const ms = n > 1e11 ? n : n * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
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

/** Platform → default source timezone. */
export const PLATFORM_TIMEZONES: Record<string, string> = {
  douyin: "Asia/Shanghai",
  xiaohongshu: "Asia/Shanghai",
  zhihu: "Asia/Shanghai",
  bilibili: "Asia/Shanghai",
  weibo: "Asia/Shanghai",
  toutiao: "Asia/Shanghai",
  baidu: "Asia/Shanghai",
  ithome: "Asia/Shanghai",
  douban: "Asia/Shanghai",
  tieba: "Asia/Shanghai",
};
