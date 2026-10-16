(() => {
  "use strict";
  const cfg = window.TRACK_ORDER_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const loginPanel = $("loginPanel");
  const dashboard = $("dashboard");
  const configWarning = $("configWarning");
  const requestList = $("requestList");
  let authClient = null;
  let currentUser = null;
  let accessToken = "";
  let activeUserId = "";
  let pollTimer = null;
  let loading = false;
  let allRequests = [];

  function configured() {
    return typeof cfg.apiBaseUrl === "string" &&
      cfg.apiBaseUrl.startsWith("https://") &&
      !cfg.apiBaseUrl.includes("YOUR-DENO-APP") &&
      typeof cfg.authSupabaseUrl === "string" &&
      cfg.authSupabaseUrl.startsWith("https://") &&
      typeof cfg.authPublishableKey === "string" &&
      cfg.authPublishableKey.startsWith("sb_publishable_") &&
      !cfg.authPublishableKey.includes("REPLACE_ME");
  }

  function queueMessage(message, kind) {
    const el = $("queueStatus");
    el.textContent = message || "";
    el.className = "tr-status" + (kind ? " " + kind : "");
  }

  function loginError(message) {
    $("loginError").textContent = message || "";
    $("loginError").hidden = !message;
  }

  async function apiRequest(path, options = {}) {
    if (!authClient) throw new Error("Сначала настрой API и авторизацию.");
    if (!accessToken) {
      const sessionResult = await authClient.auth.getSession();
      accessToken = sessionResult.data.session ? sessionResult.data.session.access_token : "";
    }
    if (!accessToken) throw new Error("Сеанс входа истёк. Войди ещё раз.");
    const requestHeaders = new Headers(options.headers || {});
    requestHeaders.set("Authorization", "Bearer " + accessToken);
    requestHeaders.set("Accept", "application/json");
    if (options.body !== undefined) requestHeaders.set("Content-Type", "application/json");
    const url = cfg.apiBaseUrl.replace(/\/+$/, "") + path;
    const response = await fetch(url, { ...options, headers: requestHeaders });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      if (response.status === 401) accessToken = "";
      throw new Error(payload.error || ("API error " + response.status));
    }
    return payload;
  }

  function makeElement(tag, className, value) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (value !== undefined && value !== null) el.textContent = String(value);
    return el;
  }

  function safeExternalUrl(raw) {
    try {
      const url = new URL(String(raw || ""));
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const valid = [
        "youtube.com", "youtu.be", "m.youtube.com", "music.youtube.com",
        "vk.com", "m.vk.com", "vkvideo.ru", "musicbrainz.org", "discogs.com"
      ].includes(host);
      return url.protocol === "https:" && valid ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function statusTitle(status) {
    return ({ pending: "Ожидает", approved: "Одобрена", rejected: "Отклонена" })[status] || String(status || "");
  }

  function renderCard(row) {
    const card = makeElement("article", "tr-request-card status-" + row.status);
    const top = makeElement("div", "tr-request-top");
    const titleGroup = makeElement("div", "tr-request-title");
    titleGroup.appendChild(makeElement("span", "tag", row.channel === "btv" ? "BTV" : "RTV"));
    titleGroup.appendChild(makeElement("h3", "", row.artist || "—"));
    titleGroup.appendChild(makeElement("p", "tr-track-title", row.track_title || "Название трека не указано"));
    top.appendChild(titleGroup);
    card.appendChild(top);
    card.appendChild(makeElement("span", "status-pill status-" + row.status, statusTitle(row.status)));

    const meta = makeElement("div", "tr-meta");
    const created = row.created_at ? new Date(row.created_at).toLocaleString("ru-RU") : "—";
    meta.appendChild(makeElement("span", "", "Отправлена: " + created));
    meta.appendChild(makeElement("span", "", "Источник: " + (row.clip_provider === "youtube" ? "YouTube" : "VK")));
    card.appendChild(meta);

    const clipUrl = safeExternalUrl(row.clip_url);
    if (clipUrl) {
      const links = makeElement("div", "tr-links");
      const clipLink = makeElement("a", "tr-link", "Открыть клип ↗");
      clipLink.href = clipUrl;
      clipLink.target = "_blank";
      clipLink.rel = "noopener noreferrer";
      links.appendChild(clipLink);
      card.appendChild(links);
    }

    const catalog = row.catalog_match && typeof row.catalog_match === "object" ? row.catalog_match : {};
    if (Object.keys(catalog).length) {
      const box = makeElement("div", "tr-catalog");
      box.appendChild(makeElement("strong", "", "Совпадение в каталоге: " + (row.catalog_provider || "не указан")));
      const description = [catalog.artist, catalog.title || catalog.name, catalog.year, catalog.detail].filter(Boolean).join(" · ");
      if (description) box.appendChild(makeElement("p", "", description));
      const catalogUrl = safeExternalUrl(catalog.url);
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

    if (row.moderator_note) card.appendChild(makeElement("p", "tr-note", "Комментарий модератора: " + row.moderator_note));

    if (row.status === "pending") {
      const actions = makeElement("div", "tr-card-actions");
      const approve = makeElement("button", "btn-approve", "▶ Одобрить");
      approve.type = "button";
      approve.addEventListener("click", () => reviewRequest(row, "approved", approve));
      const reject = makeElement("button", "btn-reject", "Отклонить");
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
    const visible = allRequests.filter((row) => {
      if (channel !== "all" && row.channel !== channel) return false;
      if (status !== "all" && row.status !== status) return false;
      const haystack = (row.artist + " " + (row.track_title || "")).toLocaleLowerCase();
      return !query || haystack.includes(query);
    });
    $("countPending").textContent = String(allRequests.filter((r) => r.status === "pending").length);
    $("countApproved").textContent = String(allRequests.filter((r) => r.status === "approved").length);
    $("countRejected").textContent = String(allRequests.filter((r) => r.status === "rejected").length);
    const badge = $("badgeQueue");
    const pend = allRequests.filter((r) => r.status === "pending").length;
    badge.textContent = String(pend);
    badge.classList.toggle("visible", pend > 0);
    requestList.replaceChildren();
    if (!visible.length) {
      requestList.appendChild(makeElement("div", "empty-state", "Заявок в этой выборке нет."));
      return;
    }
    visible.forEach((row) => requestList.appendChild(renderCard(row)));
  }

  async function loadRequests() {
    if (!currentUser || loading) return;
    loading = true;
    queueMessage("Загружаем очередь…", "");
    const channel = $("channelFilter").value || cfg.channel || "btv";
    try {
      const result = await apiRequest("/api/admin/requests?channel=" + encodeURIComponent(channel) + "&status=all&limit=500");
      allRequests = Array.isArray(result.requests) ? result.requests : [];
      render();
      queueMessage("Очередь обновляется автоматически каждые 20 секунд.", "success");
      $("connDot").classList.remove("off"); $("connLabel").textContent = "подключено";
    } catch (error) {
      allRequests = [];
      render();
      queueMessage("Не удалось загрузить очередь: " + error.message, "error");
      $("connDot").classList.add("off"); $("connLabel").textContent = "нет соединения";
    } finally {
      loading = false;
    }
  }

  async function reviewRequest(row, status, button) {
    if (!currentUser) return;
    const prompt = status === "approved" ? "Комментарий модератора (необязательно):" : "Причина отклонения (необязательно):";
    const note = window.prompt(prompt, row.moderator_note || "");
    if (note === null) return;
    button.disabled = true;
    try {
      await apiRequest("/api/admin/requests/" + encodeURIComponent(row.id) + "/review?channel=" + encodeURIComponent(row.channel), {
        method: "POST",
        body: JSON.stringify({ status, moderatorNote: String(note).trim().slice(0, 1000) })
      });
      queueMessage(status === "approved" ? "Заявка одобрена." : "Заявка отклонена.", "success");
      await loadRequests();
    } catch (error) {
      queueMessage("Не удалось сохранить решение: " + error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  async function showSession(session) {
    const nextUser = session && session.user ? session.user : null;
    accessToken = session && session.access_token ? session.access_token : "";
    currentUser = nextUser;
    loginPanel.hidden = Boolean(currentUser);
    dashboard.hidden = !currentUser;
    $("logoutButton").hidden = !currentUser;
    if (!currentUser) {
      activeUserId = "";
      allRequests = [];
      requestList.replaceChildren();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    $("authEmail").textContent = currentUser.email || currentUser.id;
    $("authInfo").textContent = cfg.channelLabel || cfg.channel || "";
    if (!$("channelFilter").dataset.initialized) {
      $("channelFilter").value = cfg.channel === "rtv" ? "rtv" : "btv";
      $("channelFilter").dataset.initialized = "true";
    }
    if (activeUserId === currentUser.id && (loading || pollTimer)) return;
    activeUserId = currentUser.id;
    await loadRequests();
    if (!pollTimer) pollTimer = setInterval(() => { void loadRequests(); }, 20000);
  }

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!authClient) return;
    const button = $("loginButton");
    button.disabled = true;
    loginError("");
    const { data, error } = await authClient.auth.signInWithPassword({
      email: $("loginEmail").value.trim(),
      password: $("loginPassword").value
    });
    button.disabled = false;
    if (error) {
      loginError(error.message === "Invalid login credentials" ? "Неверный email или пароль." : "Ошибка входа: " + error.message);
      return;
    }
    await showSession(data.session);
  });

  $("logoutButton").addEventListener("click", async () => {
    if (authClient) await authClient.auth.signOut();
    await showSession(null);
  });
  $("refreshButton").addEventListener("click", () => { void loadRequests(); });
  ["channelFilter"].forEach((id) => $(id).addEventListener("change", () => { void loadRequests(); }));
  $("searchRequests").addEventListener("input", render);
  document.querySelectorAll("[data-st]").forEach((pill) => pill.addEventListener("click", () => {
    document.querySelectorAll("[data-st]").forEach((p) => p.classList.toggle("active", p === pill));
    $("statusFilter").value = pill.dataset.st;
    render();
  }));
  $("togglePass").addEventListener("click", () => {
    const f = $("loginPassword");
    f.type = f.type === "password" ? "text" : "password";
  });

  if (!configured() || !window.supabase || !window.supabase.createClient) {
    configWarning.hidden = false;
    loginPanel.hidden = false;
    loginError("Не настроен API / Auth: проверь track-order-config.js и доступ к supabase-js.");
    $("loginButton").disabled = true;
  } else {
    authClient = window.supabase.createClient(cfg.authSupabaseUrl, cfg.authPublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    authClient.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => {
        if (session) { void showSession(session); return; }
        /* пустая сессия: повторно проверяем, чтобы не мигать окном входа при переходах */
        setTimeout(() => {
          authClient.auth.getSession().then(({ data }) => { void showSession(data.session); });
        }, 400);
      }, 0);
    });
    authClient.auth.getSession().then(({ data }) => { void showSession(data.session); });
  }
})();
