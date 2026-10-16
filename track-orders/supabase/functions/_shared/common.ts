import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const ALLOWED_ORIGINS = new Set([
  "https://btvrestored.ru",
  "https://www.btvrestored.ru",
  "https://rtvrestored.ru",
  "https://www.rtvrestored.ru",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
]);

export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return ALLOWED_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const permitted = originAllowed(req);
  return {
    ...(permitted && origin ? { "Access-Control-Allow-Origin": origin } : { "Access-Control-Allow-Origin": "*" }),
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export function options(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

function getSecretKey(): string {
  const direct = Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  try {
    const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    if (typeof all.default === "string") return all.default;
    const found = Object.values(all).find((v) => typeof v === "string");
    if (typeof found === "string") return found;
  } catch {
    // Direct key variables are preferred when present.
  }
  throw new Error("Supabase server secret is missing from Edge Function environment.");
}

export function serverClient() {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new Error("SUPABASE_URL is missing from Edge Function environment.");
  return createClient(url, getSecretKey(), {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function requesterIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim().slice(0, 100);
  return (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown").slice(0, 100);
}

export async function consumeRateLimit(
  db: ReturnType<typeof serverClient>,
  req: Request,
  scope: string,
  channel: string,
  max: number
): Promise<number> {
  const salt = Deno.env.get("TRACK_REQUEST_HASH_SALT");
  if (!salt || salt.length < 24) throw new Error("TRACK_REQUEST_HASH_SALT must contain at least 24 characters.");
  const identity = await sha256Hex(salt + ":" + scope + ":" + channel + ":" + requesterIp(req));
  const bucketStart = new Date(Math.floor(Date.now() / 600000) * 600000).toISOString();
  const { data, error } = await db.rpc("track_orders_consume_rate_limit", {
    p_key_hash: identity,
    p_bucket_start: bucketStart
  });
  if (error) throw new Error("Rate-limit check failed: " + error.message);
  return Number(data || 0);
}

export function clipProvider(value: string): "youtube" | "vk" | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
      const p = url.pathname;
      const hasVideoId = host === "youtu.be"
        ? p.length > 1
        : ((p === "/watch" && !!url.searchParams.get("v"))
          || /^\/(shorts|embed|live)\/[^/]+/.test(p));
      return hasVideoId ? "youtube" : null;
    }
    if (["vk.com", "m.vk.com", "vkvideo.ru"].includes(host)) {
      return /^\/(video|clip|video_ext\.php)(\/|$)/.test(url.pathname) ? "vk" : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function cleanCatalog(value: unknown): { provider: string | null; data: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { provider: null, data: {} };
  const v = value as Record<string, unknown>;
  const provider = v.provider === "musicbrainz" || v.provider === "discogs" ? String(v.provider) : null;
  const data: Record<string, unknown> = {};
  for (const key of ["id", "name", "title", "artist", "year", "score", "url", "detail"]) {
    const raw = v[key];
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    let val = String(raw).slice(0, key === "detail" ? 300 : 200);
    if (key === "url") {
      try {
        const u = new URL(val);
        const ok = u.protocol === "https:" &&
          (u.hostname === "musicbrainz.org" || u.hostname.endsWith(".musicbrainz.org") ||
           u.hostname === "discogs.com" || u.hostname.endsWith(".discogs.com"));
        if (!ok) continue;
        val = u.toString();
      } catch {
        continue;
      }
    }
    data[key] = val;
  }
  return { provider, data };
}
