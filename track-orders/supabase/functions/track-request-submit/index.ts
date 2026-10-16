import { consumeRateLimit, clipProvider, cleanCatalog, json, options, originAllowed, channelMatchesOrigin, serverClient } from "../_shared/common.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return options(req);
  if (!originAllowed(req)) return json(req, { ok: false, error: "Origin is not allowed." }, 403);
  if (req.method !== "POST") return json(req, { ok: false, error: "POST required." }, 405);

  try {
    const body = await req.json() as Record<string, unknown>;
    const channel = body.channel === "btv" || body.channel === "rtv" ? String(body.channel) : "";
    const artist = typeof body.artist === "string" ? body.artist.trim() : "";
    const trackTitle = typeof body.trackTitle === "string" ? body.trackTitle.trim() : "";
    const clipUrl = typeof body.clipUrl === "string" ? body.clipUrl.trim() : "";
    const honeypot = typeof body.website === "string" ? body.website.trim() : "";
    const startedAt = Number(body.formStartedAt || 0);

    if (honeypot) return json(req, { ok: true, status: "pending" });
    if (!channel) return json(req, { ok: false, error: "Не указан канал." }, 400);
    if (!channelMatchesOrigin(req, channel)) return json(req, { ok: false, error: "Этот сайт не может отправить заявку в очередь другого канала." }, 403);
    if (artist.length < 1 || artist.length > 160) {
      return json(req, { ok: false, error: "Исполнитель обязателен (до 160 символов)." }, 400);
    }
    if (trackTitle.length > 180) return json(req, { ok: false, error: "Название трека должно быть не длиннее 180 символов." }, 400);
    const provider = clipProvider(clipUrl);
    if (!provider) return json(req, { ok: false, error: "Нужна прямая HTTPS-ссылка на видео YouTube или VK." }, 400);
    if (!Number.isFinite(startedAt) || Date.now() - startedAt < 2200 || Date.now() - startedAt > 24 * 60 * 60 * 1000) {
      return json(req, { ok: false, error: "Форма заполнена слишком быстро. Обновите страницу и попробуйте снова." }, 400);
    }

    const db = serverClient();
    const hits = await consumeRateLimit(db, req, "submit", channel, 5);
    if (hits > 5) return json(req, { ok: false, error: "Слишком много заявок. Подождите 10 минут и попробуйте снова." }, 429);

    const catalog = cleanCatalog(body.catalog);
    const row = {
      channel,
      artist,
      track_title: trackTitle || null,
      clip_url: clipUrl,
      clip_provider: provider,
      catalog_provider: catalog.provider,
      catalog_match: catalog.data,
      status: "pending"
    };
    const { data, error } = await db.from("track_requests").insert(row).select("id").single();
    if (error) {
      console.error("track-request-submit insert:", error.message);
      return json(req, { ok: false, error: "Не удалось сохранить заявку. Попробуйте позже." }, 500);
    }
    return json(req, { ok: true, id: data.id, status: "pending" }, 201);
  } catch (error) {
    console.error("track-request-submit:", error instanceof Error ? error.message : String(error));
    const message = error instanceof Error && error.message.includes("TRACK_REQUEST_HASH_SALT")
      ? "Сервер ещё не настроен: отсутствует секрет защиты от спама."
      : "Внутренняя ошибка. Попробуйте позже.";
    return json(req, { ok: false, error: message }, 500);
  }
});
