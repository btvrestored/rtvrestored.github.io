#!/usr/bin/env python3
"""Превращает проект/таймлинию монтажной программы или текстовый список в файл эфира episodes/<имя>.json.

Поддерживаемые файлы (File → Export в DaVinci Resolve, также Premiere/Final Cut/любой NLE):
    .edl                    — EDL: маркеры («Timeline Markers to EDL») или обычная нарезка (клипы)
    .xml (xmeml / FCP7)     — «Файлы FCP 7 XML» — клипы и маркеры
    .fcpxml / .fcpxmld      — Final Cut Pro XML 1.8–1.13 — клипы и маркеры
    .otio                   — OpenTimelineIO — клипы и маркеры
    .txt                    — по строке на трек: «00:03:41 Артист — Название»
Не читаются (закрытые форматы): .drp (проект Resolve), .drt (таймлайн Resolve), .aaf, .otioz.
Откройте проект в Resolve и выгрузите таймлайн в один из форматов выше.

Служебные блоки — имя маркера начинается с метки в квадратных скобках:
    [ожидание] / [wait]      ожидание начала эфира
    [реклама]  / [ad]        рекламный блок
    [заставки] / [promo]     заставки и анонсы
    [техника]  / [tech]      технические неполадки
После метки можно написать свой текст: «[tech] Ушли за кабелем». Без текста сайт покажет случайную шутку.

Режим «нарезка» (в файле нет маркеров): берутся имена клипов и их положение на таймлинии. Клипы короче
--min-track (30 с) считаются заставками/склейками и пропускаются (на сайте остаётся предыдущий трек).
Служебные клипы назначаются правилами --rules rules.json, например:
    [["Рекламный блок|adsstart", "ad"], ["EBU Color", "tech"]]
Виды: ad, promo, wait, tech, skip (пропустить), music (принудительно трек).
Имена очищаются от «(1080P_HD)», «(Official Video)» и т. п. Для xml/fcpxml/otio можно выбрать видеодорожку (--track).

Использование:
    python3 scripts/make_tracklist.py проект.edl episodes/ep01.json [--fps 25] [--start-tc 01:00:00:00] [--title "Эфир 1"]
"""
import argparse, json, os, re, sys
from fractions import Fraction
import xml.etree.ElementTree as ET


class ProjectError(Exception):
    pass


# ───────────────────────── время ─────────────────────────

def tc_to_str(sec):
    sec = int(sec)
    return "%d:%02d:%02d" % (sec // 3600, sec % 3600 // 60, sec % 60)


def tc_to_sec(tc, fps):
    p = re.split(r"[:;]", str(tc).strip())
    if len(p) == 4:
        h, m, s, f = map(int, p); return h*3600 + m*60 + s + f/fps
    if len(p) == 3:
        h, m, s = map(int, p); return h*3600 + m*60 + s
    if len(p) == 2:
        m, s = map(int, p); return m*60 + s
    raise ValueError("bad timecode: " + str(tc))


# ───────────────────────── служебные блоки и имена ─────────────────────────

KINDS = {"wait": "wait", "ожидание": "wait", "ad": "ad", "реклама": "ad",
         "promo": "promo", "заставка": "promo", "заставки": "promo", "анонс": "promo", "анонсы": "promo",
         "tech": "tech", "техника": "tech", "неполадки": "tech", "пауза": "tech"}


# Заставки программ: имя файла клипа -> название программы (роль — начало/переход/на рекламу/с рекламы/конец — определяется по соседям).
# TOP10 — чарт, а не ротация клипов: роли «часть 1», «часть 2»…
SHOWS = [(r"baby[\W_]*time", "Baby Time"), (r"bridge[\W_]*in[\W_]*time", "Bridge in Time"),
         (r"retro[\W_]*dance", "Retro Dance"), (r"rock[\W_]*party", "Rock Party Time"),
         (r"movie[\W_]*time", "Movie Time"), (r"wake[\W_]*up[\W_]*call", "Wake Up Call")]
CHART = ""   # у RUSONG чарта нет


ROLE_WORDS = [(r"част[ьи]?\s*(\d+)|part\s*(\d+)", "part"), (r"с рекламы|после рекл|возвр|вернул|back", "back"),
              (r"на рекл|уход|to[_ ]?ad", "to_ad"), (r"переход|transition", "transition"),
              (r"конец|финал|заверш|\bend\b", "end"), (r"нач|старт|start", "start")]


def match_show(name):
    """Маркер «Rock Party Time» / «Baby Time — конец» / «TOP10 часть 2» -> (программа, роль|None); иначе None."""
    parts = re.split(r"\s+[-–—]\s+|\s*[:|]\s*", name.strip(), maxsplit=1)
    head, tail = parts[0], (parts[1] if len(parts) > 1 else "")
    for pat, show in SHOWS:
        if len(head) <= 40 and re.search(pat, head, re.I):
            rest = (tail or re.sub(pat, "", head, flags=re.I)).strip()
            role = None
            for rp, r in ROLE_WORDS:
                m = re.search(rp, rest, re.I)
                if m: role = ("part%s" % (m.group(1) or m.group(2))) if r == "part" else r; break
            if tail and role is None: return None            # «Baby Time - Something»: это трек, а не заставка
            return show, role
    return None


def show_roles(items):
    """items: [(t, raw, kind)] в порядке эфира; kind 'show:<Имя>' -> {индекс: роль}"""
    idx = {}
    for i, it in enumerate(items):
        if it[2] and it[2].startswith("show:"): idx.setdefault(it[2][5:], []).append(i)
    roles = {}
    for name, pos in idx.items():
        for n, i in enumerate(pos):
            if name == CHART: roles[i] = "part%d" % (n + 1); continue
            prev_ad = i > 0 and items[i-1][2] == "ad"
            next_ad = i + 1 < len(items) and items[i+1][2] == "ad"
            if n == 0: roles[i] = "start"
            elif n == len(pos) - 1: roles[i] = "end"
            elif prev_ad: roles[i] = "back"
            elif next_ad: roles[i] = "to_ad"
            else: roles[i] = "transition"
    return roles


def split_kind(name):
    """«[tech] текст» -> ("tech", "текст"); обычный трек -> (None, name)."""
    m = re.match(r"^\s*[\[#]\s*([^\]\s]+)\s*\]?\s*(.*)$", name)
    if m and m.group(1).lower() in KINDS:
        return KINDS[m.group(1).lower()], m.group(2).strip()
    return None, name


def split_name(name):
    for sep in (" — ", " – ", " - "):
        if sep in name:
            a, t = name.split(sep, 1); return a.strip(), t.strip()
    return "", name.strip()


DEFAULT_RULES = [(r"рекламн|adsstart|\bads?\b", "ad")]
JUNK = re.compile(r"[\[(][^\])]*\b(official|hd|4k|video|music|audio|lyric|lyrics|clip|version|\d{3,4}p(_hd)?)\b[^\])]*[\])]", re.I)


def clean_clip_name(n):
    n = re.sub(r"\.(mp4|mov|mkv|avi|webm|png|jpg|mxf|wav|mp3)$", "", n.strip(), flags=re.I)
    for _ in range(3): n = JUNK.sub("", n)
    if not re.search(r" [-–—] ", n): n = re.sub(r"_\s", " - ", n, count=1)   # «Metallica_ Nothing…» → «Metallica - Nothing…»
    n = re.sub(r"_\s", ": ", n)            # «O Come_ O Come» → «O Come: O Come»
    n = re.sub(r"\s+", " ", n).strip(" -–—")
    return n


# ───────────────────────── чтение форматов ─────────────────────────
# Каждый reader возвращает dict:
#   markers  [(t_sec, name)]            — маркеры, время от начала таймлинии
#   clips    [(t_sec, raw_name, dur, keep)]   — клипы (keep=True: не отбрасывать по длительности — переходы)
#   duration длительность таймлинии (с) или None
#   fps      частота кадров
#   fmt      название формата

def read_edl(text, fps, start_tc):
    base = tc_to_sec(start_tc, fps)
    lines = text.splitlines()
    markers, clips, ends = [], [], []
    ev_marker = re.compile(r"^\s*\d+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)")
    for i, ln in enumerate(lines):
        m = ev_marker.match(ln)
        if not m: continue
        for nxt in lines[i+1:i+3]:
            mm = re.search(r"^(.*?)\|C:.*?\|M:(.*?)\s*\|D:", nxt)
            if mm:
                note, mname = mm.group(1).strip(), mm.group(2).strip()
                # имя маркера главное; если оно пустое или стандартное «Marker N» — берём заметку
                name = mname if mname and not re.match(r"^Marker \d+$", mname) else (note or mname)
                if name: markers.append((tc_to_sec(m.group(3), fps) - base, name))
                break
    tcre = r"\d\d:\d\d:\d\d[:;]\d\d"
    ev = re.compile(r"^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\d+))?\s+(%s)\s+(%s)\s+(%s)\s+(%s)" % (tcre, tcre, tcre, tcre))
    for i, ln in enumerate(lines):
        m = ev.match(ln)
        if not m: continue
        rin, rout = tc_to_sec(m.group(8), fps) - base, tc_to_sec(m.group(9), fps) - base
        dur = rout - rin
        if dur <= 0: continue
        frm = to = ""
        for nxt in lines[i+1:i+4]:
            if re.match(r"^\s*\d+\s", nxt): break
            a = re.match(r"^\*\s*FROM CLIP NAME:\s*(.+?)\s*$", nxt)
            b = re.match(r"^\*\s*TO CLIP NAME:\s*(.+?)\s*$", nxt)
            if a: frm = a.group(1)
            if b: to = b.group(1)
        raw = to if (frm.lower() == "transition" and to) else frm
        if not raw: continue
        # переход: длительность события — это длительность перехода, реальная длина клипа неизвестна → считаем треком
        clips.append((rin, raw, dur, frm.lower() == "transition"))
        ends.append(rout)
    return {"markers": markers, "clips": clips, "duration": round(max(ends), 2) if ends else None, "fps": fps, "fmt": "EDL"}


def read_txt(text, fps):
    out = []
    for ln in text.splitlines():
        m = re.match(r"^\s*(\d{1,2}(?::\d{2}){1,3}(?:;\d{2})?)\s+(.+?)\s*$", ln)
        if m: out.append((tc_to_sec(m.group(1), fps), m.group(2)))
    return {"markers": out, "clips": [], "duration": None, "fps": fps, "fmt": "TXT"}


def _rat(s):
    """FCPXML-время «3600/25s», «10s», «0s» → Fraction секунд."""
    if s is None: return Fraction(0)
    s = str(s).strip().rstrip("s")
    if not s: return Fraction(0)
    if "/" in s:
        a, b = s.split("/"); return Fraction(int(a), int(b))
    return Fraction(s)


def _parse_xml(text):
    try:
        return ET.fromstring(text.encode("utf-8") if isinstance(text, str) else text)
    except ET.ParseError as e:
        raise ProjectError("Не удалось разобрать XML: %s" % e)


def read_fcpxml(text, track=1):
    root = _parse_xml(text)
    if root.tag != "fcpxml":
        raise ProjectError("Это не FCPXML")
    seq = root.find(".//sequence")
    if seq is None: raise ProjectError("В FCPXML нет таймлайна (sequence)")
    fps = 25.0
    fmt_id = seq.get("format")
    for f in root.iter("format"):
        if f.get("id") == fmt_id and f.get("frameDuration"):
            fd = _rat(f.get("frameDuration")); fps = float(1 / fd) if fd else fps
    tc0 = _rat(seq.get("tcStart"))
    spine = seq.find("spine")
    if spine is None: raise ProjectError("В FCPXML нет spine")
    markers, clips, end = [], [], Fraction(0)
    for el in spine:
        if el.tag in ("gap", "transition", "audio") or el.get("lane"):
            continue
        off = _rat(el.get("offset")) - tc0
        dur = _rat(el.get("duration"))
        start = _rat(el.get("start"))
        name = el.get("name") or ""
        if name:
            clips.append((float(off), name, float(dur), False))
        end = max(end, off + dur)
        for mk in el.iter():
            if mk.tag in ("marker", "chapter-marker"):
                mname = mk.get("value") or ""
                if mname:
                    markers.append((float(off + (_rat(mk.get("start")) - start)), mname))
    markers.sort()
    return {"markers": markers, "clips": clips, "duration": round(float(end), 2) if end else None, "fps": fps, "fmt": "FCPXML"}


def read_xmeml(text, track=1):
    root = _parse_xml(text)
    if root.tag != "xmeml":
        raise ProjectError("Это не FCP7 XML")
    seq = root.find(".//sequence")
    if seq is None: raise ProjectError("В XML нет таймлайна (sequence)")
    rate = seq.find("rate")
    tb = float(rate.findtext("timebase", "25")) if rate is not None else 25.0
    if rate is not None and (rate.findtext("ntsc", "FALSE") or "").upper() == "TRUE":
        tb = tb * 1000 / 1001
    fps = tb
    num = lambda e, tag: float(e.findtext(tag) or 0)
    vtracks = seq.findall("./media/video/track")
    if not vtracks: raise ProjectError("В XML нет видеодорожек")
    tr = vtracks[min(max(track, 1), len(vtracks)) - 1]
    markers, clips, end = [], [], 0.0
    for ci in tr.findall("clipitem"):
        s, e = num(ci, "start"), num(ci, "end")
        if s < 0 or e < 0: continue                 # куски переходов
        name = ci.findtext("name") or ""
        if name: clips.append((s / fps, name, (e - s) / fps, False))
        end = max(end, e)
        cin = num(ci, "in")
        for mk in ci.findall("marker"):
            mname = mk.findtext("name") or mk.findtext("comment") or ""
            if mname: markers.append((s / fps + (num(mk, "in") - cin) / fps, mname))
    for mk in seq.findall("marker"):
        mname = mk.findtext("name") or mk.findtext("comment") or ""
        if mname: markers.append((num(mk, "in") / fps, mname))
    markers.sort()
    return {"markers": markers, "clips": clips, "duration": round(end / fps, 2) if end else None, "fps": fps, "fmt": "FCP7 XML"}


def read_otio(text, track=1):
    try:
        d = json.loads(text)
    except ValueError as e:
        raise ProjectError("Не удалось разобрать OTIO: %s" % e)
    if not str(d.get("OTIO_SCHEMA", "")).startswith("Timeline"):
        raise ProjectError("Это не таймлайн OTIO")

    def rt(v):                                      # RationalTime → секунды
        if not isinstance(v, dict): return 0.0
        return float(v.get("value", 0)) / float(v.get("rate", 1) or 1)

    stack = d.get("tracks") or {}
    vtracks = [t for t in stack.get("children", []) if str(t.get("kind", "Video")).lower() == "video"]
    if not vtracks: raise ProjectError("В OTIO нет видеодорожек")
    tr = vtracks[min(max(track, 1), len(vtracks)) - 1]
    fps = 25.0
    markers, clips, pos = [], [], 0.0
    for ch in tr.get("children", []):
        schema = str(ch.get("OTIO_SCHEMA", ""))
        sr = ch.get("source_range") or {}
        if schema.startswith("Transition"):
            continue
        dur = rt(sr.get("duration")) if sr else 0.0
        if not dur and schema.startswith("Clip"):
            ar = (ch.get("media_reference") or {}).get("available_range") or {}
            dur = rt(ar.get("duration"))
        if schema.startswith("Clip"):
            name = ch.get("name") or os.path.basename(str((ch.get("media_reference") or {}).get("target_url", "")))
            if sr.get("duration", {}).get("rate"): fps = float(sr["duration"]["rate"])
            if name: clips.append((pos, name, dur, False))
            src0 = rt(sr.get("start_time"))
            for mk in ch.get("markers", []):
                mn = mk.get("name") or ""
                if mn: markers.append((pos + rt((mk.get("marked_range") or {}).get("start_time")) - src0, mn))
        pos += dur
    g0 = rt(d.get("global_start_time"))
    for mk in stack.get("markers", []) + tr.get("markers", []):
        mn = mk.get("name") or ""
        if mn: markers.append((rt((mk.get("marked_range") or {}).get("start_time")) - g0, mn))
    markers.sort()
    return {"markers": markers, "clips": clips, "duration": round(pos, 2) if pos else None, "fps": fps, "fmt": "OTIO"}


UNSUPPORTED = {
    ".drp": "Файл проекта DaVinci Resolve (.drp) — закрытый формат, прочитать его нельзя. Откройте проект в Resolve и выгрузите таймлайн: File → Export → Timeline… → FCPXML, «Файлы FCP 7 XML», OTIO или EDL.",
    ".drt": "Файл таймлайна Resolve (.drt) — закрытый формат. Выгрузите таймлайн в FCPXML, FCP 7 XML, OTIO или EDL.",
    ".aaf": "AAF — бинарный формат, он не поддерживается. Выгрузите таймлайн в FCPXML, FCP 7 XML, OTIO или EDL.",
    ".otioz": "Архив OTIO (.otioz) не поддерживается. Выгрузите обычный .otio.",
    ".otio.zip": "Распакуйте архив и откройте .otio.",
}


def load_project(text, filename="", fps=None, start_tc="01:00:00:00", track=1):
    """Определяет формат по имени и содержимому. fps=None → из файла (EDL/TXT: 25)."""
    ext = os.path.splitext(filename.lower())[1]
    if ext in UNSUPPORTED:
        raise ProjectError(UNSUPPORTED[ext])
    head = text.lstrip()[:400]
    if ext == ".otio" or head.startswith("{"):
        p = read_otio(text, track)
    elif ext == ".fcpxml" or "<fcpxml" in head:
        p = read_fcpxml(text, track)
    elif "<xmeml" in text[:2000] or (ext == ".xml" and "<xmeml" in text):
        p = read_xmeml(text, track)
    elif ext == ".xml":
        raise ProjectError("XML не распознан: нужен «Файлы FCP 7 XML» (xmeml) или FCPXML")
    elif ext == ".edl" or re.search(r"^\s*TITLE:|^\s*FCM:|\|M:", text, re.M):
        p = read_edl(text, fps or 25, start_tc)
    else:
        p = read_txt(text, fps or 25)
    if fps and p["fmt"] in ("FCP7 XML", "FCPXML", "OTIO"):
        p["fps"] = fps           # явное значение перекрывает частоту из файла только для длительностей (времена уже в секундах)
    return p


def read_project_file(path, **kw):
    ext = os.path.splitext(path.lower().rstrip("/\\"))[1]
    if ext in UNSUPPORTED:
        raise ProjectError(UNSUPPORTED[ext])
    if os.path.isdir(path):                       # пакет .fcpxmld
        for cand in ("Info.fcpxml", "info.fcpxml"):
            if os.path.exists(os.path.join(path, cand)):
                path = os.path.join(path, cand); break
    with open(path, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8-sig", errors="replace")
    return load_project(text, os.path.basename(path), **kw)


# ───────────────────────── построение списка треков ─────────────────────────

def build_tracks(proj, min_track=30, rules=None):
    """→ (tracks, warnings, mode). mode: markers | cutlist | text"""
    warnings = []
    if proj["markers"]:
        rows = [(t, n) for t, n in proj["markers"]]
        mode = "text" if proj["fmt"] == "TXT" else "markers"
    elif proj["clips"]:
        rules = list(rules or []) + [(p, "show:" + n) for p, n in SHOWS] + DEFAULT_RULES
        picked = []
        for t, raw, dur, keep in proj["clips"]:
            kind = None
            for pat, k in rules:
                if re.search(pat, raw, re.I): kind = k; break
            if kind == "skip": continue
            if kind is None and dur < min_track and not keep: continue
            picked.append((t, raw, kind))
        merged = []                                   # подряд идущие события одного клипа (разрезы, концы переходов)
        for t, raw, kind in picked:
            if merged and merged[-1][1] == raw: continue
            merged.append((t, raw, kind))
        if not merged: raise ProjectError("В проекте не найдено клипов подходящей длины")
        rows = []
        roles = show_roles(merged)
        for i, (t, raw, kind) in enumerate(merged):
            if kind and kind.startswith("show:"): rows.append((t, "[show:%s|%s]" % (kind[5:], roles[i])))
            else: rows.append((t, "[%s]" % kind if kind in ("ad", "promo", "wait", "tech") else clean_clip_name(raw)))
        rows = [r for i, r in enumerate(rows) if not (i and r[1] == rows[i-1][1] and r[1].startswith("["))]
        mode = "cutlist"
    else:
        raise ProjectError("Маркеры не найдены")
    if mode in ("markers", "text"):                       # заставки программ среди маркеров
        items = []
        for t, n in rows:
            ms = match_show(n); k, _ = split_kind(n)
            items.append((t, n, ("show:" + ms[0]) if ms else k))
        roles = show_roles(items)
        rows = [(t, "[show:%s|%s]" % (items[i][2][5:], match_show(n)[1] or roles[i])) if items[i][2] and items[i][2].startswith("show:") else (t, n)
                for i, (t, n) in enumerate(rows)]
    tracks = []
    for t, name in rows:
        t = round(t, 2)
        if t < 0: raise ProjectError("Отрицательное время у «%s» — проверьте начальный таймкод" % name)
        sm = re.match(r"^\[show:(.+)\|(\w+)\]$", name)
        if sm:
            tracks.append({"t": t, "kind": "show", "show": sm.group(1), "role": sm.group(2)}); continue
        kind, rest = split_kind(name)
        if kind:
            tracks.append({"t": t, "kind": kind, "text": rest})      # служебный блок (пустой text — шутка по умолчанию)
        else:
            artist, title = split_name(name)
            tracks.append({"t": t, "artist": artist, "title": title})
    tracks.sort(key=lambda x: x["t"])
    for tr in tracks:
        if "kind" in tr: continue
        if not tr["artist"] or re.fullmatch(r"[\d\W_]+", tr["title"]):
            warnings.append("проверьте имя (%s): «%s — %s»" % (tc_to_str(tr["t"]), tr["artist"], tr["title"]))
    return tracks, warnings, mode


def make_episode(proj, title="", duration="", min_track=30, rules=None):
    """→ (episode_dict, warnings, mode)"""
    tracks, warnings, mode = build_tracks(proj, min_track, rules)
    ep = {"title": title, "tracks": tracks}
    if duration:
        ep["duration"] = tc_to_sec(duration, proj["fps"]) if isinstance(duration, str) else float(duration)
    elif mode == "cutlist" and proj.get("duration"):
        ep["duration"] = proj["duration"]
    return ep, warnings, mode


def parse_rules(text_or_list):
    if not text_or_list: return []
    data = json.loads(text_or_list) if isinstance(text_or_list, str) else text_or_list
    return [tuple(r) for r in data]


def main(argv=None):
    ap = argparse.ArgumentParser(description="Проект/таймлайн/EDL → episodes/*.json")
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--fps", type=float, default=None, help="частота кадров (EDL: 25 по умолчанию; xml/otio: из файла)")
    ap.add_argument("--start-tc", default="01:00:00:00", help="таймкод начала таймлинии для EDL (в Resolve по умолчанию 01:00:00:00)")
    ap.add_argument("--title", default="")
    ap.add_argument("--track", type=int, default=1, help="номер видеодорожки для xml/fcpxml/otio (V1 по умолчанию)")
    ap.add_argument("--min-track", type=float, default=30, help="режим нарезки: клипы короче N секунд считаются заставками и пропускаются")
    ap.add_argument("--rules", default="", help="JSON-файл с правилами [[\"regex\", \"ad|promo|wait|tech|skip|music\"], ...]")
    ap.add_argument("--duration", default="", help="длительность эфира (ЧЧ:ММ:СС), после неё сайт снова покажет ожидание")
    a = ap.parse_args(argv)
    try:
        proj = read_project_file(a.src, fps=a.fps, start_tc=a.start_tc, track=a.track)
        rules = parse_rules(open(a.rules, encoding="utf-8").read()) if a.rules else []
        ep, warnings, mode = make_episode(proj, a.title, a.duration, a.min_track, rules)
    except (ProjectError, OSError, ValueError) as e:
        sys.exit("Ошибка: %s" % e)
    print("%s, режим: %s" % (proj["fmt"], {"markers": "маркеры", "cutlist": "нарезка (имена клипов)", "text": "текст"}[mode]))
    for w in warnings: print("⚠", w)
    os.makedirs(os.path.dirname(os.path.abspath(a.dst)), exist_ok=True)
    json.dump(ep, open(a.dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("%d треков → %s" % (len(ep["tracks"]), a.dst))


if __name__ == "__main__":
    main()
