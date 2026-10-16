(() => {
  "use strict";
  const config = window.TRACK_ORDER_CONFIG || {};
  const form = document.getElementById("trackRequestForm");
  const statusEl = document.getElementById("trackStatus");
  const catalogResults = document.getElementById("catalogResults");
  const catalogStatus = document.getElementById("catalogStatus");
  const submitButton = document.getElementById("submitTrackRequest");
  const searchButton = document.getElementById("searchCatalog");
  const providerSelect = document.getElementById("catalogProvider");
  let selectedCatalog = null;
  let lang = "ru";

  const translations = {
    ru: {
      nav_shows: "Программы", nav_repeats: "Повторы", nav_identity: "Архив", nav_about: "О телеканале", nav_order: "Заказать клип",
      title: "Предложить трек для эфира",
      intro: "Предложи музыку для ротации канала. Каждая заявка проходит ручную модерацию — отправка не гарантирует попадание в эфир.",
      artistLabel: "Исполнитель *", artistHint: "Укажи артиста или группу точно, как в релизе.", artistPlaceholder: "Например, имя артиста или группы",
      trackLabel: "Название трека (необязательно)", trackPlaceholder: "Название трека / ремикса / версии",
      clipLabel: "Ссылка на клип YouTube или VK *", clipPlaceholder: "https://youtu.be/... или https://vk.com/video...",
      clipHint: "Нужна прямая ссылка на конкретное видео, не на канал, плейлист или поиск.",
      catalogLabel: "Проверка музыкального каталога", catalogHint: "Это помогает сверить исполнителя и релиз, но не заменяет прослушивание модератором.",
      providerLabel: "Каталог", catalogSearch: "Найти совпадения", catalogSearchBusy: "Ищем…", selectMatch: "Выбрать",
      noResults: "Совпадений не найдено. Проверь написание — заявку всё равно рассмотрит модератор.",
      selected: "Выбран результат каталога. Модератор увидит его вместе с заявкой.",
      rulesTitle: "Перед отправкой", rule1: "Указывай реального исполнителя и проверяемую ссылку на клип.", rule2: "Не отправляй мемы, спам, случайные перезаливы или контент, не подходящий музыкальному формату канала.", rule3: "Даже совпадение в базе не гарантирует одобрения.",
      submit: "Отправить на модерацию", submitBusy: "Отправляем…",
      privacy: "Контактные данные не запрашиваются. Заявка попадёт в закрытую очередь модерации.",
      footer: "Проект независим и не связан с BRIDGE MEDIA.",
      errArtist: "Укажи исполнителя.", errClip: "Вставь ссылку на конкретный клип YouTube или VK.", errConfig: "Форма ещё не подключена к Supabase. Настройте track-order-config.js.",
      searchNeedArtist: "Сначала укажи исполнителя.", searchError: "Не удалось выполнить поиск. Попробуй позже.",
      success: "Заявка отправлена и ждёт модерации. Спасибо!", genericError: "Не удалось отправить заявку. Попробуй позже."
    },
    en: {
      nav_shows: "Shows", nav_repeats: "Repeats", nav_identity: "Archive", nav_about: "About", nav_order: "Order clip",
      title: "Suggest a track for broadcast",
      intro: "Suggest music for the channel rotation. Every request is reviewed manually; submitting one does not guarantee airtime.",
      artistLabel: "Artist *", artistHint: "Enter the artist or group exactly as credited on the release.", artistPlaceholder: "Artist or group name",
      trackLabel: "Track title (optional)", trackPlaceholder: "Track / remix / version title",
      clipLabel: "YouTube or VK video link *", clipPlaceholder: "https://youtu.be/... or https://vk.com/video...",
      clipHint: "Use a direct link to a specific video, not a channel, playlist, or search page.",
      catalogLabel: "Music-catalogue check", catalogHint: "This helps verify artist and release metadata; it does not replace moderator listening/review.",
      providerLabel: "Catalogue", catalogSearch: "Search catalogue", catalogSearchBusy: "Searching…", selectMatch: "Select",
      noResults: "No matches found. Check the spelling; a moderator can still review the request.",
      selected: "Catalogue match selected. The moderator will see it with your request.",
      rulesTitle: "Before submitting", rule1: "Use a real artist name and a verifiable video link.", rule2: "Do not submit memes, spam, random re-uploads, or content outside the channel's music format.", rule3: "A catalogue match does not guarantee approval.",
      submit: "Send for moderation", submitBusy: "Submitting…",
      privacy: "No contact details are requested. Your submission goes to a private moderation queue.",
      footer: "This independent project is not affiliated with BRIDGE MEDIA.",
      errArtist: "Please enter an artist.", errClip: "Enter a direct YouTube or VK video link.", errConfig: "The form is not connected to Supabase yet. Configure track-order-config.js.",
      searchNeedArtist: "Enter an artist first.", searchError: "Catalogue search failed. Try again later.",
      success: "Request submitted and awaiting moderation. Thank you!", genericError: "Could not submit the request. Try again later."
    }
  };

  function tr(key) {
    return (translations[lang] && translations[lang][key]) || translations.ru[key] || key;
  }

  function setLang(next) {
    lang = next === "en" ? "en" : "ru";
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (tr(key)) el.textContent = tr(key);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const key = el.getAttribute("data-i18n-placeholder");
      el.placeholder = tr(key);
    });
    document.querySelectorAll(".lang-btn").forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-lang") === lang);
    });
    try { localStorage.setItem("lang", lang); } catch (_) {}
  }
  window.setLang = setLang;

  function showStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = "track-status" + (kind ? " " + kind : "");
  }

  function configured() {
    return typeof config.apiBaseUrl === "string" &&
      config.apiBaseUrl.startsWith("https://") &&
      !config.apiBaseUrl.includes("YOUR-DENO-APP");
  }

  function validClipUrl(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== "https:") return false;
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
        if (host === "youtu.be") return u.pathname.length > 1;
        return (u.pathname === "/watch" && Boolean(u.searchParams.get("v"))) ||
          /^\/(shorts|embed|live)\/[^/]+/.test(u.pathname);
      }
      if (["vk.com", "m.vk.com", "vkvideo.ru"].includes(host)) {
        return /^\/(video|clip|video_ext\.php)(\/|$)/.test(u.pathname);
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  async function callFunction(name, payload) {
    const root = config.apiBaseUrl.replace(/\/+$/, "");
    const routes = {
      "track-catalog-search": "/api/catalog/search",
      "track-request-submit": "/api/requests"
    };
    const route = routes[name];
    if (!route) throw new Error("Unknown API route.");
    const response = await fetch(root + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || tr("genericError"));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function clearCatalogResults() {
    catalogResults.replaceChildren();
  }

  function renderCatalogResults(data) {
    clearCatalogResults();
    const items = Array.isArray(data.results) ? data.results : [];
    if (!items.length) {
      catalogStatus.textContent = tr("noResults");
      return;
    }
    catalogStatus.textContent = "";
    items.forEach((item) => {
      const card = document.createElement("article");
      card.className = "catalog-result";
      const title = document.createElement("strong");
      title.textContent = item.title || item.name || "—";
      card.appendChild(title);

      const meta = document.createElement("p");
      const bits = [];
      if (item.artist && item.title) bits.push(item.artist);
      if (item.year) bits.push(String(item.year));
      if (item.score) bits.push("match " + item.score + "%");
      if (item.detail) bits.push(item.detail);
      meta.textContent = bits.join(" · ");
      card.appendChild(meta);

      if (typeof item.url === "string") {
        try {
          const u = new URL(item.url);
          if (u.protocol === "https:" && ["musicbrainz.org", "www.musicbrainz.org", "discogs.com", "www.discogs.com"].includes(u.hostname)) {
            const link = document.createElement("a");
            link.href = u.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = data.provider === "discogs" ? "Discogs" : "MusicBrainz";
            card.appendChild(link);
          }
        } catch (_) {}
      }

      const choose = document.createElement("button");
      choose.type = "button";
      choose.className = "btn small secondary";
      choose.textContent = tr("selectMatch");
      choose.addEventListener("click", () => {
        selectedCatalog = {
          provider: data.provider,
          id: String(item.id || ""),
          name: String(item.name || ""),
          title: String(item.title || ""),
          artist: String(item.artist || ""),
          year: String(item.year || ""),
          score: String(item.score || ""),
          detail: String(item.detail || ""),
          url: String(item.url || "")
        };
        if (!document.getElementById("artistName").value.trim() && item.artist) {
          document.getElementById("artistName").value = item.artist;
        }
        if (!document.getElementById("trackTitle").value.trim() && item.title) {
          document.getElementById("trackTitle").value = item.title;
        }
        catalogStatus.textContent = tr("selected");
        catalogStatus.className = "catalog-status success";
        document.querySelectorAll(".catalog-result").forEach((el) => el.classList.remove("selected"));
        card.classList.add("selected");
      });
      card.appendChild(choose);
      catalogResults.appendChild(card);
    });
  }

  searchButton.addEventListener("click", async () => {
    if (!configured()) {
      catalogStatus.textContent = tr("errConfig");
      catalogStatus.className = "catalog-status error";
      return;
    }
    const artist = document.getElementById("artistName").value.trim();
    if (!artist) {
      catalogStatus.textContent = tr("searchNeedArtist");
      catalogStatus.className = "catalog-status error";
      return;
    }
    searchButton.disabled = true;
    searchButton.textContent = tr("catalogSearchBusy");
    catalogStatus.textContent = "";
    selectedCatalog = null;
    clearCatalogResults();
    try {
      const result = await callFunction("track-catalog-search", {
        channel: config.channel,
        provider: providerSelect.value,
        artist,
        trackTitle: document.getElementById("trackTitle").value.trim()
      });
      renderCatalogResults(result);
    } catch (error) {
      catalogStatus.textContent = error.message || tr("searchError");
      catalogStatus.className = "catalog-status error";
    } finally {
      searchButton.disabled = false;
      searchButton.textContent = tr("catalogSearch");
    }
  });

  form.addEventListener("input", (event) => {
    if (event.target && ["artistName", "trackTitle"].includes(event.target.id)) {
      selectedCatalog = null;
      if (catalogStatus.classList.contains("success")) {
        catalogStatus.textContent = "";
        catalogStatus.className = "catalog-status";
        document.querySelectorAll(".catalog-result").forEach((el) => el.classList.remove("selected"));
      }
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const artist = document.getElementById("artistName").value.trim();
    const trackTitle = document.getElementById("trackTitle").value.trim();
    const clipUrl = document.getElementById("clipUrl").value.trim();
    if (!artist) {
      showStatus(tr("errArtist"), "error");
      document.getElementById("artistName").focus();
      return;
    }
    if (!validClipUrl(clipUrl)) {
      showStatus(tr("errClip"), "error");
      document.getElementById("clipUrl").focus();
      return;
    }
    if (!configured()) {
      showStatus(tr("errConfig"), "error");
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = tr("submitBusy");
    showStatus("", "");
    try {
      const payload = {
        channel: config.channel,
        artist,
        trackTitle,
        clipUrl,
        formStartedAt: document.getElementById("formStartedAt").value,
        website: document.getElementById("website").value,
        catalog: selectedCatalog
      };
      await callFunction("track-request-submit", payload);
      form.reset();
      document.getElementById("formStartedAt").value = String(Date.now());
      selectedCatalog = null;
      clearCatalogResults();
      catalogStatus.textContent = "";
      showStatus(tr("success"), "success");
    } catch (error) {
      showStatus(error.message || tr("genericError"), "error");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = tr("submit");
    }
  });

  document.querySelectorAll(".lang-btn").forEach((el) => {
    el.addEventListener("click", () => setLang(el.getAttribute("data-lang")));
  });
  document.getElementById("formStartedAt").value = String(Date.now());
  try { lang = localStorage.getItem("lang") === "en" ? "en" : "ru"; } catch (_) { lang = "ru"; }
  setLang(lang);
  if (!configured()) {
    showStatus(tr("errConfig"), "warning");
    submitButton.disabled = true;
    searchButton.disabled = true;
  }
})();
