from __future__ import annotations

import argparse
import json
import mimetypes
import time
import tomllib
import urllib.parse
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from config import auth_cookie_value, effective_config, public_config, save_config, verify_password
from dashboard_core import DashboardStore, default_db_path

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
MAX_JSON_BODY_BYTES = 64 * 1024


def _project_version() -> str:
    with (ROOT / "pyproject.toml").open("rb") as fh:
        return tomllib.load(fh)["project"]["version"]


VERSION = _project_version()


def _safe_int(value: str | None, default: int, minimum: int = 1, maximum: int = 1000) -> int:
    try:
        parsed = int(value or default)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))
AUTH_COOKIE = "mnemo_auth"


def _json_bytes(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = f"MnemosyneDashboard/{VERSION}"

    def log_message(self, fmt, *args):
        return

    @property
    def store(self) -> DashboardStore:
        return DashboardStore(getattr(self.server, "db_path", default_db_path()))

    @property
    def cfg(self):
        saved_cfg = getattr(self.server, "saved_config", None)
        if saved_cfg is not None:
            return saved_cfg
        return effective_config({
            "host": getattr(self.server, "bind_host", None),
            "port": getattr(self.server, "bind_port", None),
            "db_path": str(getattr(self.server, "db_path", default_db_path())),
        })

    def _send(self, status: int, body: bytes, ctype: str = "application/json; charset=utf-8", headers: dict[str, str] | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        )
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, obj: Any, status: int = 200, headers: dict[str, str] | None = None):
        self._send(status, _json_bytes(obj), headers=headers)

    def _send_sse(self, events: list[dict[str, Any]]):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        )
        self.end_headers()

        def write_event(name: str, data: dict[str, Any]):
            payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
            self.wfile.write(f"event: {name}\ndata: {payload}\n\n".encode())
            self.wfile.flush()

        try:
            status = self.store.realtime_status()
            write_event("status", status)
            seen_ids: dict[str, str] = {}
            poll_limit = max(25, int(status.get("snapshot_event_count") or 25))
            for event in events:
                memory_id = str(event.get("memory_id") or "")
                if memory_id:
                    seen_ids[memory_id] = str(event.get("live_signature") or "")
                write_event("memory", event)
            for tick in range(900):
                for event in self.store.realtime_event_delta(seen_ids=seen_ids, limit=poll_limit):
                    memory_id = str(event.get("memory_id") or "")
                    if memory_id:
                        seen_ids[memory_id] = str(event.get("live_signature") or "")
                    write_event("memory", event)
                if tick % 8 == 0:
                    write_event("heartbeat", {"ok": True, "ts": time.time()})
                time.sleep(2)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _send_file(self, path: Path):
        try:
            resolved = path.resolve(strict=True)
            static_root = STATIC.resolve(strict=True)
            resolved.relative_to(static_root)
        except Exception:
            self._send_json({"error": "not found"}, 404)
            return
        if not resolved.is_file():
            self._send_json({"error": "not found"}, 404)
            return
        ctype = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
        self._send(200, resolved.read_bytes(), ctype)

    def _params(self) -> dict[str, str]:
        parsed = urllib.parse.urlparse(self.path)
        return {k: v[-1] for k, v in urllib.parse.parse_qs(parsed.query).items()}

    def _json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        if length > MAX_JSON_BODY_BYTES:
            raise ValueError("request body too large")
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    def _authenticated(self) -> bool:
        cfg = self.cfg
        if not cfg.auth_enabled:
            return True
        raw = self.headers.get("Cookie", "")
        jar = cookies.SimpleCookie(raw)
        morsel = jar.get(AUTH_COOKIE)
        return bool(morsel and morsel.value == auth_cookie_value(cfg))

    def _auth_status(self) -> dict[str, Any]:
        cfg = self.cfg
        return {
            "auth_enabled": cfg.auth_enabled,
            "has_password": cfg.has_password,
            "authenticated": self._authenticated(),
            "config": public_config(cfg),
        }

    def _require_auth(self, path: str) -> bool:
        public_paths = {"/api/auth/status", "/api/auth/login"}
        if path in public_paths or path == "/" or path.startswith("/static/"):
            return True
        if self._authenticated():
            return True
        self._send_json({"error": "auth required", **self._auth_status()}, 401)
        return False

    def _require_admin(self) -> bool:
        cfg = self.cfg
        if not cfg.memory_admin_enabled:
            self._send_json({"error": "memory admin mode is disabled", "config": public_config(cfg)}, 403)
            return False
        local_request = cfg.host in {"127.0.0.1", "localhost", "::1"} and self.client_address[0] in {"127.0.0.1", "::1"}
        if local_request:
            return True
        if not cfg.auth_enabled or not cfg.has_password or not self._authenticated():
            self._send_json({"error": "password auth is required for memory admin mode on LAN/non-local hosts", **self._auth_status()}, 401)
            return False
        return True

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/" or parsed.path == "/favicon.ico" or parsed.path.startswith("/static/") or parsed.path.startswith("/api/"):
            self.send_response(200)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        q = self._params()
        try:
            if path == "/":
                return self._send_file(STATIC / "index.html")
            if path == "/favicon.ico":
                return self._send_file(STATIC / "favicon.svg")
            if path.startswith("/static/"):
                rel = urllib.parse.unquote(path.removeprefix("/static/"))
                if rel.startswith(("/", "\\")):
                    return self._send_json({"error": "bad path"}, 400)
                return self._send_file(STATIC / rel)
            if not self._require_auth(path):
                return
            if path == "/api/auth/status":
                return self._send_json(self._auth_status())
            if path == "/api/health":
                return self._send_json({"ok": True, "service": "mnemosyne-dashboard", "read_only": not self.cfg.memory_admin_enabled, "config": public_config(self.cfg)})
            if path == "/api/config":
                return self._send_json({"ok": True, "config": public_config(self.cfg)})
            if path == "/api/diagnostics":
                return self._send_json(self.store.diagnostics())
            if path == "/api/realtime/status":
                return self._send_json(self.store.realtime_status())
            if path == "/api/realtime/events":
                return self._send_sse(self.store.realtime_event_snapshot(limit=_safe_int(q.get("limit"), 25, maximum=100)))
            if path == "/api/admin/audit":
                if not self._require_admin():
                    return
                return self._send_json({"items": self.store.audit_log(limit=_safe_int(q.get("limit"), 100, maximum=1000))})
            if path == "/api/stats":
                return self._send_json(self.store.stats())
            if path == "/api/digest/today":
                return self._send_json(self.store.today_digest(day=q.get("day", ""), limit=_safe_int(q.get("limit"), 80, maximum=300)))
            if path == "/api/review":
                return self._send_json(self.store.review_queues(
                    queue=q.get("queue", "contaminated"), q=q.get("q", ""),
                    min_importance=q.get("min_importance", ""),
                    limit=_safe_int(q.get("limit"), 100, maximum=500),
                    offset=_safe_int(q.get("offset"), 0, minimum=0, maximum=100000),
                ))
            if path == "/api/lifecycle":
                return self._send_json(self.store.lifecycle_dashboard(limit=_safe_int(q.get("limit"), 50, maximum=200)))
            if path == "/api/profile/inferred":
                return self._send_json(self.store.inferred_profile(limit_per_section=_safe_int(q.get("limit"), 10, maximum=30)))
            if path == "/api/patterns":
                return self._send_json(self.store.pattern_insights(limit=_safe_int(q.get("limit"), 10, maximum=30)))
            if path == "/api/constellation":
                return self._send_json(self.store.constellation(limit=_safe_int(q.get("limit"), 240, minimum=40, maximum=600)))
            if path == "/api/search":
                return self._send_json(self.store.global_search(q=q.get("q", ""), limit=_safe_int(q.get("limit"), 30, maximum=100)))
            if path == "/api/recall-debug":
                return self._send_json(self.store.recall_debug(q=q.get("q", ""), limit=_safe_int(q.get("limit"), 20, maximum=100)))
            if path == "/api/timeline":
                return self._send_json(self.store.timeline(q=q.get("q", ""), group=q.get("group", "day"), limit=_safe_int(q.get("limit"), 300, maximum=1000)))
            if path == "/api/memories":
                return self._send_json({"items": self.store.list_memories(
                    kind=q.get("kind", "all"), q=q.get("q", ""), source=q.get("source", ""),
                    scope=q.get("scope", ""), session_id=q.get("session_id", ""), sort=q.get("sort", "recent"),
                    status=q.get("status", "active"), veracity=q.get("veracity", ""),
                    degradation_tier=q.get("degradation_tier", ""), contaminated_only=q.get("contaminated_only", ""),
                    degraded_only=q.get("degraded_only", ""), due_for_degradation=q.get("due_for_degradation", ""),
                    limit=_safe_int(q.get("limit"), 100, maximum=500), offset=_safe_int(q.get("offset"), 0, minimum=0, maximum=100000),
                )})
            if path == "/api/memory":
                mid = q.get("id", "")
                item = self.store.get_memory(mid) if mid else None
                return self._send_json({"item": item}, 200 if item else 404)
            if path == "/api/session":
                return self._send_json(self.store.session_detail(q.get("id", ""), limit=_safe_int(q.get("limit"), 200, maximum=500)))
            if path == "/api/triples":
                return self._send_json({"items": self.store.triples(
                    q=q.get("q", ""), subject=q.get("subject", ""), predicate=q.get("predicate", ""), object_=q.get("object", ""),
                    limit=_safe_int(q.get("limit"), 200, maximum=1000),
                )})
            if path == "/api/graph":
                return self._send_json(self.store.graph(q=q.get("q", ""), limit=_safe_int(q.get("limit"), 300, maximum=1000)))
            if path == "/api/consolidations":
                return self._send_json({"items": self.store.consolidations(q=q.get("q", ""), limit=_safe_int(q.get("limit"), 100, maximum=500))})
            if path == "/api/memoria/stats":
                return self._send_json(self.store.memoria_stats())
            if path == "/api/memoria/facts":
                return self._send_json({"items": self.store.memoria_facts(q=q.get("q", ""), limit=_safe_int(q.get("limit"), 200, maximum=1000), offset=_safe_int(q.get("offset"), 0, minimum=0, maximum=100000))})
            if path == "/api/memoria/timelines":
                return self._send_json({"items": self.store.memoria_timelines(q=q.get("q", ""), limit=_safe_int(q.get("limit"), 200, maximum=1000), offset=_safe_int(q.get("offset"), 0, minimum=0, maximum=100000))})
            if path == "/api/memoria/instructions":
                return self._send_json({"items": self.store.memoria_instructions(q=q.get("q", ""), limit=_safe_int(q.get("limit"), 200, maximum=1000), offset=_safe_int(q.get("offset"), 0, minimum=0, maximum=100000))})
            if path == "/api/memoria/kg":
                return self._send_json({"items": self.store.memoria_kg(q=q.get("q", ""), limit=_safe_int(q.get("limit"), 200, maximum=1000), offset=_safe_int(q.get("offset"), 0, minimum=0, maximum=100000))})
            if path == "/api/memoria/preferences":
                return self._send_json({"items": self.store.memoria_preferences(q=q.get("q", ""), limit=_safe_int(q.get("limit"), 200, maximum=1000), offset=_safe_int(q.get("offset"), 0, minimum=0, maximum=100000))})
            return self._send_json({"error": "not found"}, 404)
        except Exception as e:
            return self._send_json({"error": str(e)}, 500)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            body = self._json_body()
            if path == "/api/auth/login":
                cfg = self.cfg
                if not cfg.auth_enabled:
                    return self._send_json({"ok": True, "auth_enabled": False})
                if verify_password(str(body.get("password") or ""), cfg):
                    return self._send_json(
                        {"ok": True, **self._auth_status()},
                        headers={"Set-Cookie": f"{AUTH_COOKIE}={auth_cookie_value(cfg)}; Path=/; SameSite=Lax; HttpOnly"},
                    )
                return self._send_json({"ok": False, "error": "invalid password"}, 403)
            if not self._require_auth(path):
                return
            if path == "/api/auth/logout":
                return self._send_json({"ok": True}, headers={"Set-Cookie": f"{AUTH_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly"})
            if path == "/api/config":
                allowed = {"host", "port", "db_path", "auth_enabled", "password", "clear_password", "memory_admin_enabled"}
                updates = {k: body.get(k) for k in allowed if k in body}
                cfg = save_config(**updates)
                self.server.saved_config = cfg
                return self._send_json({"ok": True, "config": public_config(cfg), "message": "Saved. Auth changes take effect immediately; host/port/db changes require restart."})
            if path == "/api/admin/backup":
                if not self._require_admin():
                    return
                return self._send_json({"ok": True, "backup": self.store.backup_database()})
            if path == "/api/admin/memory/invalidate":
                if not self._require_admin():
                    return
                return self._send_json(self.store.invalidate_memory(str(body.get("memory_id") or ""), backup=bool(body.get("backup", True))))
            if path == "/api/admin/memory/importance":
                if not self._require_admin():
                    return
                return self._send_json(self.store.set_memory_importance(str(body.get("memory_id") or ""), body.get("importance"), backup=bool(body.get("backup", True))))
            if path == "/api/admin/memory/veracity":
                if not self._require_admin():
                    return
                return self._send_json(self.store.set_memory_veracity(str(body.get("memory_id") or ""), str(body.get("veracity") or ""), backup=bool(body.get("backup", True))))
            if path == "/api/admin/memory/expiry":
                if not self._require_admin():
                    return
                return self._send_json(self.store.set_memory_expiry(str(body.get("memory_id") or ""), str(body.get("valid_until") or ""), backup=bool(body.get("backup", True))))
            if path == "/api/admin/memory/supersede":
                if not self._require_admin():
                    return
                return self._send_json(self.store.supersede_memory(str(body.get("memory_id") or ""), str(body.get("content") or ""), body.get("importance"), backup=bool(body.get("backup", True))))
            return self._send_json({"error": "not found"}, 404)
        except Exception as e:
            return self._send_json({"ok": False, "error": str(e)}, 500)


def main():
    ap = argparse.ArgumentParser(description="LAN-friendly Mnemosyne memory dashboard with read-only browsing by default")
    ap.add_argument("--host", default=None, help="Bind address, e.g. 127.0.0.1 or 0.0.0.0. Defaults to plugin config.")
    ap.add_argument("--port", type=int, default=None, help="Bind port. Defaults to plugin config.")
    ap.add_argument("--db", default=None, help="Mnemosyne SQLite DB path. Defaults to plugin config.")
    args = ap.parse_args()
    cfg = effective_config({"host": args.host, "port": args.port, "db_path": args.db})
    httpd = ThreadingHTTPServer((cfg.host, cfg.port), Handler)
    httpd.db_path = Path(cfg.db_path)
    httpd.bind_host = cfg.host
    httpd.bind_port = cfg.port
    print(f"Mnemosyne dashboard listening on {cfg.bind_url}", flush=True)
    if cfg.host in {"0.0.0.0", "::"}:
        print(f"Local probe URL: {cfg.local_url}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
