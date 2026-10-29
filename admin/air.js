/* Эфир + Консоль: управление виджетом «Сейчас в эфире» из админки (Supabase live_state / episodes). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var toast = function (m) { if (window.showToast) window.showToast(m); };

  var ep = { title: '', tracks: [], duration: null };   // редактируемый эпизод
  var live = {};                                          // текущее live_state.data
  var library = [];                                       // сохранённые эпизоды
  var loadedId = null;

  function T(sec) { return window.ProjectParse.tcToStr(sec); }

  /* ───────── разметка ───────── */
  function mount() {
    $('page-air').innerHTML =
      '<div><div class="page-title">Эфир</div><div class="page-subtitle">Треклист для виджета «Сейчас в эфире» — обновляется на сайте без GitHub</div></div>' +
      '<div class="card"><div class="card-header">Сейчас</div><div class="card-body"><div id="airStatus" class="air-status">Загрузка…</div>' +
      '<div class="air-row"><button class="air-btn" id="airIdle">Заставка «ожидание»</button><button class="air-btn danger" id="airStop">Выключить виджет</button></div></div></div>' +
      '<div class="card"><div class="card-header">Эпизод</div><div class="card-body">' +
      '<div class="air-grid">' +
      '<label>Название<input id="epTitle" placeholder="Например: Выпуск 12"></label>' +
      '<label>Файл проекта<input id="epFile" type="file" accept=".edl,.xml,.fcpxml,.otio,.txt,.drp,.drt,.aaf,.json"></label>' +
      '<label>FPS (для EDL/TXT)<input id="epFps" type="number" step="0.001" value="25"></label>' +
      '<label>Начало таймлайна<input id="epStart" value="01:00:00:00"></label>' +
      '<label>Мин. длина трека, с<input id="epMin" type="number" value="30"></label>' +
      '<label>Длительность (чч:мм:сс)<input id="epDur" placeholder="авто"></label>' +
      '<label class="wide">Правила клипов (JSON, необязательно)<input id="epRules" placeholder=\'[["заставк|ident","promo"],["tech","skip"]]\'></label>' +
      '</div><div id="epMsg" class="air-msg"></div>' +
      '<div class="air-row"><button class="air-btn" id="epAdd">+ Строка</button><button class="air-btn" id="epSave">Сохранить в библиотеку</button><button class="air-btn" id="epExport">Скачать JSON</button><label class="air-btn" for="epImport">Загрузить JSON</label><input id="epImport" type="file" accept=".json" hidden></div>' +
      '<div class="air-tablewrap"><table class="air-table"><thead><tr><th>Время</th><th>Тип</th><th>Исполнитель / текст</th><th>Название</th><th></th></tr></thead><tbody id="epRows"></tbody></table></div>' +
      '</div></div>' +
      '<div class="card"><div class="card-header">В эфир</div><div class="card-body">' +
      '<div class="air-grid">' +
      '<label>Смещение, с (с какой секунды таймлайна эфир)<input id="gOffset" type="number" value="0"></label>' +
      '<label>Старт<select id="gWhen"><option value="now">Сейчас</option><option value="at">В заданное время</option></select></label>' +
      '<label id="gAtWrap" style="display:none">Время старта<input id="gAt" type="datetime-local"></label>' +
      '</div><div class="air-row"><button class="air-btn primary" id="gGo">Выйти в эфир</button></div></div></div>' +
      '<div class="card"><div class="card-header">Библиотека</div><div class="card-body"><div id="libList" class="air-lib">Пусто</div></div></div>';

    $('page-console').innerHTML =
      '<div><div class="page-title">Консоль</div><div class="page-subtitle">Команды управления эфиром. Введите <b>help</b></div></div>' +
      '<div class="card"><div class="card-body"><div id="conOut" class="con-out" tabindex="0"></div>' +
      '<form id="conForm" class="con-form" autocomplete="off"><span class="con-prompt">&gt;</span><input id="conIn" spellcheck="false" autocapitalize="off" placeholder="status, golive 1, stop, idle…"></form></div></div>';
  }

  /* ───────── таблица ───────── */
  var KIND_OPTS = [['', 'Трек'], ['wait', 'Ожидание'], ['ad', 'Реклама'], ['promo', 'Заставка'], ['tech', 'Неполадки'], ['show', 'Заставка программы']];
  var ROLES = [['start', 'Начало'], ['transition', 'Переход'], ['to_ad', 'Уход на рекламу'], ['back', 'Возврат с рекламы'], ['end', 'Конец'], ['part1', 'Часть 1'], ['part2', 'Часть 2'], ['part3', 'Часть 3']];
  function renderRows() {
    $('epTitle').value = ep.title || '';
    $('epRows').innerHTML = ep.tracks.map(function (t, i) {
      var sel = KIND_OPTS.map(function (o) { return '<option value="' + o[0] + '"' + ((t.kind || '') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('');
      return '<tr data-i="' + i + '"><td><input class="f-t" value="' + T(t.t) + '" size="8"></td><td><select class="f-k">' + sel + '</select></td>' +
        (t.kind === 'show' ? '<td><input class="f-show" value="' + esc(t.show) + '" placeholder="Название программы"></td><td><select class="f-role">' +
          ROLES.map(function (o) { return '<option value="' + o[0] + '"' + (t.role === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></td>' :
          t.kind ? '<td colspan="2"><input class="f-text" value="' + esc(t.text || '') + '" placeholder="текст (необязательно — будет шутка)"></td>'
          : '<td><input class="f-a" value="' + esc(t.artist) + '"></td><td><input class="f-n" value="' + esc(t.title) + '"></td>') +
        '<td class="air-act"><button data-a="up">↑</button><button data-a="dn">↓</button><button data-a="del">✕</button></td></tr>';
    }).join('') || '<tr><td colspan="5" class="air-empty">Загрузите файл проекта или добавьте строки вручную</td></tr>';
  }
  function readRows() {
    var rows = [];
    document.querySelectorAll('#epRows tr[data-i]').forEach(function (tr) {
      var k = tr.querySelector('.f-k').value, t;
      try { t = window.ProjectParse.tcToSec(tr.querySelector('.f-t').value, 25); } catch (e) { throw new Error('Неверное время в строке ' + (Number(tr.dataset.i) + 1)); }
      if (k === 'show') rows.push({ t: t, kind: 'show', show: ((tr.querySelector('.f-show') || {}).value || '').trim(), role: (tr.querySelector('.f-role') || {}).value || 'start' });
      else if (k) rows.push({ t: t, kind: k, text: (tr.querySelector('.f-text') || { value: '' }).value.trim() });
      else rows.push({ t: t, artist: tr.querySelector('.f-a').value.trim(), title: tr.querySelector('.f-n').value.trim() });
    });
    rows.sort(function (a, b) { return a.t - b.t; });
    return rows;
  }
  function sync() { ep.title = $('epTitle').value.trim(); ep.tracks = readRows(); }
  function msg(text, bad) { var m = $('epMsg'); m.textContent = text || ''; m.className = 'air-msg' + (bad ? ' bad' : ''); }

  /* ───────── Supabase ───────── */
  function db() { return sb; }
  function loadLive() {
    return db().from('live_state').select('data,updated_at').eq('id', 1).single().then(function (r) {
      if (r.error) { $('airStatus').innerHTML = '<span class="bad">Таблица live_state не найдена — выполните admin/supabase-live.sql в Supabase</span>'; live = {}; return; }
      live = r.data.data || {}; renderStatus();
    });
  }
  function statusText() {
    if (live.idle) return 'Заставка «ожидание эфира»';
    if (live.start && live.tracks) {
      var el = (Date.now() - new Date(live.start).getTime()) / 1000 - (live.offset || 0);
      var name = live.title ? '«' + live.title + '» · ' : '';
      if (el < 0) return name + 'старт через ' + T(-el);
      if (live.end != null && el > live.end) return name + 'эфир закончился → виджет показывает ожидание';
      var idx = -1; live.tracks.forEach(function (t, i) { if (t.t <= el) idx = i; });
      var cur = live.tracks[idx];
      return name + 'идёт ' + T(Math.max(el, 0)) + (cur ? ' · ' + (cur.kind ? '[' + cur.kind + '] ' + (cur.show || cur.text || '') : (cur.artist ? cur.artist + ' — ' : '') + cur.title) : '');
    }
    return 'Не задано (виджет берёт tracklist.json из репозитория)';
  }
  function renderStatus() { $('airStatus').textContent = statusText(); }
  function setLive(data) {
    return db().from('live_state').update({ data: data, updated_at: new Date().toISOString() }).eq('id', 1).select().then(function (r) {
      if (r.error) throw new Error(r.error.message);
      if (!r.data || !r.data.length) throw new Error('Нет прав на запись (вы не в таблице admins?)');
      live = data; renderStatus();
    });
  }
  function loadLibrary() {
    return db().from('episodes').select('id,title,data,updated_at').order('updated_at', { ascending: false }).then(function (r) {
      if (r.error) { $('libList').textContent = 'Нет таблицы episodes — выполните admin/supabase-live.sql'; library = []; return; }
      library = r.data || []; renderLibrary();
    });
  }
  function renderLibrary() {
    $('libList').innerHTML = library.length ? library.map(function (e, i) {
      var n = (e.data.tracks || []).length;
      return '<div class="air-libitem"><div><b>' + (i + 1) + '. ' + esc(e.title) + '</b><span>' + n + ' поз.' + (e.data.duration ? ' · ' + T(e.data.duration) : '') + '</span></div>' +
        '<div><button data-l="open" data-id="' + e.id + '">Открыть</button><button data-l="del" data-id="' + e.id + '">Удалить</button></div></div>';
    }).join('') : 'Пусто';
  }
  function saveEpisode() {
    sync();
    if (!ep.title) throw new Error('Введите название эпизода');
    if (!ep.tracks.length) throw new Error('В эпизоде нет строк');
    var data = { title: ep.title, tracks: ep.tracks }; if (ep.duration) data.duration = ep.duration;
    var q = loadedId ? db().from('episodes').update({ title: ep.title, data: data, updated_at: new Date().toISOString() }).eq('id', loadedId).select()
      : db().from('episodes').insert({ title: ep.title, data: data }).select();
    return q.then(function (r) { if (r.error) throw new Error(r.error.message); if (r.data && r.data[0]) loadedId = r.data[0].id; return loadLibrary(); });
  }
  function openEpisode(e) { loadedId = e.id; ep = { title: e.title, tracks: JSON.parse(JSON.stringify(e.data.tracks || [])), duration: e.data.duration || null }; $('epDur').value = ep.duration ? T(ep.duration) : ''; renderRows(); }

  function goLive(offset, atIso) {
    sync();
    if (!ep.tracks.length) throw new Error('Нечего выпускать: эпизод пуст');
    var start = atIso || new Date().toISOString();
    var d = { start: start, offset: offset || 0, title: ep.title, tracks: ep.tracks };
    var dur = $('epDur').value.trim();
    if (dur) d.end = window.ProjectParse.tcToSec(dur, 25); else if (ep.duration) d.end = ep.duration;
    return setLive(d);
  }
  var stopOk = function () { return setLive({}); };

  /* ───────── обработчики ───────── */
  function wire() {
    $('epFile').onchange = function () {
      var f = this.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var res = window.ProjectParse.parse(String(rd.result), f.name, {
            fps: Number($('epFps').value) || 25, startTc: $('epStart').value, minTrack: $('epMin').value, duration: $('epDur').value,
            rules: $('epRules').value, title: $('epTitle').value });
          loadedId = null; ep = res.episode; if (!ep.title) ep.title = f.name.replace(/\.[^.]+$/, '');
          if (ep.duration && !$('epDur').value) $('epDur').value = T(ep.duration);
          renderRows();
          msg(res.fmt + ' · ' + ep.tracks.length + ' позиций · режим: ' + res.mode + (res.warnings.length ? ' · ⚠ ' + res.warnings.join('; ') : ''), res.warnings.length > 0);
        } catch (e) { msg(e.message, true); }
      };
      rd.readAsText(f);
    };
    $('epImport').onchange = function () {
      var f = this.files[0]; if (!f) return; var rd = new FileReader();
      rd.onload = function () { try { var d = JSON.parse(rd.result); if (!Array.isArray(d.tracks)) throw 0; loadedId = null; ep = { title: d.title || '', tracks: d.tracks, duration: d.duration || null }; renderRows(); msg('Загружено: ' + ep.tracks.length + ' позиций'); } catch (e) { msg('Это не JSON эпизода', true); } };
      rd.readAsText(f);
    };
    $('epExport').onclick = function () { try { sync(); } catch (e) { return msg(e.message, true); }
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ title: ep.title, tracks: ep.tracks, duration: ep.duration || undefined }, null, 2)], { type: 'application/json' }));
      a.download = (ep.title || 'episode') + '.json'; a.click(); };
    $('epAdd').onclick = function () { try { sync(); } catch (e) { return msg(e.message, true); } var last = ep.tracks.length ? ep.tracks[ep.tracks.length - 1].t + 180 : 0; ep.tracks.push({ t: last, artist: '', title: '' }); renderRows(); };
    $('epTitle').oninput = function () { ep.title = this.value; };
    $('epRows').onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return; var tr = b.closest('tr'), i = Number(tr.dataset.i);
      try { sync(); } catch (er) { return msg(er.message, true); }
      i = ep.tracks.findIndex(function (_, k) { return k === i; });
      var a = b.dataset.a;
      if (a === 'del') ep.tracks.splice(i, 1);
      else if (a === 'up' && i > 0) { var x = ep.tracks[i - 1].t; ep.tracks[i - 1].t = ep.tracks[i].t; ep.tracks[i].t = x; ep.tracks.sort(function (p, q) { return p.t - q.t; }); }
      else if (a === 'dn' && i < ep.tracks.length - 1) { var y = ep.tracks[i + 1].t; ep.tracks[i + 1].t = ep.tracks[i].t; ep.tracks[i].t = y; ep.tracks.sort(function (p, q) { return p.t - q.t; }); }
      renderRows();
    };
    $('epRows').onchange = function (e) { if (e.target.classList.contains('f-k')) { try { sync(); renderRows(); } catch (er) { msg(er.message, true); } } };
    $('epSave').onclick = function () { try { saveEpisode().then(function () { toast('✓ Сохранено в библиотеку'); }).catch(function (e) { msg(e.message, true); }); } catch (e) { msg(e.message, true); } };
    $('gWhen').onchange = function () { $('gAtWrap').style.display = this.value === 'at' ? '' : 'none'; };
    $('gGo').onclick = function () {
      try {
        var at = $('gWhen').value === 'at' ? new Date($('gAt').value).toISOString() : null;
        goLive(Number($('gOffset').value) || 0, at).then(function () { toast('✓ Эфир обновлён'); }).catch(function (e) { msg(e.message, true); });
      } catch (e) { msg('Укажите время старта', true); }
    };
    $('airIdle').onclick = function () { setLive({ idle: true }).then(function () { toast('✓ Ожидание'); }).catch(function (e) { msg(e.message, true); }); };
    $('airStop').onclick = function () { stopOk().then(function () { toast('✓ Виджет выключен (tracklist.json в игнор)'); }).catch(function (e) { msg(e.message, true); }); };
    $('libList').onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return; var item = library.find(function (x) { return x.id === b.dataset.id; }); if (!item) return;
      if (b.dataset.l === 'open') openEpisode(item);
      else if (confirm('Удалить «' + item.title + '»?')) db().from('episodes').delete().eq('id', item.id).then(function () { loadLibrary(); });
    };
    setInterval(function () { if ($('page-air').style.display !== 'none') renderStatus(); }, 1000);
  }

  /* ───────── консоль ───────── */
  var hist = [], hpos = 0;
  function out(text, cls) { var o = $('conOut'), d = document.createElement('div'); if (cls) d.className = cls; d.textContent = text; o.appendChild(d); o.scrollTop = o.scrollHeight; }
  var HELP = ['status                — что сейчас в эфире',
    'episodes              — библиотека (номера)',
    'open <№>              — загрузить эпизод в редактор',
    'tracks                — список позиций открытого эпизода',
    'golive [№] [смещение] — эфир сейчас: эпизод №из библиотеки (иначе открытый), смещение — с или ч:мм:сс',
    'schedule <ЧЧ:ММ> [№]  — запланировать старт на сегодня/завтра по вашему времени',
    'skip <секунды>        — сдвинуть эфир вперёд (например: skip 120)',
    'back <секунды>        — сдвинуть эфир назад',
    'idle                  — заставка «ожидание»',
    'stop                  — выключить (виджет берёт tracklist.json)',
    'say <текст>           — показать вручную: «Артист — Название»',
    'json                  — показать JSON live_state',
    'clear                 — очистить консоль'];
  function num(s) { if (s == null || s === '') return 0; return /:/.test(s) ? window.ProjectParse.tcToSec(s, 25) : Number(s); }
  function pick(n) { var e = library[Number(n) - 1]; if (!e) throw new Error('Нет эпизода №' + n + ' — смотрите episodes'); return e; }
  function shift(sec) {
    if (!live.start || !live.tracks) throw new Error('Эфир не запущен');
    var d = JSON.parse(JSON.stringify(live)); d.offset = (d.offset || 0) + sec;
    return setLive(d).then(function () { out('✓ ' + statusText()); });
  }
  var CMDS = {
    help: function () { HELP.forEach(function (l) { out(l, 'dim'); }); },
    clear: function () { $('conOut').innerHTML = ''; },
    status: function () { return loadLive().then(function () { out(statusText()); }); },
    json: function () { out(JSON.stringify(live, function (k, v) { return k === 'tracks' ? '[' + v.length + ' поз.]' : v; }, 1)); },
    episodes: function () { return loadLibrary().then(function () { if (!library.length) out('Библиотека пуста', 'dim'); library.forEach(function (e, i) { out((i + 1) + '. ' + e.title + ' (' + (e.data.tracks || []).length + ' поз.)'); }); }); },
    open: function (a) { var e = pick(a[0]); openEpisode(e); out('✓ Открыто: ' + e.title); },
    tracks: function () { sync(); if (!ep.tracks.length) out('Эпизод пуст', 'dim'); ep.tracks.forEach(function (t) { out(T(t.t) + '  ' + (t.kind ? '[' + t.kind + '] ' + (t.show ? t.show + ' · ' + t.role : t.text || '') : (t.artist ? t.artist + ' — ' : '') + t.title)); }); },
    golive: function (a) {
      if (a[0]) openEpisode(pick(a[0]));
      return goLive(num(a[1]), null).then(function () { out('✓ В эфире: ' + statusText()); });
    },
    schedule: function (a) {
      var m = /^(\d{1,2}):(\d{2})$/.exec(a[0] || ''); if (!m) throw new Error('Формат: schedule 18:30 [№]');
      var d = new Date(); d.setHours(+m[1], +m[2], 0, 0); if (d < new Date()) d.setDate(d.getDate() + 1);
      if (a[1]) openEpisode(pick(a[1]));
      return goLive(0, d.toISOString()).then(function () { out('✓ Старт запланирован на ' + d.toLocaleString('ru-RU')); });
    },
    skip: function (a) { return shift(-Math.abs(num(a[0]))); },
    back: function (a) { return shift(Math.abs(num(a[0]))); },
    idle: function () { return setLive({ idle: true }).then(function () { out('✓ Ожидание'); }); },
    stop: function () { return stopOk().then(function () { out('✓ Выключено'); }); },
    say: function (a, raw) {
      if (!raw) throw new Error('Формат: say Артист — Название');
      var n = raw.split(/ [—–-] /); var cur = n.length > 1 ? { artist: n.shift(), title: n.join(' - ') } : { artist: '', title: raw };
      return setLive({ now: cur, history: [], updated: new Date().toISOString() }).then(function () { out('✓ Показано (устареет через 15 мин)'); });
    }
  };
  function run(line) {
    out('> ' + line, 'cmd');
    var m = /^(\S+)\s*(.*)$/.exec(line.trim()); if (!m) return;
    var c = CMDS[m[1].toLowerCase()]; if (!c) return out('Неизвестная команда. help — список', 'bad');
    var raw = m[2], args = raw ? raw.split(/\s+/) : [];
    try { var r = c(args, raw); if (r && r.catch) r.catch(function (e) { out('✕ ' + e.message, 'bad'); }); } catch (e) { out('✕ ' + e.message, 'bad'); }
  }
  function wireConsole() {
    out('RUSONG TV · консоль эфира. help — команды', 'dim');
    $('conForm').onsubmit = function (e) { e.preventDefault(); var v = $('conIn').value; if (!v.trim()) return; hist.push(v); hpos = hist.length; $('conIn').value = ''; run(v); };
    $('conIn').onkeydown = function (e) {
      if (e.key === 'ArrowUp' && hpos > 0) { hpos--; this.value = hist[hpos]; e.preventDefault(); }
      else if (e.key === 'ArrowDown') { hpos = Math.min(hpos + 1, hist.length); this.value = hist[hpos] || ''; e.preventDefault(); }
    };
    $('page-console').addEventListener('click', function () { if (!getSelection().toString()) $('conIn').focus(); });
  }

  window.airInit = function () {
    if (window.__airInit) return; window.__airInit = true;
    mount(); renderRows(); wire(); wireConsole();
    loadLive(); loadLibrary();
    setInterval(function () { if (!document.hidden) loadLive(); }, 30000);
  };
})();
