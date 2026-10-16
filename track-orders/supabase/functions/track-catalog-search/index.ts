import { consumeRateLimit, json, options, originAllowed, serverClient, sha256Hex } from "../_shared/common.ts";

function phrase(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function safeText(value: unknown, max = 180): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function musicBrainz(artist: string, title: string) {
  const entity = title ? "recording" : "artist";
  const query = title
    ? "recording:" + phrase(title) + " AND artist:" + phrase(artist)
    : "artist:" + phrase(artist);
  const url = new URL("https://musicbrainz.org/ws/2/" + entity + "/");
  url.searchParams.set("query", query);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", "5");
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "TrackOrderService/1.0 (https://btvrestored.ru/)"
    },
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) throw new Error("MusicBrainz returned HTTP " + response.status);
  const payload = await response.json();
  if (!title) {
    return (payload.artists || []).map((a: Record<string, unknown>) => ({
      id: String(a.id || ""),
      name: String(a.name || ""),
      title: "",
      artist: String(a.name || ""),
      year: "",
      score: Number(a.score || 0),
      detail: [a.type, a.country, a.disambiguation].filter(Boolean).join(" · "),
      url: "https://musicbrainz.org/artist/" + encodeURIComponent(String(a.id || ""))
    }));
  }
  return (payload.recordings || []).map((r: Record<string, unknown>) => {
    const credits = Array.isArray(r["artist-credit"]) ? r["artist-credit"] as Record<string, unknown>[] : [];
    const creditedArtist = credits.map((c) => String(c.name || (c.artist as Record<string, unknown> | undefined)?.name || "")).filter(Boolean).join("");
    const id = String(r.id || "");
    const date = String(r["first-release-date"] || "");
    return {
      id,
      name: String(r.title || ""),
      title: String(r.title || ""),
      artist: creditedArtist,
      year: date.slice(0, 4),
      score: Number(r.score || 0),
      detail: [date, r.video === true ? "video" : ""].filter(Boolean).join(" · "),
      url: "https://musicbrainz.org/recording/" + encodeURIComponent(id)
    };
  });
}

async function discogs(artist: string, title: string) {
  const token = Deno.env.get("DISCOGS_TOKEN");
  if (!token) throw new Error("Discogs is not configured: DISCOGS_TOKEN is missing.");
  const url = new URL("https://api.discogs.com/database/search");
  url.searchParams.set("q", [artist, title].filter(Boolean).join(" "));
  url.searchParams.set("type", title ? "release" : "artist");
  url.searchParams.set("per_page", "5");
  const response = await fetch(url, {
    headers: {
      "Accept": "application/vnd.discogs.v2.discogs+json",
      "User-Agent": "TrackOrderService/1.0 (https://btvrestored.ru/)",
      "Authorization": "Discogs token=" + token
    },
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) throw new Error("Discogs returned HTTP " + response.status);
  const payload = await response.json();
  return (payload.results || []).map((r: Record<string, unknown>) => ({
    id: String(r.id || ""),
    name: String(r.title || ""),
    title: title ? String(r.title || "") : "",
    artist,
    year: String(r.year || ""),
    score: 0,
    detail: [r.country, Array.isArray(r.genre) ? r.genre.join(", ") : "", Array.isArray(r.style) ? r.style.join(", ") : ""].filter(Boolean).join(" · "),
    url: typeof r.uri === "string" && r.uri.startsWith("https://") ? r.uri : "https://www.discogs.com/"
  }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return options(req);
  if (!originAllowed(req)) return json(req, { ok: false, error: "Origin is not allowed." }, 403);
  if (req.method !== "POST") return json(req, { ok: false, error: "POST required." }, 405);

  try {
    const body = await req.json() as Record<string, unknown>;
    const provider = body.provider === "discogs" ? "discogs" : "musicbrainz";
    const channel = body.channel === "rtv" ? "rtv" : body.channel === "btv" ? "btv" : "";
    const artist = safeText(body.artist, 160);
    const title = safeText(body.trackTitle, 180);
    if (!channel || artist.length < 1) return json(req, { ok: false, error: "Укажите канал и исполнителя." }, 400);
    if (provider === "discogs" && !Deno.env.get("DISCOGS_TOKEN")) {
      return json(req, { ok: false, error: "Discogs пока не настроен. Выберите MusicBrainz." }, 503);
    }

    const db = serverClient();
    const hits = await consumeRateLimit(db, req, "catalog", channel, 20);
    if (hits > 20) return json(req, { ok: false, error: "Слишком много поисков. Подождите 10 минут." }, 429);

    const cacheKey = await sha256Hex(provider + ":" + artist.toLocaleLowerCase() + ":" + title.toLocaleLowerCase());
    const { data: cached, error: cacheReadError } = await db
      .from("track_catalog_cache")
      .select("response, expires_at")
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (cacheReadError) throw new Error("Catalog cache read failed: " + cacheReadError.message);
    if (cached && new Date(cached.expires_at).getTime() > Date.now()) {
      return json(req, { ok: true, provider, results: cached.response });
    }

    const gap = provider === "musicbrainz" ? 1100 : 1000;
    const { data: claimed, error: throttleError } = await db.rpc("track_orders_claim_catalog_slot", {
      p_provider: provider,
      p_min_gap_ms: gap
    });
    if (throttleError) throw new Error("Catalog throttle failed: " + throttleError.message);
    if (claimed !== true) return json(req, { ok: false, error: "Каталог занят другим запросом. Подождите секунду и повторите поиск." }, 429);

    const results = provider === "discogs"
      ? await discogs(artist, title)
      : await musicBrainz(artist, title);

    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const { error: cacheWriteError } = await db.from("track_catalog_cache").upsert({
      cache_key: cacheKey,
      provider,
      response: results,
      expires_at: expiresAt
    });
    if (cacheWriteError) console.warn("Catalog cache write failed:", cacheWriteError.message);
    return json(req, { ok: true, provider, results });
  } catch (error) {
    console.error("track-catalog-search:", error instanceof Error ? error.message : String(error));
    const isSecret = error instanceof Error && error.message.includes("TRACK_REQUEST_HASH_SALT");
    const isDiscogs = error instanceof Error && error.message.includes("DISCOGS_TOKEN");
    return json(req, {
      ok: false,
      error: isSecret
        ? "Сервер ещё не настроен: отсутствует секрет защиты от спама."
        : isDiscogs
          ? "Discogs пока не настроен. Выберите MusicBrainz."
          : "Каталог временно недоступен. Попробуйте позже."
    }, isDiscogs ? 503 : 502);
  }
});
