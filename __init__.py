from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# Hermes loads filesystem plugins from outside the plugin directory, so sibling
# modules are not always on sys.path during gateway startup. Keep the import
# compatible with both plugin loading and direct script/dev usage.
_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

from config import DashboardConfig, config_path, data_dir, effective_config, load_config, public_config, save_config

PLUGIN_NAME = "mnemosyne-dashboard"


def _pid_file() -> Path:
    return data_dir() / "server.pid"


def _runtime_file() -> Path:
    return data_dir() / "runtime.json"


def _json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


def _read_pid() -> int | None:
    try:
        return int(_pid_file().read_text().strip())
    except Exception:
        return None


def _read_runtime() -> dict[str, Any]:
    try:
        return json.loads(_runtime_file().read_text() or "{}")
    except Exception:
        return {}


def _write_runtime(pid: int, cfg: DashboardConfig, log: Path, source: str = "plugin-start") -> None:
    _runtime_file().write_text(json.dumps({
        "pid": pid,
        "host": cfg.host,
        "port": cfg.port,
        "db_path": cfg.db_path,
        "bind_url": cfg.bind_url,
        "local_url": cfg.local_url,
        "log": str(log),
        "source": source,
        "started_at": time.time(),
    }, ensure_ascii=False, indent=2) + "\n")


def _alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _probe_url(cfg: DashboardConfig) -> str:
    # Public endpoint: works even when password auth protects the API.
    return cfg.local_url + "api/auth/status"


def _reachable_detail(cfg: DashboardConfig, timeout: float = 2) -> dict[str, Any]:
    url = _probe_url(cfg)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return {"ok": r.status == 200, "status": r.status, "url": url, "error": ""}
    except urllib.error.HTTPError as e:
        # 401/403 still prove a dashboard process is reachable; auth may protect
        # a mistakenly probed endpoint or future auth-status behaviour.
        return {"ok": e.code in {200, 401, 403}, "status": e.code, "url": url, "error": str(e)}
    except Exception as e:
        return {"ok": False, "status": None, "url": url, "error": str(e)}


def _reachable(cfg: DashboardConfig, timeout: float = 2) -> bool:
    return bool(_reachable_detail(cfg, timeout=timeout)["ok"])


def _listener_pids(port: int) -> list[int]:
    # Best-effort process discovery for stale pid files / launchd-managed copies.
    # lsof is available on macOS and most developer Linux machines; failures are
    # non-fatal because reachability is the source of truth.
    try:
        out = subprocess.check_output(
            ["lsof", "-nP", f"-iTCP:{int(port)}", "-sTCP:LISTEN", "-Fp"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=2,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        return []
    pids: list[int] = []
    for line in out.splitlines():
        if line.startswith("p"):
            try:
                pids.append(int(line[1:]))
            except ValueError:
                pass
    return sorted(set(pids))


def _coerce_cfg(args: dict[str, Any] | None = None) -> DashboardConfig:
    args = args or {}
    return effective_config({
        "host": args.get("host"),
        "port": args.get("port"),
        "db_path": args.get("db_path") or args.get("db"),
        "auth_enabled": args.get("auth_enabled"),
    })


def _status(args=None, **kw):
    cfg = _coerce_cfg(args)
    runtime = _read_runtime()
    pid_file_pid = _read_pid()
    pid = int(runtime.get("pid") or pid_file_pid or 0) or None
    alive = _alive(pid)
    runtime_cfg = effective_config(runtime) if runtime else cfg
    probe = _reachable_detail(runtime_cfg)
    listener_pids = _listener_pids(runtime_cfg.port)
    discovered_pid = next((p for p in listener_pids if p != pid), None)
    reachable = bool(probe["ok"])
    running = alive or reachable
    stale_pid = bool(pid and not alive and reachable)
    effective_pid = pid if alive else discovered_pid
    return _json({
        "ok": True,
        "running": running,
        "reachable": reachable,
        "pid": effective_pid or pid,
        "pid_file_pid": pid_file_pid,
        "stale_pid": stale_pid,
        "listener_pids": listener_pids,
        "probe": probe,
        "bind_url": runtime.get("bind_url") or runtime_cfg.bind_url,
        "local_url": runtime.get("local_url") or runtime_cfg.local_url,
        "config": public_config(cfg),
        "runtime": runtime,
        "config_file": str(config_path()),
        "pid_file": str(_pid_file()),
    })


def _start(args=None, **kw):
    cfg = _coerce_cfg(args)
    pid = _read_pid()
    runtime = _read_runtime()
    if _alive(pid):
        return _json({
            "ok": True,
            "already_running": True,
            "pid": pid,
            "bind_url": runtime.get("bind_url") or cfg.bind_url,
            "local_url": runtime.get("local_url") or cfg.local_url,
            "message": "Stop and start again to apply a different host/port/db_path.",
            "runtime": runtime,
        })

    probe = _reachable_detail(cfg, timeout=1)
    if probe["ok"]:
        listener_pids = _listener_pids(cfg.port)
        discovered_pid = listener_pids[0] if listener_pids else None
        if discovered_pid:
            _pid_file().write_text(str(discovered_pid))
            _write_runtime(discovered_pid, cfg, data_dir() / "server.log", source="plugin-start-repair")
        return _json({
            "ok": True,
            "already_running": True,
            "pid": discovered_pid,
            "stale_pid_repaired": bool(discovered_pid),
            "listener_pids": listener_pids,
            "bind_url": cfg.bind_url,
            "local_url": cfg.local_url,
            "message": "Dashboard is already reachable; repaired stale pid/runtime metadata instead of starting a duplicate.",
            "probe": probe,
        })

    _pid_file().unlink(missing_ok=True)
    _runtime_file().unlink(missing_ok=True)
    server = Path(__file__).parent / "server.py"
    log = data_dir() / "server.log"
    cmd = [sys.executable, str(server), "--host", cfg.host, "--port", str(cfg.port), "--db", cfg.db_path]
    with log.open("ab") as out:
        proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT, start_new_session=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    _pid_file().write_text(str(proc.pid))
    _write_runtime(proc.pid, cfg, log)

    ready = False
    for _ in range(30):
        time.sleep(0.1)
        ready = _reachable(cfg, timeout=1)
        if ready:
            break
    return _json({
        "ok": ready,
        "pid": proc.pid,
        "bind_url": cfg.bind_url,
        "local_url": cfg.local_url,
        "host": cfg.host,
        "port": cfg.port,
        "db_path": cfg.db_path,
        "log": str(log),
        "message": "Mnemosyne dashboard started" if ready else "Server launched but readiness check failed; inspect log",
    })


def _stop(args=None, **kw):
    pid = _read_pid()
    if not pid:
        _runtime_file().unlink(missing_ok=True)
        return _json({"ok": True, "stopped": False, "message": "No pid file found"})
    if not _alive(pid):
        _pid_file().unlink(missing_ok=True)
        _runtime_file().unlink(missing_ok=True)
        return _json({"ok": True, "stopped": False, "message": "Process was already gone"})
    try:
        os.kill(pid, signal.SIGTERM)
        for _ in range(20):
            time.sleep(0.1)
            if not _alive(pid):
                break
        if _alive(pid):
            os.kill(pid, signal.SIGKILL)
        _pid_file().unlink(missing_ok=True)
        _runtime_file().unlink(missing_ok=True)
        return _json({"ok": True, "stopped": True, "pid": pid})
    except Exception as e:
        return _json({"ok": False, "error": str(e), "pid": pid})


def _config(args=None, **kw):
    args = args or {}
    updates = {k: args.get(k) for k in ("host", "port", "db_path", "auth_enabled", "password", "clear_password", "memory_admin_enabled") if args.get(k) not in (None, "")}
    cfg = save_config(**updates) if updates else load_config(create=True)
    return _json({
        "ok": True,
        "config": public_config(cfg),
        "bind_url": cfg.bind_url,
        "local_url": cfg.local_url,
        "config_file": str(config_path()),
        "message": "Config saved. Restart the dashboard process for host/port/db_path changes to take effect." if updates else "Current config.",
    })


def register(ctx):
    cfg = load_config(create=True)
    ctx.register_tool(
        name="mnemosyne_dashboard_start",
        toolset="mnemosyne-dashboard",
        schema={"name":"mnemosyne_dashboard_start","description":"Start the Mnemosyne memory dashboard web UI.","parameters":{"type":"object","properties":{"host":{"type":"string","default":cfg.host,"description":"Bind address. Defaults to config; use 0.0.0.0 to expose on LAN."},"port":{"type":"integer","default":cfg.port,"description":"Bind port. Defaults to config."},"db_path":{"type":"string","default":cfg.db_path,"description":"Path to Mnemosyne SQLite DB. Defaults to config."}}}},
        handler=_start,
        check_fn=lambda: True,
        requires_env=[],
        description="Start Mnemosyne dashboard",
        emoji="🧠",
    )
    ctx.register_tool(
        name="mnemosyne_dashboard_stop",
        toolset="mnemosyne-dashboard",
        schema={"name":"mnemosyne_dashboard_stop","description":"Stop the Mnemosyne memory dashboard web UI.","parameters":{"type":"object","properties":{}}},
        handler=_stop,
        check_fn=lambda: True,
        requires_env=[],
        description="Stop Mnemosyne dashboard",
        emoji="🛑",
    )
    ctx.register_tool(
        name="mnemosyne_dashboard_status",
        toolset="mnemosyne-dashboard",
        schema={"name":"mnemosyne_dashboard_status","description":"Check Mnemosyne memory dashboard status and URL.","parameters":{"type":"object","properties":{"host":{"type":"string","default":cfg.host},"port":{"type":"integer","default":cfg.port},"db_path":{"type":"string","default":cfg.db_path}}}},
        handler=_status,
        check_fn=lambda: True,
        requires_env=[],
        description="Mnemosyne dashboard status",
        emoji="📊",
    )
    ctx.register_tool(
        name="mnemosyne_dashboard_config",
        toolset="mnemosyne-dashboard",
        schema={"name":"mnemosyne_dashboard_config","description":"Read or update default Mnemosyne dashboard config. Restart dashboard after changing host/port/db_path.","parameters":{"type":"object","properties":{"host":{"type":"string","description":"Default bind address, e.g. 127.0.0.1 or 0.0.0.0."},"port":{"type":"integer","description":"Default bind port."},"db_path":{"type":"string","description":"Mnemosyne SQLite DB path."},"auth_enabled":{"type":"boolean","description":"Enable optional password auth."},"password":{"type":"string","description":"Set/change dashboard password."},"clear_password":{"type":"boolean","description":"Disable auth and clear password."},"memory_admin_enabled":{"type":"boolean","description":"Enable password-gated memory maintenance mode."}}}},
        handler=_config,
        check_fn=lambda: True,
        requires_env=[],
        description="Configure Mnemosyne dashboard",
        emoji="⚙️",
    )
