#!/usr/bin/env python3
"""Обновляет repeats.json записями эфиров из VK Видео.

Запускается GitHub Action по расписанию (.github/workflows/update-repeats.yml) или кнопкой в окне scripts/gui.py.
Нужен секрет VK_TOKEN (сервисный ключ VK-приложения или токен группы).

Что делает:
  • читает ВСЕ видео владельца(ев) постранично (не только первые 100);
  • владельцев может быть несколько: VK_OWNER_IDS="-232964863,36245613" (группа и/или страница);
  • идущие, ожидающие и ещё обрабатываемые трансляции пропускает — запись появится после конца эфира;
  • если VK не отдал готовый плеер, строит ссылку-встройку по owner_id и id;
  • в журнал пишет, сколько записей найдено и почему какие-то пропущены.
"""
import json, os, sys, urllib.parse, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DEFAULT_OWNER = 0                 # у RUSONG ID группы VK задаётся явно (VK_OWNER_IDS или поле в окне)
LIVE_NOW = ("waiting", "started", "upcoming")


def _embed(it):
    """Ссылка для iframe. Если VK не прислал player — собираем сами (работает для публичных видео)."""
    p = it.get("player") or ""
    if "video_ext.php" in p:
        p = p.replace("https://vk.com/", "https://vkvideo.ru/").replace("http://vk.com/", "https://vkvideo.ru/")
    else:
        p = "https://vkvideo.ru/video_ext.php?oid=%s&id=%s" % (it["owner_id"], it["id"])
        if it.get("access_key"):
            p += "&hash=" + str(it["access_key"])
    if "hd=" not in p:
        p += ("&" if "?" in p else "?") + "hd=4"
    return p


def _owners(owner_id):
    if isinstance(owner_id, (list, tuple)):
        raw = owner_id
    else:
        raw = str(owner_id or DEFAULT_OWNER).replace(";", ",").split(",")
    out = []
    for x in raw:
        x = str(x).strip()
        if x:
            out.append(int(x))
    return out or [DEFAULT_OWNER]


def _fetch_all(token, owner, log):
    """Все видео владельца постранично."""
    items, offset, total = [], 0, None
    while True:
        q = urllib.parse.urlencode({"owner_id": owner, "count": 200, "offset": offset, "extended": 0,
                                    "v": "5.199", "access_token": token})
        with urllib.request.urlopen("https://api.vk.com/method/video.get?" + q, timeout=30) as r:
            data = json.load(r)
        if "error" in data:
            raise RuntimeError("VK API error (owner %s): %s" % (owner, data["error"].get("error_msg")))
        resp = data["response"]
        page = resp.get("items", [])
        total = resp.get("count", total)
        items += page
        offset += len(page)
        if not page or (total is not None and offset >= total) or offset >= 2000:
            break
    log("owner %s: VK вернул %d видео" % (owner, len(items)))
    return items


def update_repeats(token, root=ROOT, owner_id=DEFAULT_OWNER, limit=24, log=print):
    """Возвращает (число записей, изменился ли файл). Ошибки — RuntimeError."""
    if not token:
        raise RuntimeError("VK_TOKEN is not set")
    out = os.path.join(root, "repeats.json")
    if _owners(owner_id) == [0]:
        raise RuntimeError("Укажите ID группы/страницы VK (для группы — с минусом)")

    fresh, skipped = [], {}
    for owner in _owners(owner_id):
        for it in _fetch_all(token, owner, log):
            why = None
            if it.get("live") or it.get("live_status") in LIVE_NOW:
                why = "эфир ещё идёт или ожидается"
            elif it.get("processing"):
                why = "видео ещё обрабатывается"
            if why:
                skipped.setdefault(why, []).append(it.get("title") or str(it.get("id")))
                continue
            fresh.append({"oid": it["owner_id"], "id": it["id"], "title": (it.get("title") or "").strip(),
                          "date": it.get("date"), "embed": _embed(it)})
    for why, names in skipped.items():
        log("пропущено (%s): %d — %s" % (why, len(names), "; ".join(names[:5])))

    try:
        old = json.load(open(out, encoding="utf-8")).get("items", [])
    except Exception:
        old = []

    seen = {(x["oid"], x["id"]) for x in fresh}
    items = fresh + [x for x in old if (x["oid"], x["id"]) not in seen]
    items.sort(key=lambda x: x.get("date") or 0, reverse=True)   # без даты — в конец
    items = items[:limit]
    if items:
        log("самая свежая запись: %s" % (items[0].get("title") or items[0]["id"]))

    new = json.dumps({"items": items}, ensure_ascii=False, indent=1) + "\n"
    try:
        same = open(out, encoding="utf-8").read() == new
    except FileNotFoundError:
        same = False
    if not same:
        open(out, "w", encoding="utf-8").write(new)
    return len(items), not same


def main():
    token = os.environ.get("VK_TOKEN")
    owners = os.environ.get("VK_OWNER_IDS") or os.environ.get("VK_OWNER_ID") or str(DEFAULT_OWNER)
    try:
        n, changed = update_repeats(token, ROOT, owners, int(os.environ.get("REPEATS_LIMIT", "48")))
    except RuntimeError as e:
        sys.exit(str(e))
    print("repeats.json updated: %d items" % n if changed else "no changes")


if __name__ == "__main__":
    main()
