(() => {
  "use strict";
  const cfg = window.TRACK_ORDER_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const loginPanel = $("loginPanel");
  const dashboard = $("dashboard");
  const configWarning = $("configWarning");
  const requestList = $("requestList");
  let db = null;
  let currentUser = null;
  let realtimeChannel = null;
  let allRequests = [];

  function isConfigured() {
    return cfg.supabaseUrl && cfg.supabaseUrl.startsWith("https://") &&
      !cfg.supabaseUrl.includes("YOUR-TRACK-ORDERS") &&
      cfg.publishableKey && cfg.publishableKey.startsWith("sb_publishable_") &&
      !cfg.publishableKey.includes("REPLACE_ME");
  }

  function setQueueMessage(message, kind) {
    const el = $("queueStatus");
    el.textContent = message || "";
    el.className = "tr-alert" + (kind ? " " + kind : "");
  }

  function setLoginError(message) {
    const el = $("loginError");
    el.textContent = message || "";
    el.hidden = !message;
  }

  function escapeChannel(channel) {
    return channel === "btv" ? "BTV" : channel === "rtv" ? "RTV" : String(channel || "").toUpperCase();
  }

  function safeUrl(raw) {
    try {
      const u = new URL(String(raw || ""));
      const host = u.hostname.toLowerCase();
      const validHost = host === "youtube.com" || host === "www.youtube.com" ||
        host === "youtu.be" || host === "m.youtube.com" || host === "music.youtube.com" ||
        host === "vk.com" || host === "m.vk.com" || host === "vkvideo.ru" ||
        host === "musicbrainz.org" || host === "www.musicbrainz.org" ||
        host === "discogs.com" || host === "www.discogs.com";
      return u.protocol === "https:" && validHost ? u.href : "";
    } catch (_) {
      return "";
    }
  }

  function makeElement(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function renderCard(row) {
    const card = makeElement("article", "tr-request-card status-" + row.status);
    const top = makeElement("div", "tr-request-top");
    const titleGroup = makeElement("div", "tr-request-title");
    titleGroup.appendChild(makeElement("span", "tr-channel", escapeChannel(row.channel)));
    titleGroup.appendChild(makeElement("h3", "", row.artist || "—"));
    titleGroup.appendChild(makeElement("p", "tr-track-title", row.track_title || "Название трека не указано"));
    top.appendChild(titleGroup);
    const statusNames = { pending: "Ожидает", approved: "Одобрена", rejected: "Отклонена" };
    top.appendChild(makeElement("span", "tr-status-badge " + row.status, statusNames[row.status] || row.status));
    card.appendChild(top);

    const meta = makeElement("div", "tr-meta");
    meta.appendChild(makeElement("span", "", "Отправлена: " + new Date(row.created_at).toLocaleString("ru-RU")));
    meta.appendChild(makeElement("span", "", "Источник: " + (row.clip_provider === "youtube" ? "YouTube" : "VK")));
    card.appendChild(meta);

    const clip = safeUrl(row.clip_url);
    if (clip) {
      const links = makeElement("div", "tr-links");
      const video = makeElement("a", "tr-link", "Открыть клип ↗");
      video.href = clip;
      video.target = "_blank";
      video.rel = "noopener noreferrer";
      links.appendChild(video);
      card.appendChild(links);
    }

    const catalog = row.catalog_match && typeof row.catalog_match === "object" ? row.catalog_match : {};
    if (Object.keys(catalog).length) {
      const box = makeElement("div", "tr-catalog");
      box.appendChild(makeElement("strong", "", "Совпадение в каталоге: " + (row.catalog_provider || "не указан")));
      const parts = [catalog.artist, catalog.title || catalog.name, catalog.year, catalog.detail].filter(Boolean);
      if (parts.length) box.appendChild(makeElement("p", "", parts.join(" · ")));
      const catalogUrl = safeUrl(catalog.url);
      if (catalogUrl) {
        const link = makeElement("a", "tr-link", "Проверить источник ↗");
        link.href = catalogUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        box.appendChild(link);
      }
      card.appendChild(box);
    } else {
      card.appendChild(makeElement("p", "tr-muted", "Совпадение в каталоге не выбрано."));
    }

    if (row.moderator_note) {
      card.appendChild(makeElement("p", "tr-note", "Комментарий модератора: " + row.moderator_note));
    }

    if (row.status === "pending") {
      const actions = makeElement("div", "tr-card-actions");
      const approve = makeElement("button", "tr-button primary", "Одобрить");
      approve.type = "button";
      approve.addEventListener("click", () => reviewRequest(row, "approved", approve));
      const reject = makeElement("button", "tr-button danger", "Отклонить");
      reject.type = "button";
      reject.addEventListener("click", () => reviewRequest(row, "rejected", reject));
      actions.append(approve, reject);
      card.appendChild(actions);
    }
    return card;
  }

  function render() {
    const channel = $("channelFilter").value;
    const status = $("statusFilter").value;
    const query = $("searchRequests").value.trim().toLocaleLowerCase();
    const visible = allRequests.filter((r) => {
      if (channel !== "all" && r.channel !== channel) return false;
      if (status !== "all" && r.status !== status) return false;
      const hay = (r.artist + " " + (r.track_title || "")).toLocaleLowerCase();
      return !query || hay.includes(query);
    });
    $("countPending").textContent = allRequests.filter((r) => r.status === "pending").length;
    $("countApproved").textContent = allRequests.filter((r) => r.status === "approved").length;
    $("countRejected").textContent = allRequests.filter((r) => r.status === "rejected").length;
    requestList.replaceChildren();
    if (!visible.length) {
      requestList.appendChild(makeElement("div", "tr-empty", "Заявок в этой выборке нет."));
      return;
    }
    visible.forEach((row) => requestList.appendChild(renderCard(row)));
  }

  async function loadRequests() {
    if (!db) return;
    setQueueMessage("Загружаем очередь…", "");
    const { data, error } = await db.from("track_requests")
      .select("id,channel,artist,track_title,clip_url,clip_provider,catalog_provider,catalog_match,status,moderator_note,reviewed_by,reviewed_at,created_at")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      console.error(error);
      allRequests = [];
      render();
      setQueueMessage("Не удалось прочитать очередь. Проверь UID в track_request_admins и политики RLS. " + error.message, "error");
      return;
    }
    allRequests = data || [];
    render();
    setQueueMessage(allRequests.length ? "Подключено. Обновления приходят в реальном времени." : "Подключено, но заявок пока нет или у этого аккаунта нет доступа к назначенному каналу.", "");
  }

  async function reviewRequest(row, status, button) {
    if (!currentUser) return;
    const note = window.prompt(status === "approved" ? "Комментарий модератора (необязательно):" : "Причина отклонения (необязательно):", row.moderator_note || "");
    if (note === null) return;
    button.disabled = true;
    const update = {
      status,
      moderator_note: String(note).trim().slice(0, 1000) || null,
      reviewed_by: currentUser.id,
      reviewed_at: new Date().toISOString()
    };
    const { error } = await db.from("track_requests").update(update).eq("id", row.id);
    button.disabled = false;
    if (error) {
      console.error(error);
      setQueueMessage("Не удалось сохранить решение: " + error.message, "error");
      return;
    }
    setQueueMessage(status === "approved" ? "Заявка одобрена." : "Заявка отклонена.", "success");
    await loadRequests();
  }

  async function showSession(session) {
    currentUser = session && session.user ? session.user : null;
    loginPanel.hidden = Boolean(currentUser);
    dashboard.hidden = !currentUser;
    $("logoutButton").hidden = !currentUser;
    if (!currentUser) {
      if (realtimeChannel && db) db.removeChannel(realtimeChannel);
      realtimeChannel = null;
      allRequests = [];
      requestList.replaceChildren();
      return;
    }
    $("authInfo").textContent = "Вошли как " + (currentUser.email || currentUser.id) + " · проект " + (cfg.channelLabel || cfg.channel || "");
    $("channelFilter").value = cfg.channel === "rtv" ? "rtv" : "btv";
    await loadRequests();
    if (realtimeChannel) db.removeChannel(realtimeChannel);
    realtimeChannel = db.channel("track-orders-admin-" + cfg.channel)
      .on("postgres_changes", { event: "*", schema: "public", table: "track_requests" }, () => loadRequests())
      .subscribe();
  }

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!db) return;
    const button = $("loginButton");
    button.disabled = true;
    setLoginError("");
    const { data, error } = await db.auth.signInWithPassword({
      email: $("loginEmail").value.trim(),
      password: $("loginPassword").value
    });
    button.disabled = false;
    if (error) {
      setLoginError(error.message === "Invalid login credentials" ? "Неверный email или пароль." : "Ошибка входа: " + error.message);
      return;
    }
    await showSession(data.session);
  });

  $("logoutButton").addEventListener("click", async () => {
    if (db) await db.auth.signOut();
    await showSession(null);
  });
  $("refreshButton").addEventListener("click", loadRequests);
  ["channelFilter", "statusFilter"].forEach((id) => $(id).addEventListener("change", render));
  $("searchRequests").addEventListener("input", render);

  if (!isConfigured() || !window.supabase || !window.supabase.createClient) {
    configWarning.hidden = false;
    $("loginButton").disabled = true;
  } else {
    db = window.supabase.createClient(cfg.supabaseUrl, cfg.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    db.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => showSession(session), 0);
    });
    db.auth.getSession().then(({ data }) => showSession(data.session));
  }
})();
