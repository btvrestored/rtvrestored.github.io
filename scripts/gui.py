#!/usr/bin/env python3
"""Окно управления эфиром: треклист из проекта, запуск «в эфир», обновление повторов.

    python3 scripts/gui.py            # откроется страница в браузере (только на этом компьютере)
    python3 scripts/gui.py --port 8765 --no-browser

Работает без установки пакетов (только стандартная библиотека Python 3.8+). Сервер слушает 127.0.0.1,
каждое действие защищено одноразовым ключом, который вшит в открытую страницу.
"""
import argparse, json, os, re, secrets, subprocess, sys, threading, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_tracklist as MT
import go_live as GL
import update_repeats as UR

ROOT = GL.ROOT
TOKEN = secrets.token_urlsafe(24)
PORT = 0


def episodes_dir():
    d = os.path.join(ROOT, "episodes"); os.makedirs(d, exist_ok=True); return d


def safe_name(n):
    n = re.sub(r"[^\w\-. ]+", "_", (n or "").strip(), flags=re.U).strip(" .")
    if n.lower().endswith(".json"): n = n[:-5]
    if not n: raise ValueError("Укажите имя файла эфира")
    return n[:80]


def git_available():
    return os.path.isdir(os.path.join(ROOT, ".git"))


def state():
    eps = sorted(f[:-5] for f in os.listdir(episodes_dir()) if f.endswith(".json"))
    tl = {}
    p = os.path.join(ROOT, "tracklist.json")
    if os.path.exists(p):
        try:
            d = json.load(open(p, encoding="utf-8"))
            tl = {"mode": "idle" if d.get("idle") else ("live" if d.get("start") else "stopped"),
                  "start": d.get("start"), "title": d.get("title", ""), "tracks": len(d.get("tracks", []))}
        except Exception:
            tl = {"mode": "error"}
    rp = os.path.join(ROOT, "repeats.json")
    n = 0
    if os.path.exists(rp):
        try: n = len(json.load(open(rp, encoding="utf-8")).get("items", []))
        except Exception: pass
    return {"root": ROOT, "episodes": eps, "tracklist": tl, "repeats": n, "git": git_available(),
            "env_token": bool(os.environ.get("VK_TOKEN"))}


def api_parse(b):
    proj = MT.load_project(b.get("content", ""), b.get("filename", ""),
                           fps=float(b["fps"]) if str(b.get("fps", "")).strip() else None,
                           start_tc=b.get("startTc") or "01:00:00:00", track=int(b.get("track") or 1))
    rules = MT.parse_rules(b.get("rules", "").strip()) if b.get("rules", "").strip() else []
    ep, warnings, mode = MT.make_episode(proj, b.get("title", ""), (b.get("duration") or "").strip(),
                                         float(b.get("minTrack") or 30), rules)
    return {"episode": ep, "warnings": warnings, "mode": mode, "fmt": proj["fmt"], "fps": proj["fps"]}


def clean_episode(ep):
    tracks = []
    for t in ep.get("tracks", []):
        item = {"t": round(float(t["t"]), 2)}
        if t.get("kind"):
            item["kind"] = t["kind"]; item["text"] = t.get("text", "")
        else:
            item["artist"] = t.get("artist", ""); item["title"] = t.get("title", "")
        tracks.append(item)
    tracks.sort(key=lambda x: x["t"])
    out = {"title": ep.get("title", ""), "tracks": tracks}
    if ep.get("duration") not in (None, ""): out["duration"] = float(ep["duration"])
    return out


def api_save(b):
    name = safe_name(b.get("name"))
    ep = clean_episode(b["episode"])
    path = os.path.join(episodes_dir(), name + ".json")
    json.dump(ep, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    msg = "Сохранено: episodes/%s.json (%d треков)" % (name, len(ep["tracks"]))
    if b.get("push"):
        GL.git_push(ROOT, ["episodes/%s.json" % name], "Episode: " + name); msg += "; отправлено в git"
    return {"message": msg, "name": name}


def api_episode(name):
    path = os.path.join(episodes_dir(), safe_name(name) + ".json")
    return {"episode": json.load(open(path, encoding="utf-8"))}


def api_golive(b):
    mode = b.get("mode")
    ep = None
    if mode == "live":
        ep = os.path.join(episodes_dir(), safe_name(b.get("episode")) + ".json")
        if not os.path.exists(ep): raise ValueError("Эфир не найден — сначала сохраните его")
    _, msg = GL.go_live(ROOT, ep, float(b.get("offset") or 0), stop=(mode == "stop"), idle=(mode == "idle"),
                        at=(b.get("at") or "").strip() if mode == "live" else "", push=bool(b.get("push")))
    return {"message": msg}


def api_repeats(b):
    token = (b.get("token") or os.environ.get("VK_TOKEN") or "").strip()
    n, changed = UR.update_repeats(token, ROOT, int(b.get("owner") or 0), int(b.get("limit") or 24))
    msg = "repeats.json обновлён: %d записей" % n if changed else "Без изменений (%d записей)" % n
    if changed and b.get("push"):
        GL.git_push(ROOT, ["repeats.json"], "Update repeats.json"); msg += "; отправлено в git"
    return {"message": msg}


class H(BaseHTTPRequestHandler):
    server_version = "BTVPanel"

    def log_message(self, *a): pass

    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        raw = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers(); self.wfile.write(raw)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def do_GET(self):
        if not self._host_ok(): return self._json(403, {"ok": False, "error": "forbidden host"})
        u = urlparse(self.path)
        if u.path == "/":
            page = open(os.path.join(HERE, "gui.html"), encoding="utf-8").read().replace("__TOKEN__", TOKEN)
            return self._send(200, page, "text/html; charset=utf-8")
        if self.headers.get("X-Token") != TOKEN: return self._json(403, {"ok": False, "error": "bad token"})
        try:
            if u.path == "/api/state": return self._json(200, {"ok": True, **state()})
            if u.path == "/api/episode": return self._json(200, {"ok": True, **api_episode(parse_qs(u.query).get("name", [""])[0])})
        except Exception as e:
            return self._json(400, {"ok": False, "error": str(e)})
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self._host_ok(): return self._json(403, {"ok": False, "error": "forbidden host"})
        if self.headers.get("X-Token") != TOKEN: return self._json(403, {"ok": False, "error": "bad token"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 60 * 1024 * 1024: raise ValueError("Файл слишком большой")
            b = json.loads(self.rfile.read(n) or b"{}")
            route = {"/api/parse": api_parse, "/api/save": api_save, "/api/golive": api_golive, "/api/repeats": api_repeats}.get(urlparse(self.path).path)
            if not route: return self._json(404, {"ok": False, "error": "not found"})
            self._json(200, {"ok": True, **route(b)})
        except (MT.ProjectError, ValueError, RuntimeError, OSError, KeyError, subprocess.CalledProcessError, json.JSONDecodeError) as e:
            msg = e.args[0] if isinstance(e, KeyError) and e.args else str(e)
            self._json(400, {"ok": False, "error": "%s" % msg})
        except Exception as e:
            self._json(500, {"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


def main():
    global PORT
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    except OSError:
        srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    PORT = srv.server_address[1]
    url = "http://127.0.0.1:%d/" % PORT
    print("Окно управления:", url)
    print("Папка сайта:", ROOT)
    print("Закройте это окно или нажмите Ctrl+C, чтобы остановить.")
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
