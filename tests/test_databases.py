import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import config as cfgmod  # noqa: E402
import dashboard_core as dc  # noqa: E402


def _touch_db(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE IF NOT EXISTS t (id INTEGER)")
    con.commit()
    con.close()
    return path


def test_discover_includes_active_and_dedupes(tmp_path):
    active = _touch_db(tmp_path / "a" / "mnemosyne.db")
    out = dc.discover_databases(active_db=str(active), configured=[str(active), str(active)])
    paths = [d["path"] for d in out]
    assert str(active.resolve()) in paths
    assert len(paths) == len(set(paths))  # deduped
    assert all("label" in d and "path" in d and "size_bytes" in d for d in out)


def test_discover_marks_active(tmp_path):
    active = _touch_db(tmp_path / "mnemosyne.db")
    out = dc.discover_databases(active_db=str(active), configured=[str(active)])
    assert any(d["path"] == str(active.resolve()) and d["active"] for d in out)


def test_discover_skips_missing_files(tmp_path):
    active = _touch_db(tmp_path / "active" / "mnemosyne.db")
    missing = tmp_path / "nope" / "mnemosyne.db"
    out = dc.discover_databases(active_db=str(active), configured=[str(missing)])
    paths = [d["path"] for d in out]
    assert str(missing.resolve()) not in paths
    assert str(active.resolve()) in paths


def test_discover_auto_finds_profiles(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    monkeypatch.setenv("HERMES_HOME", str(home))
    coordinator = _touch_db(home / "mnemosyne" / "data" / "mnemosyne.db")
    pm = _touch_db(home / "profiles" / "project-manager" / "mnemosyne" / "data" / "mnemosyne.db")
    dev = _touch_db(home / "profiles" / "developer" / "mnemosyne" / "data" / "mnemosyne.db")
    out = dc.discover_databases(active_db=str(coordinator))
    by_path = {d["path"]: d for d in out}
    assert by_path[str(coordinator.resolve())]["label"] == "coordinator"
    assert by_path[str(coordinator.resolve())]["active"] is True
    assert by_path[str(pm.resolve())]["label"] == "project-manager"
    assert by_path[str(dev.resolve())]["label"] == "developer"


def test_label_for_db_profile_and_coordinator(tmp_path):
    home = tmp_path / "hermes"
    coordinator = home / "mnemosyne" / "data" / "mnemosyne.db"
    pm = home / "profiles" / "project-manager" / "mnemosyne" / "data" / "mnemosyne.db"
    assert dc._label_for_db(coordinator, home) == "coordinator"
    assert dc._label_for_db(pm, home) == "project-manager"


def test_db_paths_config_round_trips(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    monkeypatch.delenv("MNEMOSYNE_DASHBOARD_CONFIG", raising=False)
    one = tmp_path / "brains" / "one.db"
    two = tmp_path / "brains" / "two.db"
    saved = cfgmod.save_config(db_paths=[str(one), str(two), str(one)])
    assert saved.db_paths == (str(one), str(two))  # deduped, ordered

    reloaded = cfgmod.load_config(create=True)
    assert reloaded.db_paths == (str(one), str(two))
    assert cfgmod.public_config(reloaded)["db_paths"] == [str(one), str(two)]


def test_db_paths_defaults_to_empty(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    monkeypatch.delenv("MNEMOSYNE_DASHBOARD_CONFIG", raising=False)
    cfg = cfgmod.load_config(create=True)
    assert cfg.db_paths == ()
    assert cfgmod.public_config(cfg)["db_paths"] == []
