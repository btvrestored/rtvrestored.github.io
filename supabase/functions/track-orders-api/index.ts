import { neon } from "npm:@neondatabase/serverless@1.0.2";

type Channel = "btv" | "rtv";
type Provider = "musicbrainz" | "discogs";

const DATABASE_URL = Deno.env.get("DATABASE_URL") || "";
const neonSql = DATABASE_URL ? neon(DATABASE_URL) : null;
const pool = neonSql ? {
  query: async (query: string, params: any[] = []) => ({ rows: await neonSql.query(query, params) })
} : null;
const SITE_CHANNEL = Deno.env.get("TRACK_ORDERS_CHANNEL") || "";
const AUTH_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const AUTH_KEY = Deno.env.get("TRACK_ORDERS_AUTH_PUBLISHABLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
const USER_AGENT = "TrackOrdersAPI/1.0 (https://github.com/btvrestored/track-orders-api)";
const ORIGINS = new Set([
  "https://btvrestored.ru", "https://www.btvrestored.ru",
  "https://rtvrestored.ru", "https://www.rtvrestored.ru"
]);

function db() {
  if (!pool) throw new Error("DATABASE_URL is not configured.");
  return pool;
}
function channelFromOrigin(req: Request): Channel | null {
  const origin = req.headers.get("origin");
  if (!origin || !ORIGINS.has(origin)) return null;
  const host = new URL(origin).hostname.toLowerCase().replace(/^www\./, "");
  return host === "btvrestored.ru" ? "btv" : host === "rtvrestored.ru" ? "rtv" : null;
}
function corsHeaders(req: Request): Headers {
  const h = new Headers({
    "Vary": "Origin", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400"
  });
  const origin = req.headers.get("origin");
  if (origin && ORIGINS.has(origin) && channelFromOrigin(req) === SITE_CHANNEL) h.set("Access-Control-Allow-Origin", origin);
  return h;
}
function json(req: Request, data: unknown, status = 200): Response {
  const h = corsHeaders(req);
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: h });
}
function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get("content-length") || "0");
  if (length > 16384) return null;
  const raw = await req.text();
  if (raw.length > 16384) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
function validClipUrl(value: string): { url: string; provider: "youtube" | "vk" } | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || value.length > 1000) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
      const p = u.pathname;
      const valid = host === "youtu.be" ? p.length > 1 :
        (p === "/watch" && Boolean(u.searchParams.get("v"))) || /^\/(shorts|embed|live)\/[^/]+/.test(p);
      return valid ? { url: u.toString(), provider: "youtube" } : null;
    }
    if (["vk.com", "m.vk.com", "vkvideo.ru"].includes(host) &&
        /^\/(video[^/]*|clip[^/]*|video_ext\.php)(\/|$)/.test(u.pathname)) {
      return { url: u.toString(), provider: "vk" };
    }
    return null;
  } catch { return null; }
}
async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, "0")).join("");
}
function requesterIp(req: Request): string {
  return (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unavailable").slice(0, 100);
}
class RateLimitError extends Error {}
async function consumeRateLimit(req: Request, action: "submit" | "catalog", channel: Channel, limit: number) {
  const salt = Deno.env.get("TRACK_REQUEST_HASH_SALT") || "";
  if (salt.length < 24) throw new Error("TRACK_REQUEST_HASH_SALT is not configured.");
  const key = await sha256(salt + "\u0000" + action + "\u0000" + channel + "\u0000" + requesterIp(req));
  const bucket = new Date(Math.floor(Date.now() / 600000) * 600000);
  const result = await db().query(
    "INSERT INTO public.track_request_rate_limits (key_hash, action, channel, bucket_start, attempts) " +
    "VALUES ($1, $2, $3, $4, 1) ON CONFLICT (key_hash, action, channel, bucket_start) " +
    "DO UPDATE SET attempts = public.track_request_rate_limits.attempts + 1 RETURNING attempts",
    [key, action, channel, bucket]
  );
  if (Number(result.rows[0]?.attempts || 0) > limit) throw new RateLimitError("Too many requests");
}
function cleanCatalog(value: unknown): { provider: Provider | null; match: Record<string, string> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { provider: null, match: {} };
  const raw = value as Record<string, unknown>;
  const provider: Provider | null = raw.provider === "musicbrainz" || raw.provider === "discogs" ? raw.provider : null;
  const match: Record<string, string> = {};
  for (const key of ["id", "name", "title", "artist", "year", "score", "detail", "url"]) {
    if (typeof raw[key] !== "string" && typeof raw[key] !== "number") continue;
    let value = String(raw[key]).slice(0, key === "detail" ? 300 : 200);
    if (key === "url") {
      try {
        const u = new URL(value);
        if (u.protocol !== "https:" || !["musicbrainz.org", "discogs.com"].includes(u.hostname.toLowerCase().replace(/^www\./, ""))) continue;
        value = u.toString();
      } catch { continue; }
    }
    match[key] = value;
  }
  return { provider, match };
}
function authConfig(channel: Channel) {
  if (channel !== SITE_CHANNEL) return { url: "", key: "" };
  return { url: AUTH_URL, key: AUTH_KEY };
}
async function authenticateAdmin(req: Request, target: Channel | "all") {
  const site = channelFromOrigin(req);
  const token = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!site || !token) return null;
  const auth = authConfig(site);
  if (!auth.url || !auth.key) return null;
  let user: { id?: string; email?: string };
  try {
    const response = await fetch(auth.url + "/auth/v1/user", {
      headers: { apikey: auth.key, Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) return null;
    user = await response.json() as { id?: string; email?: string };
  } catch { return null; }
  if (!user.id || !/^[0-9a-f-]{36}$/i.test(user.id)) return null;
  const sql = target === "all"
    ? "SELECT 1 FROM public.track_request_admins WHERE auth_project = $1 AND auth_user_id = $2::uuid AND active = true AND channel = 'all' LIMIT 1"
    : "SELECT 1 FROM public.track_request_admins WHERE auth_project = $1 AND auth_user_id = $2::uuid AND active = true AND channel IN ($3, 'all') LIMIT 1";
  const params = target === "all" ? [site, user.id] : [site, user.id, target];
  const grant = await db().query(sql, params);
  if (!grant.rows.length) return null;
  return { authProject: site, userId: user.id, email: user.email };
}
function selectedChannel(req: Request, site: Channel): Channel | "all" | null {
  const value = new URL(req.url).searchParams.get("channel") || site;
  return value === "btv" || value === "rtv" || value === "all" ? value : null;
}
function quotePhrase(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
async function claimCatalogSlot(provider: Provider, gapMs: number): Promise<boolean> {
  const result = await db().query(
    "INSERT INTO public.track_catalog_api_state AS state (provider, next_allowed_at) " +
    "VALUES ($1, clock_timestamp() + ($2 * interval '1 millisecond')) " +
    "ON CONFLICT (provider) DO UPDATE SET next_allowed_at = clock_timestamp() + ($2 * interval '1 millisecond') " +
    "WHERE state.next_allowed_at <= clock_timestamp() RETURNING provider",
    [provider, gapMs]
  );
  return result.rows.length > 0;
}
async function searchMusicBrainz(artist: string, title: string): Promise<Record<string, unknown>[]> {
  const entity = title ? "recording" : "artist";
  const query = title ? "recording:" + quotePhrase(title) + " AND artist:" + quotePhrase(artist) : "artist:" + quotePhrase(artist);
  const url = new URL("https://musicbrainz.org/ws/2/" + entity + "/");
  url.searchParams.set("query", query);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", "5");
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error("MusicBrainz HTTP " + response.status);
  const data = await response.json() as Record<string, unknown>;
  if (!title) {
    const artists = Array.isArray(data.artists) ? data.artists as Record<string, unknown>[] : [];
    return artists.map(a => {
      const id = String(a.id || "");
      return { provider: "musicbrainz", id, name: String(a.name || ""), title: "", artist: String(a.name || ""),
        year: "", score: Number(a.score || 0), detail: [a.type, a.country, a.disambiguation].filter(Boolean).join(" · "),
        url: "https://musicbrainz.org/artist/" + encodeURIComponent(id) };
    });
  }
  const recordings = Array.isArray(data.recordings) ? data.recordings as Record<string, unknown>[] : [];
  return recordings.map(r => {
    const credits = Array.isArray(r["artist-credit"]) ? r["artist-credit"] as Record<string, unknown>[] : [];
    const creditedArtist = credits.map(c => {
      if (typeof c.name === "string") return c.name;
      const artistCredit = c.artist && typeof c.artist === "object" ? c.artist as Record<string, unknown> : {};
      return String(artistCredit.name || "");
    }).filter(Boolean).join("");
    const id = String(r.id || "");
    const releaseDate = String(r["first-release-date"] || "");
    return { provider: "musicbrainz", id, name: String(r.title || ""), title: String(r.title || ""),
      artist: creditedArtist, year: releaseDate.slice(0, 4), score: Number(r.score || 0), detail: releaseDate,
      url: "https://musicbrainz.org/recording/" + encodeURIComponent(id) };
  });
}
async function searchDiscogs(artist: string, title: string): Promise<Record<string, unknown>[]> {
  const token = Deno.env.get("DISCOGS_TOKEN") || "";
  if (!token) throw new Error("Discogs not configured");
  const url = new URL("https://api.discogs.com/database/search");
  url.searchParams.set("q", [artist, title].filter(Boolean).join(" "));
  url.searchParams.set("type", title ? "release" : "artist");
  url.searchParams.set("per_page", "5");
  const response = await fetch(url, { headers: { Accept: "application/vnd.discogs.v2.discogs+json",
    Authorization: "Discogs token=" + token, "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error("Discogs HTTP " + response.status);
  const data = await response.json() as Record<string, unknown>;
  const results = Array.isArray(data.results) ? data.results as Record<string, unknown>[] : [];
  return results.map(r => ({ provider: "discogs", id: String(r.id || ""), name: String(r.title || ""),
    title: title ? String(r.title || "") : "", artist, year: String(r.year || ""), score: 0,
    detail: [r.country, Array.isArray(r.genre) ? r.genre.join(", ") : "", Array.isArray(r.style) ? r.style.join(", ") : ""].filter(Boolean).join(" · "),
    url: typeof r.uri === "string" && r.uri.startsWith("https://") ? r.uri : "https://www.discogs.com/" }));
}
async function searchCatalog(req: Request, channel: Channel): Promise<Response> {
  const body = await readJson(req);
  if (!body) return json(req, { ok: false, error: "Некорректный запрос." }, 400);
  const artist = str(body.artist, 160);
  const title = str(body.trackTitle, 180);
  const provider: Provider = body.provider === "discogs" ? "discogs" : "musicbrainz";
  if (!artist) return json(req, { ok: false, error: "Укажи исполнителя." }, 400);
  if (provider === "discogs" && !Deno.env.get("DISCOGS_TOKEN")) return json(req, { ok: false, error: "Discogs не настроен. Выбери MusicBrainz." }, 503);
  try {
    await consumeRateLimit(req, "catalog", channel, 20);
    const cacheKey = await sha256(provider + "\u0000" + artist.toLowerCase() + "\u0000" + title.toLowerCase());
    const cached = await db().query("SELECT response FROM public.track_catalog_cache WHERE cache_key = $1 AND expires_at > now() LIMIT 1", [cacheKey]);
    if (cached.rows.length) return json(req, { ok: true, provider, results: cached.rows[0].response });
    if (!await claimCatalogSlot(provider, provider === "musicbrainz" ? 1100 : 1000)) {
      return json(req, { ok: false, error: "Каталог занят другим запросом. Подожди секунду." }, 429);
    }
    const results = provider === "discogs" ? await searchDiscogs(artist, title) : await searchMusicBrainz(artist, title);
    await db().query(
      "INSERT INTO public.track_catalog_cache (cache_key, provider, response, expires_at) VALUES ($1, $2, $3::jsonb, $4) " +
      "ON CONFLICT (cache_key) DO UPDATE SET provider = EXCLUDED.provider, response = EXCLUDED.response, expires_at = EXCLUDED.expires_at",
      [cacheKey, provider, JSON.stringify(results), new Date(Date.now() + 12 * 60 * 60 * 1000)]
    );
    return json(req, { ok: true, provider, results });
  } catch (error) {
    if (error instanceof RateLimitError) return json(req, { ok: false, error: "Слишком много поисков. Подожди 10 минут." }, 429);
    const detail = error instanceof Error ? error.message : String(error);
    console.error("catalog-search:", detail);
    if (detail.includes("TRACK_REQUEST_HASH_SALT")) {
      return json(req, { ok: false, error: "На сервере не настроен TRACK_REQUEST_HASH_SALT. Добавь секрет в Deno Deploy и перезапусти приложение." }, 503);
    }
    if (/relation "track_(requests|request_rate_limits|catalog_cache|catalog_api_state|request_admins)" does not exist|undefined table/i.test(detail)) {
      return json(req, { ok: false, error: "В Neon не хватает таблиц базы заявок. Выполни schema/001_track_orders.sql в правильном проекте Neon." }, 503);
    }
    if (/MusicBrainz HTTP 429/i.test(detail)) {
      return json(req, { ok: false, error: "MusicBrainz временно ограничил частоту запросов. Подожди минуту и попробуй снова." }, 429);
    }
    if (/MusicBrainz HTTP/i.test(detail)) {
      return json(req, { ok: false, error: "MusicBrainz ответил ошибкой. Попробуй позже; заявку всё равно можно отправить." }, 502);
    }
    return json(req, { ok: false, error: "Поиск каталога не завершился. Проверь готовность API на /healthz и попробуй снова." }, 502);
  }
}
async function submitRequest(req: Request, channel: Channel): Promise<Response> {
  const body = await readJson(req);
  if (!body) return json(req, { ok: false, error: "Некорректный запрос." }, 400);
  if (str(body.website, 300)) return json(req, { ok: true, status: "pending" });
  const artist = str(body.artist, 160);
  const title = str(body.trackTitle, 180);
  const clip = validClipUrl(str(body.clipUrl, 1000));
  const started = Number(body.formStartedAt || 0);
  if (!artist) return json(req, { ok: false, error: "Исполнитель обязателен." }, 400);
  if (!clip) return json(req, { ok: false, error: "Нужна прямая HTTPS-ссылка на конкретное видео YouTube или VK." }, 400);
  if (!Number.isFinite(started) || Date.now() - started < 1800 || Date.now() - started > 86400000) {
    return json(req, { ok: false, error: "Форма заполнена слишком быстро. Обнови страницу." }, 400);
  }
  try {
    await consumeRateLimit(req, "submit", channel, 5);
    const catalog = cleanCatalog(body.catalog);
    const result = await db().query(
      "INSERT INTO public.track_requests (channel, artist, track_title, clip_url, clip_provider, catalog_provider, catalog_match, status) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending') RETURNING id, status, created_at",
      [channel, artist, title || null, clip.url, clip.provider, catalog.provider, JSON.stringify(catalog.match)]
    );
    return json(req, { ok: true, request: result.rows[0] }, 201);
  } catch (error) {
    if (error instanceof RateLimitError) return json(req, { ok: false, error: "Слишком много заявок. Подожди 10 минут." }, 429);
    const detail = error instanceof Error ? error.message : String(error);
    console.error("submit-request:", detail);
    if (detail.includes("TRACK_REQUEST_HASH_SALT")) {
      return json(req, { ok: false, error: "На сервере не настроен TRACK_REQUEST_HASH_SALT. Добавь секрет в Deno Deploy и перезапусти приложение." }, 503);
    }
    if (/relation "track_(requests|request_rate_limits|catalog_cache|catalog_api_state|request_admins)" does not exist|undefined table/i.test(detail)) {
      return json(req, { ok: false, error: "В Neon не хватает таблиц базы заявок. Выполни schema/001_track_orders.sql в правильном проекте Neon." }, 503);
    }
    return json(req, { ok: false, error: "Не удалось сохранить заявку. Проверь /healthz и логи Deno Deploy." }, 500);
  }
}
function requestedChannel(req: Request, site: Channel): Channel | "all" | null {
  const value = new URL(req.url).searchParams.get("channel") || site;
  return value === "btv" || value === "rtv" || value === "all" ? value : null;
}
async function listRequests(req: Request, site: Channel): Promise<Response> {
  const target = requestedChannel(req, site);
  if (!target) return json(req, { ok: false, error: "Неверный канал." }, 400);
  if (!await authenticateAdmin(req, target)) return json(req, { ok: false, error: "Нет доступа. Проверь вход и права модератора." }, 403);
  const status = new URL(req.url).searchParams.get("status") || "all";
  if (!["all", "pending", "approved", "rejected"].includes(status)) return json(req, { ok: false, error: "Неверный статус." }, 400);
  const limit = Math.max(1, Math.min(500, Number(new URL(req.url).searchParams.get("limit") || 300)));
  try {
    let query = "SELECT id, channel, artist, track_title, clip_url, clip_provider, catalog_provider, catalog_match, " +
      "status, moderator_note, reviewed_by, reviewed_at, created_at FROM public.track_requests WHERE 1=1";
    const values: unknown[] = [];
    if (target !== "all") { values.push(target); query += " AND channel = $" + values.length; }
    if (status !== "all") { values.push(status); query += " AND status = $" + values.length; }
    values.push(limit);
    query += " ORDER BY created_at DESC LIMIT $" + values.length;
    const result = await db().query(query, values);
    return json(req, { ok: true, requests: result.rows });
  } catch (error) {
    console.error("list-requests:", error instanceof Error ? error.message : String(error));
    return json(req, { ok: false, error: "Не удалось загрузить очередь." }, 500);
  }
}
async function reviewRequest(req: Request, site: Channel, id: string): Promise<Response> {
  const target = requestedChannel(req, site);
  if (!target || target === "all") return json(req, { ok: false, error: "Укажи конкретный канал." }, 400);
  const admin = await authenticateAdmin(req, target);
  if (!admin) return json(req, { ok: false, error: "Нет доступа к этой очереди." }, 403);
  const body = await readJson(req);
  if (!body) return json(req, { ok: false, error: "Некорректный запрос." }, 400);
  const status = body.status === "approved" || body.status === "rejected" ? body.status : null;
  const note = str(body.moderatorNote, 1000);
  if (!status || !/^[0-9a-f-]{36}$/i.test(id)) return json(req, { ok: false, error: "Неверные данные." }, 400);
  try {
    const result = await db().query(
      "UPDATE public.track_requests SET status = $1, moderator_note = $2, reviewed_by = $3, reviewed_at = now() " +
      "WHERE id = $4::uuid AND channel = $5 AND status = 'pending' RETURNING id, channel, status, reviewed_at",
      [status, note || null, admin.authProject + ":" + admin.userId, id, target]
    );
    if (!result.rows.length) return json(req, { ok: false, error: "Заявка не найдена или уже обработана." }, 404);
    return json(req, { ok: true, request: result.rows[0] });
  } catch (error) {
    console.error("review-request:", error instanceof Error ? error.message : String(error));
    return json(req, { ok: false, error: "Не удалось сохранить решение." }, 500);
  }
}

function normalizedFunctionPath(pathname: string): string {
  const marker = "/track-orders-api";
  const index = pathname.indexOf(marker);
  return index >= 0 ? (pathname.slice(index + marker.length) || "/") : pathname;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = normalizedFunctionPath(url.pathname);
  if (path === "/healthz" && req.method === "GET") {
    const saltConfigured = (Deno.env.get("TRACK_REQUEST_HASH_SALT") || "").length >= 24;
    const authConfigured = Boolean(AUTH_URL && AUTH_KEY);
    const channelConfigured = SITE_CHANNEL === "btv" || SITE_CHANNEL === "rtv";
    if (!pool) {
      return json(req, {
        ok: false, service: "track-orders-api", databaseConfigured: false,
        databaseConnected: false, schemaReady: false, rateLimitSaltConfigured: saltConfigured,
        authConfigured, channelConfigured
      }, 503);
    }
    try {
      await pool.query("SELECT 1 AS ok");
      const tableCheck = await pool.query(
        "SELECT " +
        "to_regclass('public.track_requests') IS NOT NULL AS track_requests, " +
        "to_regclass('public.track_request_admins') IS NOT NULL AS track_request_admins, " +
        "to_regclass('public.track_request_rate_limits') IS NOT NULL AS track_request_rate_limits, " +
        "to_regclass('public.track_catalog_cache') IS NOT NULL AS track_catalog_cache, " +
        "to_regclass('public.track_catalog_api_state') IS NOT NULL AS track_catalog_api_state"
      );
      const tables = tableCheck.rows[0] || {};
      const missingTables = Object.entries(tables).filter(([, exists]) => exists !== true).map(([name]) => name);
      const schemaReady = missingTables.length === 0;
      const ready = schemaReady && saltConfigured && authConfigured && channelConfigured;
      return json(req, {
        ok: ready,
        service: "track-orders-api",
        databaseConfigured: true,
        databaseConnected: true,
        schemaReady,
        missingTables,
        rateLimitSaltConfigured: saltConfigured,
        authConfigured,
        channelConfigured,
        channel: channelConfigured ? SITE_CHANNEL : null
      }, ready ? 200 : 503);
    } catch (error) {
      console.error("healthz database check:", error instanceof Error ? error.message : String(error));
      return json(req, {
        ok: false, service: "track-orders-api", databaseConfigured: true,
        databaseConnected: false, schemaReady: false, rateLimitSaltConfigured: saltConfigured,
        authConfigured, channelConfigured
      }, 503);
    }
  }
  if (req.method === "OPTIONS") {
    const originChannel = channelFromOrigin(req);
    return originChannel && originChannel === SITE_CHANNEL
      ? new Response(null, { status: 204, headers: corsHeaders(req) })
      : new Response(null, { status: 403 });
  }
  const channel = channelFromOrigin(req);
  if (!channel || channel !== SITE_CHANNEL) {
    return json(req, { ok: false, error: "Origin is not allowed for this channel." }, 403);
  }
  if (!pool) return json(req, { ok: false, error: "API is not configured." }, 503);
  try {
    if (path === "/api/requests" && req.method === "POST") return await submitRequest(req, channel);
    if (path === "/api/catalog/search" && req.method === "POST") return await searchCatalog(req, channel);
    if (path === "/api/admin/requests" && req.method === "GET") return await listRequests(req, channel);
    const match = path.match(/^\/api\/admin\/requests\/([0-9a-f-]{36})\/review$/i);
    if (match && req.method === "POST") return await reviewRequest(req, channel, match[1]);
    return json(req, { ok: false, error: "Not found." }, 404);
  } catch (error) {
    console.error("request-handler:", error instanceof Error ? error.message : String(error));
    return json(req, { ok: false, error: "Internal server error." }, 500);
  }
});
