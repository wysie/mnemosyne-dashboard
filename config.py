from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import socket
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

PLUGIN_NAME = "mnemosyne-dashboard"
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8765


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))


def default_db_path() -> Path:
    candidates = [
        os.environ.get("MNEMOSYNE_DASHBOARD_DB"),
        os.environ.get("MNEMOSYNE_DB_PATH"),
        os.environ.get("MNEMOSYNE_DB"),
        hermes_home() / "mnemosyne" / "data" / "mnemosyne.db",
        hermes_home() / "mnemosyne.db",
        Path.home() / ".mnemosyne" / "mnemosyne.db",
    ]
    expanded = [Path(c).expanduser() for c in candidates if c]
    for path in expanded:
        if path.exists():
            return path
    return expanded[3] if len(expanded) > 3 else hermes_home() / "mnemosyne" / "data" / "mnemosyne.db"


def lan_host() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            host = s.getsockname()[0]
        return "" if host.startswith("127.") else host
    except OSError:
        return ""


def data_dir() -> Path:
    path = hermes_home() / "plugin-data" / PLUGIN_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def config_path() -> Path:
    override = os.environ.get("MNEMOSYNE_DASHBOARD_CONFIG")
    return Path(override).expanduser() if override else data_dir() / "config.json"


@dataclass(frozen=True)
class DashboardConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    db_path: str = ""
    auth_enabled: bool = False
    password_hash: str = ""
    password_salt: str = ""
    auth_secret: str = ""
    memory_admin_enabled: bool = False
    db_paths: tuple[str, ...] = ()

    @property
    def bind_url(self) -> str:
        return f"http://{self.host}:{self.port}/"

    @property
    def local_probe_host(self) -> str:
        return "127.0.0.1" if self.host in {"0.0.0.0", "::"} else self.host

    @property
    def local_url(self) -> str:
        return f"http://{self.local_probe_host}:{self.port}/"

    @property
    def has_password(self) -> bool:
        return bool(self.password_hash and self.password_salt)


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    if not password:
        raise ValueError("password cannot be empty")
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 200_000)
    return digest.hex(), salt


def verify_password(password: str, cfg: DashboardConfig) -> bool:
    if not cfg.has_password or not password:
        return False
    digest, _ = hash_password(password, cfg.password_salt)
    return hmac.compare_digest(digest, cfg.password_hash)


def auth_cookie_value(cfg: DashboardConfig) -> str:
    secret = cfg.auth_secret or "missing-secret"
    return hmac.new(secret.encode("utf-8"), b"mnemosyne-dashboard", hashlib.sha256).hexdigest()


def _defaults() -> dict[str, Any]:
    return {
        "host": DEFAULT_HOST,
        "port": DEFAULT_PORT,
        "db_path": str(default_db_path()),
        "auth_enabled": False,
        "password_hash": "",
        "password_salt": "",
        "auth_secret": secrets.token_urlsafe(32),
        "memory_admin_enabled": False,
        "db_paths": [],
    }


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on", "enabled"}
    return bool(value)


def _db_paths(value: Any) -> tuple[str, ...]:
    if not value:
        return ()
    if isinstance(value, str):
        value = [value]
    seen: set[str] = set()
    out: list[str] = []
    for raw in value:
        text = str(raw or "").strip()
        if not text:
            continue
        expanded = str(Path(text).expanduser())
        if expanded not in seen:
            seen.add(expanded)
            out.append(expanded)
    return tuple(out)


def _validate(raw: dict[str, Any]) -> DashboardConfig:
    merged = {**_defaults(), **{k: v for k, v in raw.items() if v is not None}}
    host = str(merged.get("host") or DEFAULT_HOST).strip()
    if not host:
        raise ValueError("host cannot be empty")
    try:
        port = int(merged.get("port") or DEFAULT_PORT)
    except Exception as exc:
        raise ValueError("port must be an integer") from exc
    if not (1 <= port <= 65535):
        raise ValueError("port must be between 1 and 65535")
    db_path = str(Path(str(merged.get("db_path") or default_db_path())).expanduser())
    auth_secret = str(merged.get("auth_secret") or secrets.token_urlsafe(32))
    return DashboardConfig(
        host=host,
        port=port,
        db_path=db_path,
        auth_enabled=_bool(merged.get("auth_enabled", False)),
        password_hash=str(merged.get("password_hash") or ""),
        password_salt=str(merged.get("password_salt") or ""),
        auth_secret=auth_secret,
        memory_admin_enabled=_bool(merged.get("memory_admin_enabled", False)),
        db_paths=_db_paths(merged.get("db_paths")),
    )


def _write_config(cfg: DashboardConfig) -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(cfg), ensure_ascii=False, indent=2) + "\n")


def load_config(create: bool = True) -> DashboardConfig:
    path = config_path()
    raw: dict[str, Any] = {}
    needs_write = False
    if path.exists():
        raw = json.loads(path.read_text() or "{}")
    elif create:
        raw = _defaults()
        needs_write = True
    env_overrides = {
        "host": os.environ.get("MNEMOSYNE_DASHBOARD_HOST"),
        "port": os.environ.get("MNEMOSYNE_DASHBOARD_PORT"),
        "db_path": os.environ.get("MNEMOSYNE_DASHBOARD_DB"),
        "auth_enabled": os.environ.get("MNEMOSYNE_DASHBOARD_AUTH_ENABLED"),
    }
    raw.update({k: v for k, v in env_overrides.items() if v not in (None, "")})
    cfg = _validate(raw)
    if create and (needs_write or not path.exists() or not raw.get("auth_secret")):
        _write_config(cfg)
    return cfg


def save_config(**updates: Any) -> DashboardConfig:
    current = asdict(load_config(create=True))
    password = updates.pop("password", None)
    clear_password = _bool(updates.pop("clear_password", False))
    current.update({k: v for k, v in updates.items() if v not in (None, "")})
    if password:
        current["password_hash"], current["password_salt"] = hash_password(str(password))
    if clear_password:
        current["password_hash"] = ""
        current["password_salt"] = ""
        current["auth_enabled"] = False
        host = str(current.get("host") or DEFAULT_HOST).strip()
        if host not in {"127.0.0.1", "localhost", "::1"}:
            current["memory_admin_enabled"] = False
    cfg = _validate(current)
    if cfg.auth_enabled and not cfg.has_password:
        raise ValueError("set a password before enabling auth")
    local_only = cfg.host in {"127.0.0.1", "localhost", "::1"}
    if cfg.memory_admin_enabled and not local_only and (not cfg.auth_enabled or not cfg.has_password):
        raise ValueError("enable password auth before enabling memory admin mode on LAN/non-local hosts")
    _write_config(cfg)
    return cfg


def public_config(cfg: DashboardConfig | None = None) -> dict[str, Any]:
    cfg = cfg or load_config(create=True)
    lan = lan_host() if cfg.host in {"0.0.0.0", "::"} else ""
    return {
        "host": cfg.host,
        "port": cfg.port,
        "db_path": cfg.db_path,
        "auth_enabled": cfg.auth_enabled,
        "has_password": cfg.has_password,
        "bind_url": cfg.bind_url,
        "local_url": cfg.local_url,
        "lan_url": f"http://{lan}:{cfg.port}/" if lan else "",
        "memory_admin_enabled": cfg.memory_admin_enabled,
        "db_paths": list(cfg.db_paths),
    }


def effective_config(overrides: dict[str, Any] | None = None) -> DashboardConfig:
    cfg = asdict(load_config(create=True))
    if overrides:
        cfg.update({k: v for k, v in overrides.items() if v not in (None, "")})
    return _validate(cfg)
