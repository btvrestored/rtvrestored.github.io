/* Чтение проектов/таймлайнов (EDL, FCP7 XML, FCPXML, OTIO, TXT) → треклист эфира.
   Порт scripts/make_tracklist.py: те же правила, тот же результат. window.ProjectParse.parse(text, filename, opts) */
(function () {
  'use strict';

  function ProjectError(msg) { var e = new Error(msg); e.isProject = true; return e; }

  function tcToSec(tc, fps) {
    var p = String(tc).trim().split(/[:;]/).map(Number);
    if (p.some(isNaN)) throw ProjectError('Неверный таймкод: ' + tc);
    if (p.length === 4) return p[0] * 3600 + p[1] * 60 + p[2] + p[3] / fps;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    throw ProjectError('Неверный таймкод: ' + tc);
  }
  function tcToStr(sec) { sec = Math.floor(sec); var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return h + ':' + ('0' + m).slice(-2) + ':' + ('0' + s).slice(-2); }
  function r2(x) { return Math.round(x * 100) / 100; }

  var KINDS = { wait: 'wait', 'ожидание': 'wait', ad: 'ad', 'реклама': 'ad', promo: 'promo', 'заставка': 'promo', 'заставки': 'promo', 'анонс': 'promo', 'анонсы': 'promo',
    tech: 'tech', 'техника': 'tech', 'неполадки': 'tech', 'пауза': 'tech' };

  function splitKind(name) {
    var m = /^\s*[\[#]\s*([^\]\s]+)\s*\]?\s*(.*)$/.exec(name);
    if (m && KINDS[m[1].toLowerCase()]) return [KINDS[m[1].toLowerCase()], m[2].trim()];
    return [null, name];
  }
  function splitName(name) {
    var seps = [' — ', ' – ', ' - '];
    for (var i = 0; i < seps.length; i++) { var k = name.indexOf(seps[i]); if (k >= 0) return [name.slice(0, k).trim(), name.slice(k + seps[i].length).trim()]; }
    return ['', name.trim()];
  }

  var SHOWS = [[/baby[\W_]*time/i, 'Baby Time'], [/bridge[\W_]*in[\W_]*time/i, 'Bridge in Time'], [/retro[\W_]*dance/i, 'Retro Dance'],
    [/rock[\W_]*party/i, 'Rock Party Time'], [/movie[\W_]*time/i, 'Movie Time'], [/wake[\W_]*up[\W_]*call/i, 'Wake Up Call']];
  var CHART = '';
  function showRoles(items) {   /* items: [t, raw, kind] */
    var idx = {}, roles = {};
    items.forEach(function (it, i) { if (it[2] && it[2].indexOf('show:') === 0) (idx[it[2].slice(5)] = idx[it[2].slice(5)] || []).push(i); });
    Object.keys(idx).forEach(function (name) {
      var pos = idx[name];
      pos.forEach(function (i, n) {
        if (name === CHART) { roles[i] = 'part' + (n + 1); return; }
        var prevAd = i > 0 && items[i - 1][2] === 'ad', nextAd = i + 1 < items.length && items[i + 1][2] === 'ad';
        roles[i] = n === 0 ? 'start' : n === pos.length - 1 ? 'end' : prevAd ? 'back' : nextAd ? 'to_ad' : 'transition';
      });
    });
    return roles;
  }

  var ROLE_WORDS = [[/част[ьи]?\s*(\d+)|part\s*(\d+)/i, 'part'], [/с рекламы|после рекл|возвр|вернул|back/i, 'back'], [/на рекл|уход|to[_ ]?ad/i, 'to_ad'],
    [/переход|transition/i, 'transition'], [/конец|финал|заверш|\bend\b/i, 'end'], [/нач|старт|start/i, 'start']];
  function matchShow(name) {   /* «Baby Time — конец», «TOP10 часть 2» → [программа, роль|null]; иначе null */
    var parts = name.trim().split(/\s+[-–—]\s+|\s*[:|]\s*/), head = parts[0], tail = parts.length > 1 ? parts.slice(1).join(' ') : '';
    if (parts.length > 2) { var m2 = /^(.*?)(?:\s+[-–—]\s+|\s*[:|]\s*)(.*)$/.exec(name.trim()); head = m2[1]; tail = m2[2]; }
    for (var i = 0; i < SHOWS.length; i++) {
      if (head.length <= 40 && SHOWS[i][0].test(head)) {
        var rest = (tail || head.replace(SHOWS[i][0], '')).trim(), role = null;
        for (var j = 0; j < ROLE_WORDS.length; j++) {
          var m = ROLE_WORDS[j][0].exec(rest);
          if (m) { role = ROLE_WORDS[j][1] === 'part' ? 'part' + (m[1] || m[2]) : ROLE_WORDS[j][1]; break; }
        }
        if (tail && role === null) return null;
        return [SHOWS[i][1], role];
      }
    }
    return null;
  }

  var DEFAULT_RULES = [[/рекламн|adsstart|\bads?\b/i, 'ad']];
  var JUNK = /[\[(][^\])]*\b(official|hd|4k|video|music|audio|lyric|lyrics|clip|version|\d{3,4}p(_hd)?)\b[^\])]*[\])]/ig;

  function cleanClipName(n) {
    n = n.trim().replace(/\.(mp4|mov|mkv|avi|webm|png|jpg|mxf|wav|mp3)$/i, '');
    for (var i = 0; i < 3; i++) n = n.replace(JUNK, '');
    if (!/ [-–—] /.test(n)) n = n.replace(/_\s/, ' - ');
    n = n.replace(/_\s/g, ': ').replace(/\s+/g, ' ').replace(/^[ \-–—]+|[ \-–—]+$/g, '');
    return n;
  }

  /* ───── форматы ───── */

  function readEdl(text, fps, startTc) {
    var base = tcToSec(startTc, fps), lines = text.split(/\r?\n/), markers = [], clips = [], ends = [];
    var evM = /^\s*\d+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/;
    lines.forEach(function (ln, i) {
      var m = evM.exec(ln); if (!m) return;
      for (var j = i + 1; j <= i + 2 && j < lines.length; j++) {
        var mm = /^(.*?)\|C:.*?\|M:(.*?)\s*\|D:/.exec(lines[j]);
        if (mm) {
          var note = mm[1].trim(), mname = mm[2].trim();
          var name = (mname && !/^Marker \d+$/.test(mname)) ? mname : (note || mname);
          if (name) markers.push([tcToSec(m[3], fps) - base, name]);
          break;
        }
      }
    });
    var tc = '\\d\\d:\\d\\d:\\d\\d[:;]\\d\\d';
    var ev = new RegExp('^\\s*(\\d+)\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)(?:\\s+(\\d+))?\\s+(' + tc + ')\\s+(' + tc + ')\\s+(' + tc + ')\\s+(' + tc + ')');
    lines.forEach(function (ln, i) {
      var m = ev.exec(ln); if (!m) return;
      var rin = tcToSec(m[8], fps) - base, rout = tcToSec(m[9], fps) - base, dur = rout - rin;
      if (dur <= 0) return;
      var frm = '', to = '';
      for (var j = i + 1; j <= i + 3 && j < lines.length; j++) {
        if (/^\s*\d+\s/.test(lines[j])) break;
        var a = /^\*\s*FROM CLIP NAME:\s*(.+?)\s*$/.exec(lines[j]), b = /^\*\s*TO CLIP NAME:\s*(.+?)\s*$/.exec(lines[j]);
        if (a) frm = a[1]; if (b) to = b[1];
      }
      var raw = (frm.toLowerCase() === 'transition' && to) ? to : frm;
      if (!raw) return;
      clips.push([rin, raw, dur, frm.toLowerCase() === 'transition']);
      ends.push(rout);
    });
    return { markers: markers, clips: clips, duration: ends.length ? r2(Math.max.apply(null, ends)) : null, fps: fps, fmt: 'EDL' };
  }

  function readTxt(text, fps) {
    var out = [];
    text.split(/\r?\n/).forEach(function (ln) {
      var m = /^\s*(\d{1,2}(?::\d{2}){1,3}(?:;\d{2})?)\s+(.+?)\s*$/.exec(ln);
      if (m) out.push([tcToSec(m[1], fps), m[2]]);
    });
    return { markers: out, clips: [], duration: null, fps: fps, fmt: 'TXT' };
  }

  function parseXml(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw ProjectError('Не удалось разобрать XML');
    return doc;
  }
  function kids(el, tag) { return Array.prototype.filter.call(el.children, function (c) { return c.tagName === tag; }); }
  function kid(el, tag) { return kids(el, tag)[0] || null; }
  function txt(el, tag) { var k = el && kid(el, tag); return k ? k.textContent : ''; }
  function rat(s) {          /* «3600/25s», «10s» → секунды */
    if (s == null || s === '') return 0;
    s = String(s).trim().replace(/s$/, '');
    if (s.indexOf('/') >= 0) { var p = s.split('/'); return Number(p[0]) / Number(p[1]); }
    return Number(s) || 0;
  }

  function readFcpxml(text, track) {
    var doc = parseXml(text), root = doc.documentElement;
    if (root.tagName !== 'fcpxml') throw ProjectError('Это не FCPXML');
    var seq = root.getElementsByTagName('sequence')[0];
    if (!seq) throw ProjectError('В FCPXML нет таймлайна (sequence)');
    var fps = 25, fmtId = seq.getAttribute('format');
    Array.prototype.forEach.call(root.getElementsByTagName('format'), function (f) {
      if (f.getAttribute('id') === fmtId && f.getAttribute('frameDuration')) { var fd = rat(f.getAttribute('frameDuration')); if (fd) fps = 1 / fd; }
    });
    var tc0 = rat(seq.getAttribute('tcStart')), spine = kid(seq, 'spine');
    if (!spine) throw ProjectError('В FCPXML нет spine');
    var markers = [], clips = [], end = 0;
    Array.prototype.forEach.call(spine.children, function (el) {
      if (['gap', 'transition', 'audio'].indexOf(el.tagName) >= 0 || el.getAttribute('lane')) return;
      var off = rat(el.getAttribute('offset')) - tc0, dur = rat(el.getAttribute('duration')), start = rat(el.getAttribute('start'));
      var name = el.getAttribute('name') || '';
      if (name) clips.push([off, name, dur, false]);
      end = Math.max(end, off + dur);
      Array.prototype.forEach.call(el.getElementsByTagName('*'), function (mk) {
        if (mk.tagName === 'marker' || mk.tagName === 'chapter-marker') {
          var v = mk.getAttribute('value') || '';
          if (v) markers.push([off + (rat(mk.getAttribute('start')) - start), v]);
        }
      });
    });
    markers.sort(function (a, b) { return a[0] - b[0]; });
    return { markers: markers, clips: clips, duration: end ? r2(end) : null, fps: fps, fmt: 'FCPXML' };
  }

  function readXmeml(text, track) {
    var doc = parseXml(text), root = doc.documentElement;
    if (root.tagName !== 'xmeml') throw ProjectError('Это не FCP7 XML');
    var seq = root.getElementsByTagName('sequence')[0];
    if (!seq) throw ProjectError('В XML нет таймлайна (sequence)');
    var rate = kid(seq, 'rate'), fps = rate ? Number(txt(rate, 'timebase') || 25) : 25;
    if (rate && (txt(rate, 'ntsc') || 'FALSE').toUpperCase() === 'TRUE') fps = fps * 1000 / 1001;
    var media = kid(seq, 'media'), video = media && kid(media, 'video'), tracks = video ? kids(video, 'track') : [];
    if (!tracks.length) throw ProjectError('В XML нет видеодорожек');
    var tr = tracks[Math.min(Math.max(track || 1, 1), tracks.length) - 1];
    var num = function (e, t) { return Number(txt(e, t) || 0); };
    var markers = [], clips = [], end = 0;
    kids(tr, 'clipitem').forEach(function (ci) {
      var s = num(ci, 'start'), e = num(ci, 'end');
      if (s < 0 || e < 0) return;
      var name = txt(ci, 'name');
      if (name) clips.push([s / fps, name, (e - s) / fps, false]);
      end = Math.max(end, e);
      var cin = num(ci, 'in');
      kids(ci, 'marker').forEach(function (mk) {
        var mn = txt(mk, 'name') || txt(mk, 'comment');
        if (mn) markers.push([s / fps + (num(mk, 'in') - cin) / fps, mn]);
      });
    });
    kids(seq, 'marker').forEach(function (mk) {
      var mn = txt(mk, 'name') || txt(mk, 'comment');
      if (mn) markers.push([num(mk, 'in') / fps, mn]);
    });
    markers.sort(function (a, b) { return a[0] - b[0]; });
    return { markers: markers, clips: clips, duration: end ? r2(end / fps) : null, fps: fps, fmt: 'FCP7 XML' };
  }

  function readOtio(text, track) {
    var d; try { d = JSON.parse(text); } catch (e) { throw ProjectError('Не удалось разобрать OTIO'); }
    if (!/^Timeline/.test(String(d.OTIO_SCHEMA || ''))) throw ProjectError('Это не таймлайн OTIO');
    var rt = function (v) { return v && typeof v === 'object' ? Number(v.value || 0) / Number(v.rate || 1) : 0; };
    var stack = d.tracks || {}, vt = (stack.children || []).filter(function (t) { return String(t.kind || 'Video').toLowerCase() === 'video'; });
    if (!vt.length) throw ProjectError('В OTIO нет видеодорожек');
    var tr = vt[Math.min(Math.max(track || 1, 1), vt.length) - 1], fps = 25, markers = [], clips = [], pos = 0;
    (tr.children || []).forEach(function (ch) {
      var schema = String(ch.OTIO_SCHEMA || ''), sr = ch.source_range || {};
      if (/^Transition/.test(schema)) return;
      var dur = sr.duration ? rt(sr.duration) : 0;
      if (!dur && /^Clip/.test(schema)) dur = rt(((ch.media_reference || {}).available_range || {}).duration);
      if (/^Clip/.test(schema)) {
        var name = ch.name || String((ch.media_reference || {}).target_url || '').split('/').pop();
        if (sr.duration && sr.duration.rate) fps = Number(sr.duration.rate);
        if (name) clips.push([pos, name, dur, false]);
        var src0 = rt(sr.start_time);
        (ch.markers || []).forEach(function (mk) { if (mk.name) markers.push([pos + rt((mk.marked_range || {}).start_time) - src0, mk.name]); });
      }
      pos += dur;
    });
    var g0 = rt(d.global_start_time);
    (stack.markers || []).concat(tr.markers || []).forEach(function (mk) { if (mk.name) markers.push([rt((mk.marked_range || {}).start_time) - g0, mk.name]); });
    markers.sort(function (a, b) { return a[0] - b[0]; });
    return { markers: markers, clips: clips, duration: pos ? r2(pos) : null, fps: fps, fmt: 'OTIO' };
  }

  var UNSUPPORTED = {
    drp: 'Файл проекта DaVinci Resolve (.drp) — закрытый формат, прочитать его нельзя. Откройте проект в Resolve и выгрузите таймлайн: File → Export → Timeline… → FCPXML, «Файлы FCP 7 XML», OTIO или EDL.',
    drt: 'Файл таймлайна Resolve (.drt) — закрытый формат. Выгрузите таймлайн в FCPXML, FCP 7 XML, OTIO или EDL.',
    aaf: 'AAF — бинарный формат, он не поддерживается. Выгрузите таймлайн в FCPXML, FCP 7 XML, OTIO или EDL.',
    otioz: 'Архив OTIO (.otioz) не поддерживается. Выгрузите обычный .otio.'
  };

  function load(text, filename, opts) {
    opts = opts || {};
    var ext = (/\.([^.]+)$/.exec((filename || '').toLowerCase()) || [])[1] || '';
    if (UNSUPPORTED[ext]) throw ProjectError(UNSUPPORTED[ext]);
    var head = text.replace(/^\s+/, '').slice(0, 400), fps = opts.fps || null, startTc = opts.startTc || '01:00:00:00', track = opts.track || 1, p;
    if (ext === 'otio' || head.charAt(0) === '{') p = readOtio(text, track);
    else if (ext === 'fcpxml' || head.indexOf('<fcpxml') >= 0) p = readFcpxml(text, track);
    else if (text.slice(0, 2000).indexOf('<xmeml') >= 0 || (ext === 'xml' && text.indexOf('<xmeml') >= 0)) p = readXmeml(text, track);
    else if (ext === 'xml') throw ProjectError('XML не распознан: нужен «Файлы FCP 7 XML» (xmeml) или FCPXML');
    else if (ext === 'edl' || /^\s*TITLE:|^\s*FCM:|\|M:/m.test(text)) p = readEdl(text, fps || 25, startTc);
    else p = readTxt(text, fps || 25);
    return p;
  }

  /* ───── треклист ───── */

  function build(proj, minTrack, rules) {
    var warnings = [], rows, mode;
    if (proj.markers.length) { rows = proj.markers.slice(); mode = proj.fmt === 'TXT' ? 'text' : 'markers'; }
    else if (proj.clips.length) {
      var all = (rules || []).concat(SHOWS.map(function (x) { return [x[0], 'show:' + x[1]]; }), DEFAULT_RULES), picked = [];
      proj.clips.forEach(function (c) {
        var kind = null;
        for (var i = 0; i < all.length; i++) { if (all[i][0].test(c[1])) { kind = all[i][1]; break; } }
        if (kind === 'skip') return;
        if (kind === null && c[2] < minTrack && !c[3]) return;
        picked.push([c[0], c[1], kind]);
      });
      var merged = [];
      picked.forEach(function (p) { if (merged.length && merged[merged.length - 1][1] === p[1]) return; merged.push(p); });
      if (!merged.length) throw ProjectError('В проекте не найдено клипов подходящей длины');
      var roles = showRoles(merged);
      rows = merged.map(function (p, i) { if (p[2] && p[2].indexOf('show:') === 0) return [p[0], '[show:' + p[2].slice(5) + '|' + roles[i] + ']']; return [p[0], ['ad', 'promo', 'wait', 'tech'].indexOf(p[2]) >= 0 ? '[' + p[2] + ']' : cleanClipName(p[1])]; });
      rows = rows.filter(function (r, i) { return !(i && r[1] === rows[i - 1][1] && r[1].charAt(0) === '['); });
      mode = 'cutlist';
    } else throw ProjectError('Маркеры не найдены');
    if (mode !== 'cutlist') {
      var items = rows.map(function (r) { var ms = matchShow(r[1]), k = splitKind(r[1])[0]; return [r[0], r[1], ms ? 'show:' + ms[0] : k]; });
      var rl = showRoles(items);
      rows = rows.map(function (r, i) { return items[i][2] && items[i][2].indexOf('show:') === 0 ? [r[0], '[show:' + items[i][2].slice(5) + '|' + (matchShow(r[1])[1] || rl[i]) + ']'] : r; });
    }
    var tracks = rows.map(function (r) {
      var t = r2(r[0]);
      if (t < 0) throw ProjectError('Отрицательное время у «' + r[1] + '» — проверьте начальный таймкод');
      var sm = /^\[show:(.+)\|(\w+)\]$/.exec(r[1]);
      if (sm) return { t: t, kind: 'show', show: sm[1], role: sm[2] };
      var k = splitKind(r[1]);
      if (k[0]) return { t: t, kind: k[0], text: k[1] };
      var n = splitName(r[1]); return { t: t, artist: n[0], title: n[1] };
    });
    tracks.sort(function (a, b) { return a.t - b.t; });
    tracks.forEach(function (tr) {
      if (tr.kind) return;
      if (!tr.artist || /^[^\p{L}]+$/u.test(tr.title)) warnings.push('проверьте имя (' + tcToStr(tr.t) + '): «' + tr.artist + ' — ' + tr.title + '»');
    });
    return { tracks: tracks, warnings: warnings, mode: mode };
  }

  /* rulesText — JSON [["regex","ad"],…] */
  function parse(text, filename, opts) {
    opts = opts || {};
    var proj = load(text, filename, opts), rules = [];
    if (opts.rules && opts.rules.trim()) {
      try { rules = JSON.parse(opts.rules).map(function (r) { return [new RegExp(r[0], 'i'), r[1]]; }); }
      catch (e) { throw ProjectError('Правила: неверный JSON или регулярное выражение'); }
    }
    var b = build(proj, opts.minTrack == null || opts.minTrack === '' ? 30 : Number(opts.minTrack), rules);
    var ep = { title: opts.title || '', tracks: b.tracks };
    if (opts.duration && String(opts.duration).trim()) ep.duration = tcToSec(opts.duration, proj.fps);
    else if (b.mode === 'cutlist' && proj.duration) ep.duration = proj.duration;
    return { episode: ep, warnings: b.warnings, mode: b.mode, fmt: proj.fmt, fps: proj.fps };
  }

  window.ProjectParse = { parse: parse, tcToSec: tcToSec, tcToStr: tcToStr };
})();
