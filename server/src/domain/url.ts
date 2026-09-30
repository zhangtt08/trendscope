/**
 * Canonical URL normalization (spec §16).
 * Conservative by design: only strip KNOWN tracking params, never rewrite paths,
 * never drop content-identifying query params (e.g. /video/{id}, item_id=...).
 * Over-normalization that merges distinct content is worse than under-normalization.
 */

const TRACKING_PARAMS = new Set([
  // Google / generic analytics
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_name",
  "utm_cid",
  "utm_reader",
  "utm_social",
  "utm_viz_id",
  "ga_source",
  "ga_medium",
  "ga_campaign",
  "gclid",
  "gclsrc",
  "dclid",
  // Meta / social share trackers
  "fbclid",
  "igshid",
  "igsh",
  "mibextid",
  "spm",
  "smid",
  "vd_source",
  "vd_sid",
  // Douyin / TikTok share noise
  "share_app_id",
  "share_link_id",
  "share_token",
  "_r",
  "r",
  "is_from_webapp",
  "sender_device",
  "sender_device_id",
  "web_id",
  "msToken",
  "x_link_source",
  "enter_from",
  "enter_method",
  "previous_page",
  "app_platform",
  "more_together_result_id",
  // Xiaohongshu
  "xsec_token",
  "xsec_source",
  "share_from",
  // Bilibili
  "spm_id_from",
  "vd_source",
  "pfrom",
  "share_source",
  "share_medium",
  "share_plat",
  "share_session_id",
  "unique_k",
  "up_id",
  "timestamp",
  // Zhihu
  "utm_psn",
  "utm_oi",
  "oh_share_link",
  // Weibo
  "weibo_id",
  "mod",
  "proxy_token",
  // Misc
  "ref",
  "ref_src",
  "ref_url",
  "source",
  "from",
  "sid",
  "cid_share",
  "scene",
]);

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
};

export function canonicalizeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // tolerate scheme-less input like "www.example.com/x" — but never invent hosts
    if (/^[\w-]+(\.[\w-]+)+\//.test(trimmed)) {
      try {
        url = new URL(`https://${trimmed}`);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.port && DEFAULT_PORTS[url.protocol] === url.port) {
    url.port = "";
  }

  const params = [...url.searchParams.entries()];
  url.search = "";
  const kept: string[] = [];
  for (const [k, v] of params) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) continue;
    kept.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  if (kept.length > 0) url.search = `?${kept.join("&")}`;

  let out = url.toString();
  // strip trailing slash ("https://a.com/path/" → "https://a.com/path"; root stays)
  if (url.pathname !== "/" && out.endsWith("/")) {
    out = out.slice(0, -1);
  } else if (url.pathname === "/" && kept.length === 0) {
    out = out.replace(/\/$/, "");
  }
  return out;
}
