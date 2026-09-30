/**
 * The single data-fetching hook for this app. Everything that reads from the
 * API goes through here — it is the only place abort + stale-response
 * protection live, so pages cannot re-implement (and get wrong) the race guard.
 *
 * Two independent safeguards, deliberately redundant:
 *  1. AbortController — cancels the superseded request on the wire.
 *  2. generation counter — a response is applied only if it is still the
 *     newest one, so an in-flight request that could not be aborted in time
 *     can never overwrite a newer result.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, isAbortError } from "./api";

export interface UseResourceOptions {
  /** Set false to skip the request entirely (path may also be null). */
  enabled?: boolean;
  /**
   * For identity-scoped resources (a detail page keyed by id): when the path
   * changes, the previous result belongs to a DIFFERENT entity, so drop it
   * instead of painting it over the new subject. List endpoints keep their
   * rows across filter changes (see `refreshing`) — that is the default.
   */
  resetOnPathChange?: boolean;
}

export interface Resource<T> {
  data: T | null;
  error: string | null;
  /** Any request in flight, first load or refresh. */
  loading: boolean;
  /** Nothing to show yet — render a full-area loading state. */
  initialLoading: boolean;
  /** Refreshing while older data stays on screen — render a light hint only. */
  refreshing: boolean;
  /** Re-run the current request (after a mutation, or from a retry button). */
  reload: () => void;
  /** Replace the cached result without a round trip (optimistic writes). */
  setData: (next: T | null) => void;
}

export function useResource<T>(
  path: string | null,
  options: UseResourceOptions = {},
): Resource<T> {
  const enabled = options.enabled !== false && path !== null;
  const resetOnPathChange = options.resetOnPathChange === true;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);

  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const lastPathRef = useRef<string | null>(path);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1; // retire every response from this component
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!enabled || path === null) return;

    const generation = ++generationRef.current;
    const switched = lastPathRef.current !== path;
    lastPathRef.current = path;
    if (switched && resetOnPathChange) setData(null);

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);

    api<T>(path, { signal: controller.signal })
      .then((result) => {
        if (!mountedRef.current || generation !== generationRef.current) return; // stale
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => {
        // A cancelled request is not an error: no banner, no console noise.
        if (isAbortError(e) || !mountedRef.current || generation !== generationRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mountedRef.current && generation === generationRef.current) setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, path, nonce, resetOnPathChange]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    data,
    error,
    loading,
    initialLoading: loading && data === null,
    refreshing: loading && data !== null,
    reload,
    setData,
  };
}

/** Debounce a fast-changing value (search boxes). Selects/filters must NOT be debounced. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Build a stable query string, dropping empty values so the path key only
 *  changes when something actually changed. */
export function buildQuery(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || v === null) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}
