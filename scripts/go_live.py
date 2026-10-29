#!/usr/bin/env python3
"""Запускает «Сейчас в эфире»: кладёт в tracklist.json эфир и момент старта.

    python3 scripts/go_live.py episodes/ep01.json            # старт = сейчас
    python3 scripts/go_live.py episodes/ep01.json --offset 15 # учесть задержку VK Live (сек): трек на сайте позже на 15 с
    python3 scripts/go_live.py --idle                         # в OBS включён idle: виджет показывает «ожидание эфира»
    python3 scripts/go_live.py --stop                         # убрать виджет
Добавьте --push, чтобы сразу сделать git commit и push (сайт обновится через ~1 минуту).
Запускайте в момент, когда в OBS реально стартует первый файл эфира.
Окно управления со всеми кнопками: python3 scripts/gui.py
"""
import argparse, datetime, json, subprocess, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def git_push(root, files, message):
    subprocess.run(["git", "-C", root, "add"] + list(files), check=True)
    subprocess.run(["git", "-C", root, "commit", "-m", message], check=True)
    subprocess.run(["git", "-C", root, "push"], check=True)


def go_live(root=ROOT, episode=None, offset=0.0, stop=False, idle=False, at="", push=False):
    """Записывает tracklist.json. episode — путь к json эфира или уже загруженный dict. Возвращает (data, сообщение)."""
    out = os.path.join(root, "tracklist.json")
    if idle:
        data = {"idle": True, "start": None, "tracks": []}
    elif stop or not episode:
        data = {"start": None, "tracks": []}
    else:
        ep = episode if isinstance(episode, dict) else json.load(open(episode, encoding="utf-8"))
        if at:
            st = datetime.datetime.fromisoformat(at.replace(" ", "T")).astimezone(datetime.timezone.utc)
        else:
            st = datetime.datetime.now(datetime.timezone.utc)
        data = {"start": st.isoformat(timespec="seconds"), "offset": offset, "title": ep.get("title", ""), "tracks": ep["tracks"]}
        if ep.get("duration") is not None:
            data["end"] = ep["duration"]
    json.dump(data, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    msg = "tracklist.json: " + ("ожидание (idle)" if data.get("idle") else ("старт " + data["start"] if data["start"] else "остановлен"))
    if push:
        git_push(root, ["tracklist.json"], "Tracklist: " + ("go live" if data["start"] else "idle" if data.get("idle") else "stop"))
        msg += "; отправлено в git"
    return data, msg


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("episode", nargs="?")
    ap.add_argument("--offset", type=float, default=0)
    ap.add_argument("--stop", action="store_true", help="скрыть виджет")
    ap.add_argument("--idle", action="store_true", help="показывать «ожидание эфира» (в OBS идёт idle-файл)")
    ap.add_argument("--at", default="", help="запланированный старт, например \"2026-10-06 20:00\" (местное время); до него виджет показывает ожидание и отсчёт")
    ap.add_argument("--push", action="store_true")
    a = ap.parse_args(argv)
    print(go_live(ROOT, a.episode, a.offset, a.stop, a.idle, a.at, a.push)[1])


if __name__ == "__main__":
    main()
