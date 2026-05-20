from __future__ import annotations

import importlib.metadata
import json
import os
import re
import shutil
import sqlite3
import uuid
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

try:
    from mnemosyne.core import PatternDetector
except Exception:  # pragma: no cover - dashboard degrades when package is unavailable
    PatternDetector = None


def plugin_data_dir() -> Path:
    home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
    path = home / "plugin-data" / "mnemosyne-dashboard"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _utc_now() -> str:
    return datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="seconds")


def _is_expired(value: object, now: str | None = None) -> bool:
    text = str(value or "").strip()
    return bool(text and text <= (now or _utc_now()))


DEGRADATION_LABELS = {1: "hot", 2: "warm", 3: "cold"}
DEGRADATION_WEIGHTS = {
    1: float(os.environ.get("MNEMOSYNE_TIER1_WEIGHT", "1.0")),
    2: float(os.environ.get("MNEMOSYNE_TIER2_WEIGHT", "0.5")),
    3: float(os.environ.get("MNEMOSYNE_TIER3_WEIGHT", "0.25")),
}
VERACITY_WEIGHTS = {
    "stated": float(os.environ.get("MNEMOSYNE_STATED_WEIGHT", "1.0")),
    "inferred": float(os.environ.get("MNEMOSYNE_INFERRED_WEIGHT", "0.7")),
    "tool": float(os.environ.get("MNEMOSYNE_TOOL_WEIGHT", "0.5")),
    "imported": float(os.environ.get("MNEMOSYNE_IMPORTED_WEIGHT", "0.6")),
    "unknown": float(os.environ.get("MNEMOSYNE_UNKNOWN_WEIGHT", "0.8")),
}
CONTAMINATED_VERACITIES = {"inferred", "tool", "imported", "unknown"}


def _degradation_label(value: object) -> str:
    try:
        return DEGRADATION_LABELS.get(int(value or 1), "hot")
    except (TypeError, ValueError):
        return "hot"


def _truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def default_db_path() -> Path:
    home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
    return home / "mnemosyne" / "data" / "mnemosyne.db"


class DashboardStore:
    """Read-only access helpers for the local Mnemosyne SQLite store."""

    def __init__(self, db_path: str | Path | None = None):
        self.db_path = Path(db_path) if db_path else default_db_path()

    def connect(self) -> sqlite3.Connection:
        if not self.db_path.exists():
            raise FileNotFoundError(f"Mnemosyne DB not found: {self.db_path}")
        uri = f"file:{self.db_path}?mode=ro"
        con = sqlite3.connect(uri, uri=True, timeout=10)
        con.row_factory = sqlite3.Row
        con.create_function("REGEXP", 2, self._regexp)
        return con

    def connect_rw(self) -> sqlite3.Connection:
        if not self.db_path.exists():
            raise FileNotFoundError(f"Mnemosyne DB not found: {self.db_path}")
        con = sqlite3.connect(str(self.db_path), timeout=10)
        con.row_factory = sqlite3.Row
        con.create_function("REGEXP", 2, self._regexp)
        con.execute("PRAGMA busy_timeout=5000")
        return con

    @staticmethod
    def _tables(con: sqlite3.Connection) -> set[str]:
        return {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    @staticmethod
    def _columns(con: sqlite3.Connection, table: str) -> set[str]:
        return {r[1] for r in con.execute(f"PRAGMA table_info({table})")}

    @staticmethod
    def _memory_select_columns(columns: set[str], memory_kind: str) -> str:
        fields = [
            "id", "content", "source", "timestamp", "session_id", "importance", "metadata_json",
            "created_at", "recall_count", "last_recalled", "valid_until", "superseded_by",
            "scope", "author_id", "author_type", "channel_id",
        ]
        select = [name if name in columns else f"NULL AS {name}" for name in fields]
        select.append("veracity" if "veracity" in columns else "'unknown' AS veracity")
        if memory_kind == "episodic":
            select.append("tier AS degradation_tier" if "tier" in columns else "1 AS degradation_tier")
            select.append("degraded_at" if "degraded_at" in columns else "NULL AS degraded_at")
        else:
            select.append("NULL AS degradation_tier")
            select.append("NULL AS degraded_at")
        return ", ".join(select)

    @staticmethod
    def _enrich_memory(d: dict[str, Any], memory_kind: str) -> dict[str, Any]:
        d["memory_kind"] = memory_kind
        d["tier"] = memory_kind  # Backwards-compatible alias for pre-v2.3 dashboard clients.
        veracity = str(d.get("veracity") or "unknown").lower()
        if veracity not in VERACITY_WEIGHTS:
            veracity = "unknown"
        d["veracity"] = veracity
        if memory_kind == "episodic":
            raw_degradation_tier = d.get("degradation_tier", d.get("tier"))
            try:
                degradation_tier = int(raw_degradation_tier or 1)
            except (TypeError, ValueError):
                degradation_tier = 1
            degradation_tier = degradation_tier if degradation_tier in DEGRADATION_LABELS else 1
        else:
            degradation_tier = None
        d["degradation_tier"] = degradation_tier
        d["degradation_label"] = _degradation_label(degradation_tier) if degradation_tier else None
        d["trust_weight"] = VERACITY_WEIGHTS.get(veracity, VERACITY_WEIGHTS["unknown"])
        d["degradation_weight"] = DEGRADATION_WEIGHTS.get(degradation_tier or 1, 1.0) if memory_kind == "episodic" else 1.0
        d["effective_memory_weight"] = round(float(d["trust_weight"]) * float(d["degradation_weight"]), 4)
        d["contaminated"] = veracity in CONTAMINATED_VERACITIES
        return d

    @staticmethod
    def _dict(row: sqlite3.Row) -> dict[str, Any]:
        d = dict(row)
        if d.get("metadata_json"):
            try:
                d["metadata"] = json.loads(d["metadata_json"])
            except Exception:
                d["metadata"] = None
        d["status"] = DashboardStore._memory_status(d)
        return d

    @staticmethod
    def _memory_status(item: dict[str, Any]) -> str:
        if str(item.get("superseded_by") or "").strip():
            return "superseded"
        if _is_expired(item.get("valid_until")):
            return "expired"
        return "active"

    @staticmethod
    def _regexp(pattern: str, value: object) -> int:
        if value is None:
            return 0
        return 1 if re.search(pattern, str(value), flags=re.IGNORECASE) else 0

    @staticmethod
    def _search_terms(value: str) -> list[str]:
        return [term for term in re.findall(r"[\w-]+", value or "") if term]

    @classmethod
    def _prefix_pattern(cls, value: str) -> str:
        terms = cls._search_terms(value)
        if not terms:
            return r"a^"
        lookaheads = "".join(rf"(?=.*(?:^|[^\w]){re.escape(term)})" for term in terms)
        return lookaheads + r".*"

    def realtime_status(self) -> dict[str, Any]:
        """Feature-detect read-only realtime capabilities for the dashboard UI."""
        event_types: list[str] = []
        streaming_supported = False
        deltasync_supported = False
        mnemosyne_version = "unknown"
        try:
            mnemosyne_version = importlib.metadata.version("mnemosyne-memory")
        except Exception:
            pass
        try:
            from mnemosyne.core.streaming import DeltaSync, EventType, MemoryStream  # type: ignore

            streaming_supported = bool(MemoryStream and EventType)
            deltasync_supported = bool(DeltaSync)
            event_types = [evt.name for evt in EventType]
        except Exception:
            event_types = []

        path = self.db_path.expanduser()
        stat = path.stat() if path.exists() else None
        return {
            "ok": True,
            "read_only": True,
            "live_enabled": streaming_supported,
            "streaming_supported": streaming_supported,
            "deltasync_supported": deltasync_supported,
            "mnemosyne_version": mnemosyne_version,
            "event_types": event_types,
            "deltasync_tables": ["working_memory", "episodic_memory"] if deltasync_supported else [],
            "db_path": str(path),
            "db_modified_at": datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(timespec="seconds") if stat else "",
            "snapshot_event_count": len(self.realtime_event_snapshot(limit=25)) if path.exists() else 0,
            "transport": "sse",
            "payload_policy": "private dashboard payload; memory content is streamed to authenticated dashboard clients, metadata_json is withheld",
        }

    @staticmethod
    def _realtime_signature(event: dict[str, Any]) -> str:
        payload = {
            "content": event.get("content") or "",
            "timestamp": event.get("timestamp") or "",
            "status": event.get("status") or "active",
            "recall_count": int(event.get("recall_count") or 0),
            "last_recalled": event.get("last_recalled") or "",
            "superseded_by": event.get("superseded_by") or "",
            "valid_until": event.get("valid_until") or "",
            "summary_of": event.get("summary_of") or "",
        }
        return json.dumps(payload, sort_keys=True, separators=(",", ":"))

    def _realtime_event_rows(self, limit: int = 25, include_inactive: bool = False) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit or 25), 200))
        events: list[dict[str, Any]] = []
        with self.connect() as con:
            tables = self._tables(con)
            for table, memory_kind in (("working_memory", "working"), ("episodic_memory", "episodic")):
                if table not in tables:
                    continue
                columns = self._columns(con, table)
                veracity_expr = "COALESCE(veracity, 'unknown')" if "veracity" in columns else "'unknown'"
                source_expr = "COALESCE(source, '')" if "source" in columns else "''"
                timestamp_expr = "COALESCE(timestamp, created_at, '')" if "created_at" in columns else "COALESCE(timestamp, '')"
                importance_expr = "COALESCE(importance, 0)" if "importance" in columns else "0"
                recall_expr = "COALESCE(recall_count, 0)" if "recall_count" in columns else "0"
                last_recalled_expr = "COALESCE(last_recalled, '')" if "last_recalled" in columns else "''"
                valid_until_expr = "valid_until" if "valid_until" in columns else "NULL AS valid_until"
                superseded_expr = "superseded_by" if "superseded_by" in columns else "NULL AS superseded_by"
                summary_expr = "summary_of" if "summary_of" in columns else "NULL AS summary_of"
                where = "1=1" if include_inactive else "(valid_until IS NULL OR valid_until > ?) AND superseded_by IS NULL"
                params: tuple[Any, ...] = (limit,) if include_inactive else (_utc_now(), limit)
                rows = con.execute(
                    f"""
                    SELECT id, content, {source_expr} AS source, {timestamp_expr} AS timestamp,
                           {importance_expr} AS importance, {veracity_expr} AS veracity,
                           {recall_expr} AS recall_count, {last_recalled_expr} AS last_recalled,
                           {valid_until_expr}, {superseded_expr}, {summary_expr}
                    FROM {table}
                    WHERE {where}
                    ORDER BY timestamp DESC
                    LIMIT ?
                    """,
                    params,
                ).fetchall()
                for row in rows:
                    d = dict(row)
                    event = {
                        "event_type": "MEMORY_SNAPSHOT",
                        "memory_id": d.get("id"),
                        "memory_kind": memory_kind,
                        "content": d.get("content") or "",
                        "source": d.get("source") or "",
                        "timestamp": d.get("timestamp") or "",
                        "importance": float(d.get("importance") or 0),
                        "veracity": str(d.get("veracity") or "unknown").lower(),
                        "recall_count": int(d.get("recall_count") or 0),
                        "last_recalled": d.get("last_recalled") or "",
                        "valid_until": d.get("valid_until") or "",
                        "superseded_by": d.get("superseded_by") or "",
                        "summary_of": d.get("summary_of") or "",
                    }
                    event["status"] = self._memory_status(event)
                    event["live_signature"] = self._realtime_signature(event)
                    events.append(event)
        events.sort(key=lambda e: e.get("timestamp") or "", reverse=True)
        return events[:limit]

    def realtime_event_snapshot(self, limit: int = 25) -> list[dict[str, Any]]:
        """Return a private-dashboard event snapshot for SSE/bootstrap use."""
        return self._realtime_event_rows(limit=limit, include_inactive=False)

    def realtime_event_delta(self, seen_ids: set[str] | list[str] | tuple[str, ...] | dict[str, str], limit: int = 25) -> list[dict[str, Any]]:
        """Poll the DB for new or changed memories and map them to Mnemosyne-style event types."""
        seen_state = {str(k): str(v) for k, v in seen_ids.items()} if isinstance(seen_ids, dict) else {}
        seen = set(seen_state) if seen_state else {str(item) for item in (seen_ids or []) if item}
        delta: list[dict[str, Any]] = []
        for event in self._realtime_event_rows(limit=limit, include_inactive=True):
            memory_id = str(event.get("memory_id") or "")
            if not memory_id:
                continue
            next_event = dict(event)
            if memory_id not in seen:
                next_event["event_type"] = "MEMORY_CONSOLIDATED" if next_event.get("summary_of") else "MEMORY_ADDED"
                delta.append(next_event)
                continue
            if not seen_state or seen_state.get(memory_id) == str(event.get("live_signature") or ""):
                continue
            if next_event.get("status") != "active":
                next_event["event_type"] = "MEMORY_INVALIDATED"
            elif int(next_event.get("recall_count") or 0) > 0 and next_event.get("last_recalled"):
                next_event["event_type"] = "MEMORY_RECALLED"
            else:
                next_event["event_type"] = "MEMORY_UPDATED"
            delta.append(next_event)
        return delta

    def diagnostics(self) -> dict[str, Any]:
        path = self.db_path.expanduser()
        info: dict[str, Any] = {
            "db_path": str(path),
            "exists": path.exists(),
            "readable": os.access(path, os.R_OK) if path.exists() else False,
            "read_only": True,
            "size_bytes": 0,
            "modified_at": "",
            "tables": [],
            "table_counts": {},
            "ok": False,
            "error": "",
        }
        if not path.exists():
            info["error"] = "Mnemosyne DB not found at configured path."
            return info
        try:
            stat = path.stat()
            info["size_bytes"] = stat.st_size
            info["modified_at"] = __import__("datetime").datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")
            with self.connect() as con:
                tables = sorted(self._tables(con))
                info["tables"] = tables
                info["table_errors"] = {}
                for table in tables:
                    if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", table):
                        try:
                            info["table_counts"][table] = int(con.execute(f"SELECT count(*) FROM {table}").fetchone()[0])
                        except Exception as exc:
                            info["table_errors"][table] = str(exc)
                required = {"working_memory", "episodic_memory", "triples", "consolidation_log"}
                info["missing_expected_tables"] = sorted(required - set(tables))
                info["ok"] = not info["missing_expected_tables"]
        except Exception as exc:
            info["error"] = str(exc)
        return info

    def stats(self) -> dict[str, Any]:
        with self.connect() as con:
            tables = self._tables(con)
            counts: dict[str, int] = {}
            for table in ["working_memory", "episodic_memory", "memories", "triples", "consolidation_log", "scratchpad"]:
                if table in tables:
                    counts[table] = int(con.execute(f"SELECT count(*) FROM {table}").fetchone()[0])
                else:
                    counts[table] = 0

            by_source_raw = []
            by_scope_raw = []
            by_session_raw = []
            veracity_counts: Counter[str] = Counter()
            contaminated_total = 0
            contaminated_high = 0
            degradation_counts: Counter[str] = Counter({label: 0 for label in DEGRADATION_LABELS.values()})
            degraded_count = 0
            due_tier2 = 0
            due_tier3 = 0
            tier2_cutoff = os.environ.get("MNEMOSYNE_TIER2_DAYS", "30")
            tier3_cutoff = os.environ.get("MNEMOSYNE_TIER3_DAYS", "180")
            now = datetime.now(UTC).replace(tzinfo=None)
            try:
                tier2_days = int(tier2_cutoff)
                tier3_days = int(tier3_cutoff)
            except ValueError:
                tier2_days, tier3_days = 30, 180
            tier2_ts = (now - timedelta(days=tier2_days)).isoformat(timespec="seconds")
            tier3_ts = (now - timedelta(days=tier3_days)).isoformat(timespec="seconds")
            for table, memory_kind in [("working_memory", "working"), ("episodic_memory", "episodic")]:
                if table not in tables:
                    continue
                columns = self._columns(con, table)
                by_source_raw += [dict(r, tier=memory_kind, memory_kind=memory_kind) for r in con.execute(
                    f"SELECT COALESCE(source,'') AS source, count(*) AS count FROM {table} GROUP BY source ORDER BY count DESC LIMIT 20"
                )]
                by_scope_raw += [dict(r, tier=memory_kind, memory_kind=memory_kind) for r in con.execute(
                    f"SELECT COALESCE(scope,'') AS scope, count(*) AS count FROM {table} GROUP BY scope ORDER BY count DESC"
                )]
                by_session_raw += [dict(r, tier=memory_kind, memory_kind=memory_kind) for r in con.execute(
                    f"SELECT COALESCE(session_id,'') AS session_id, count(*) AS count FROM {table} GROUP BY session_id ORDER BY count DESC LIMIT 20"
                )]
                veracity_expr = "COALESCE(veracity, 'unknown')" if "veracity" in columns else "'unknown'"
                for row in con.execute(f"SELECT {veracity_expr} AS veracity, COUNT(*) AS count FROM {table} GROUP BY veracity"):
                    veracity = str(row["veracity"] or "unknown").lower()
                    if veracity not in VERACITY_WEIGHTS:
                        veracity = "unknown"
                    count = int(row["count"] or 0)
                    veracity_counts[veracity] += count
                    if veracity in CONTAMINATED_VERACITIES:
                        contaminated_total += count
                contaminated_clause = f"{veracity_expr} IN ('inferred','tool','imported','unknown')"
                contaminated_high += int(con.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE {contaminated_clause} AND COALESCE(importance, 0) > 0.5"
                ).fetchone()[0])
                if table == "episodic_memory":
                    tier_expr = "COALESCE(tier, 1)" if "tier" in columns else "1"
                    for row in con.execute(f"SELECT {tier_expr} AS degradation_tier, COUNT(*) AS count FROM episodic_memory GROUP BY degradation_tier"):
                        degradation_counts[_degradation_label(row["degradation_tier"])] += int(row["count"] or 0)
                    if "degraded_at" in columns:
                        degraded_count = int(con.execute("SELECT COUNT(*) FROM episodic_memory WHERE COALESCE(degraded_at, '') != ''").fetchone()[0])
                    if "tier" in columns:
                        due_tier2 = int(con.execute("SELECT COUNT(*) FROM episodic_memory WHERE COALESCE(tier, 1) = 1 AND COALESCE(created_at, timestamp, '') < ?", (tier2_ts,)).fetchone()[0])
                        due_tier3 = int(con.execute("SELECT COUNT(*) FROM episodic_memory WHERE COALESCE(tier, 1) = 2 AND COALESCE(created_at, timestamp, '') < ?", (tier3_ts,)).fetchone()[0])

            def aggregate(rows: list[dict[str, Any]], key: str, limit: int = 20) -> list[dict[str, Any]]:
                totals: dict[str, int] = {}
                for row in rows:
                    label = row.get(key) or "unknown"
                    totals[label] = totals.get(label, 0) + int(row.get("count") or 0)
                return [{key: k, "count": v} for k, v in sorted(totals.items(), key=lambda kv: kv[1], reverse=True)[:limit]]

            by_source = aggregate(by_source_raw, "source", 20)
            by_scope = aggregate(by_scope_raw, "scope", 20)
            by_session = aggregate(by_session_raw, "session_id", 20)
            by_veracity = [
                {"veracity": key, "count": int(veracity_counts.get(key, 0)), "weight": VERACITY_WEIGHTS[key]}
                for key in ["stated", "unknown", "inferred", "imported", "tool"]
                if veracity_counts.get(key, 0)
            ]
            by_degradation = [
                {"degradation_tier": tier, "degradation_label": label, "count": int(degradation_counts.get(label, 0)), "weight": DEGRADATION_WEIGHTS[tier]}
                for tier, label in DEGRADATION_LABELS.items()
            ]

            recent = self.list_memories(kind="all", limit=10)
            return {
                "db_path": str(self.db_path),
                "counts": counts,
                "by_source": by_source,
                "by_scope": by_scope,
                "by_session": by_session,
                "by_veracity": by_veracity,
                "by_degradation": by_degradation,
                "contamination": {
                    "total": contaminated_total,
                    "high_importance": contaminated_high,
                    "veracities": sorted(CONTAMINATED_VERACITIES),
                },
                "degradation": {
                    "degraded": degraded_count,
                    "due_tier2": due_tier2,
                    "due_tier3": due_tier3,
                    "labels": {str(k): v for k, v in DEGRADATION_LABELS.items()},
                },
                "recent": recent,
            }

    def list_memories(
        self,
        kind: str = "all",
        q: str = "",
        source: str = "",
        scope: str = "",
        session_id: str = "",
        sort: str = "recent",
        limit: int = 100,
        offset: int = 0,
        status: str = "active",
        veracity: str = "",
        degradation_tier: int | str | None = None,
        contaminated_only: bool | str = False,
        degraded_only: bool | str = False,
        due_for_degradation: bool | str = False,
        min_importance: float | str | None = None,
    ) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit or 100), 10000))
        offset = max(0, int(offset or 0))
        q = (q or "").strip()
        source = (source or "").strip()
        scope = (scope or "").strip()
        session_id = (session_id or "").strip()
        sort = (sort or "recent").strip()
        status = (status or "active").strip().lower()
        veracity = (veracity or "").strip().lower()
        if veracity and veracity not in VERACITY_WEIGHTS:
            veracity = ""
        try:
            min_importance_value = float(min_importance) if min_importance not in (None, "") else None
        except (TypeError, ValueError):
            min_importance_value = None
        try:
            degradation_tier_value = int(degradation_tier) if degradation_tier not in (None, "") else None
        except (TypeError, ValueError):
            degradation_tier_value = None
        if degradation_tier_value not in DEGRADATION_LABELS:
            degradation_tier_value = None
        contaminated = _truthy(contaminated_only)
        degraded = _truthy(degraded_only)
        due = _truthy(due_for_degradation)
        if status not in {"active", "expired", "superseded", "all"}:
            status = "active"
        now = _utc_now()
        now_dt = datetime.now(UTC).replace(tzinfo=None)
        try:
            tier2_days = int(os.environ.get("MNEMOSYNE_TIER2_DAYS", "30"))
            tier3_days = int(os.environ.get("MNEMOSYNE_TIER3_DAYS", "180"))
        except ValueError:
            tier2_days, tier3_days = 30, 180
        tier2_ts = (now_dt - timedelta(days=tier2_days)).isoformat(timespec="seconds")
        tier3_ts = (now_dt - timedelta(days=tier3_days)).isoformat(timespec="seconds")
        sql_order = {
            "recent": "COALESCE(timestamp, created_at) DESC",
            "oldest": "COALESCE(timestamp, created_at) ASC",
            "importance": "importance DESC, COALESCE(timestamp, created_at) DESC",
            "recall": "recall_count DESC, COALESCE(last_recalled, timestamp, created_at) DESC",
        }.get(sort, "COALESCE(timestamp, created_at) DESC")
        wanted = []
        if kind in ("all", "working"):
            wanted.append(("working_memory", "working"))
        if kind in ("all", "episodic"):
            wanted.append(("episodic_memory", "episodic"))

        rows: list[dict[str, Any]] = []
        with self.connect() as con:
            tables = self._tables(con)
            for table, memory_kind in wanted:
                if table not in tables:
                    continue
                columns = self._columns(con, table)
                where = []
                params: list[Any] = []
                if q:
                    where.append("(content REGEXP ? OR id REGEXP ? OR session_id REGEXP ? OR source REGEXP ? OR scope REGEXP ?)")
                    pattern = self._prefix_pattern(q)
                    params += [pattern, pattern, pattern, pattern, pattern]
                if source:
                    where.append("source = ?")
                    params.append(source)
                if scope:
                    where.append("scope = ?")
                    params.append(scope)
                if session_id:
                    where.append("session_id = ?")
                    params.append(session_id)
                if min_importance_value is not None:
                    where.append("COALESCE(importance, 0) >= ?")
                    params.append(min_importance_value)
                veracity_expr = "COALESCE(veracity, 'unknown')" if "veracity" in columns else "'unknown'"
                if veracity:
                    where.append(f"{veracity_expr} = ?")
                    params.append(veracity)
                if contaminated:
                    where.append(f"{veracity_expr} IN ('inferred','tool','imported','unknown')")
                if memory_kind == "episodic":
                    tier_expr = "COALESCE(tier, 1)" if "tier" in columns else "1"
                    if degradation_tier_value:
                        where.append(f"{tier_expr} = ?")
                        params.append(degradation_tier_value)
                    if degraded:
                        if "degraded_at" in columns:
                            where.append("COALESCE(degraded_at, '') != ''")
                        else:
                            where.append("0 = 1")
                    if due:
                        where.append(f"(({tier_expr} = 1 AND COALESCE(created_at, timestamp, '') < ?) OR ({tier_expr} = 2 AND COALESCE(created_at, timestamp, '') < ?))")
                        params.extend([tier2_ts, tier3_ts])
                elif degradation_tier_value or degraded or due:
                    where.append("0 = 1")
                if status == "active":
                    where.append("COALESCE(superseded_by, '') = ''")
                    where.append("(valid_until IS NULL OR valid_until = '' OR valid_until > ?)")
                    params.append(now)
                elif status == "expired":
                    where.append("COALESCE(superseded_by, '') = ''")
                    where.append("valid_until IS NOT NULL AND valid_until != '' AND valid_until <= ?")
                    params.append(now)
                elif status == "superseded":
                    where.append("COALESCE(superseded_by, '') != ''")
                clause = "WHERE " + " AND ".join(where) if where else ""
                select_cols = self._memory_select_columns(columns, memory_kind)
                sql = f"""
                    SELECT {select_cols}
                    FROM {table}
                    {clause}
                    ORDER BY {sql_order}
                    LIMIT ? OFFSET 0
                """
                for row in con.execute(sql, [*params, limit + offset]):
                    d = self._enrich_memory(self._dict(row), memory_kind)
                    rows.append(d)
        rows.sort(key=lambda r: (
            float(r.get("importance") or 0) if sort == "importance" else int(r.get("recall_count") or 0) if sort == "recall" else (r.get("timestamp") or r.get("created_at") or "")
        ), reverse=sort != "oldest")
        return rows[offset:offset + limit]

    def get_memory(self, memory_id: str) -> dict[str, Any] | None:
        with self.connect() as con:
            tables = self._tables(con)
            for table, memory_kind in [("working_memory", "working"), ("episodic_memory", "episodic")]:
                if table not in tables:
                    continue
                row = con.execute(f"SELECT * FROM {table} WHERE id = ?", (memory_id,)).fetchone()
                if row:
                    return self._enrich_memory(self._dict(row), memory_kind)
        return None

    def review_queues(
        self,
        limit: int = 50,
        offset: int = 0,
        queue: str = "",
        q: str = "",
        min_importance: float | str | None = None,
    ) -> dict[str, Any]:
        """Trust/lifecycle review queues for Mnemosyne 2.3 metadata."""
        limit = max(1, min(int(limit or 50), 500))
        offset = max(0, int(offset or 0))
        queue = (queue or "").strip() or "contaminated"
        queue_defs = {
            "contaminated": {
                "title": "Needs review",
                "description": "Memories not directly stated by you: inferred, tool-generated, imported, or unknown.",
                "args": {"kind": "all", "status": "active", "contaminated_only": True, "sort": "importance"},
                "filter": {"contaminated_only": "1", "sort": "importance"},
            },
            "high_importance_contaminated": {
                "title": "Important memories needing review",
                "description": "Important memories that were inferred, tool-generated, imported, or unknown.",
                "args": {"kind": "all", "status": "active", "contaminated_only": True, "sort": "importance", "min_importance": 0.500001},
                "filter": {"contaminated_only": "1", "sort": "importance"},
            },
            "degraded": {
                "title": "Degraded",
                "description": "Episodic memories that have moved down the lifecycle and may carry reduced recall weight.",
                "args": {"kind": "episodic", "status": "active", "degraded_only": True, "sort": "recent"},
                "filter": {"kind": "episodic", "degraded_only": "1", "sort": "recent"},
            },
            "due_for_degradation": {
                "title": "Due for degradation",
                "description": "Hot or warm episodic memories old enough to be compressed into the next lifecycle tier.",
                "args": {"kind": "episodic", "status": "active", "due_for_degradation": True, "sort": "oldest"},
                "filter": {"kind": "episodic", "due_for_degradation": "1", "sort": "oldest"},
            },
        }
        if queue not in queue_defs:
            queue = "contaminated"
        try:
            min_importance_value = float(min_importance) if min_importance not in (None, "") else None
        except (TypeError, ValueError):
            min_importance_value = None

        def args_for(key: str, *, page: bool = False) -> dict[str, Any]:
            args = dict(queue_defs[key]["args"])
            if q:
                args["q"] = q
            base_min = args.get("min_importance")
            if min_importance_value is not None:
                args["min_importance"] = max(float(base_min or 0), min_importance_value)
            elif base_min is not None:
                args["min_importance"] = base_min
            args["limit"] = limit if page else 10000
            args["offset"] = offset if page else 0
            return args

        totals = {key: len(self.list_memories(**args_for(key))) for key in queue_defs}
        page_items = self.list_memories(**args_for(queue, page=True))
        queues = {
            key: {
                "title": meta["title"],
                "description": meta["description"],
                "filter": meta["filter"],
                "items": page_items if key == queue else [],
            }
            for key, meta in queue_defs.items()
        }
        cards = [
            {"key": key, "title": meta["title"], "count": totals[key], "description": meta["description"]}
            for key, meta in queue_defs.items()
        ]
        next_offset = offset + limit if offset + len(page_items) < totals[queue] else None
        return {
            "read_only": True,
            "limit": limit,
            "offset": offset,
            "queue": queue,
            "q": q,
            "min_importance": min_importance_value,
            "total": totals[queue],
            "listed": len(page_items),
            "next_offset": next_offset,
            "has_more": next_offset is not None,
            "generated_at": _utc_now(),
            "counts": totals,
            "cards": cards,
            "queues": queues,
        }

    def lifecycle_dashboard(self, limit: int = 50) -> dict[str, Any]:
        """Read-only lifecycle dashboard for Mnemosyne degradation tiers."""
        limit = max(1, min(int(limit or 50), 200))
        try:
            tier2_days = int(os.environ.get("MNEMOSYNE_TIER2_DAYS", "30"))
            tier3_days = int(os.environ.get("MNEMOSYNE_TIER3_DAYS", "180"))
        except ValueError:
            tier2_days, tier3_days = 30, 180
        hot = self.list_memories(kind="episodic", status="active", degradation_tier=1, sort="oldest", limit=limit)
        warm = self.list_memories(kind="episodic", status="active", degradation_tier=2, sort="oldest", limit=limit)
        cold = self.list_memories(kind="episodic", status="active", degradation_tier=3, sort="oldest", limit=limit)
        due = self.list_memories(kind="episodic", status="active", due_for_degradation=True, sort="oldest", limit=limit)
        recently_degraded = self.list_memories(kind="episodic", status="active", degraded_only=True, sort="recent", limit=limit)
        high_importance_degraded = [m for m in recently_degraded if float(m.get("importance") or 0) > 0.5][:limit]
        stats = self.stats()
        degradation_counts = {row["degradation_label"]: int(row["count"] or 0) for row in stats.get("by_degradation", [])}
        counts = {
            "hot": degradation_counts.get("hot", len(hot)),
            "warm": degradation_counts.get("warm", len(warm)),
            "cold": degradation_counts.get("cold", len(cold)),
            "due_for_degradation": int(stats.get("degradation", {}).get("due_tier2") or 0) + int(stats.get("degradation", {}).get("due_tier3") or 0),
            "recently_degraded": int(stats.get("degradation", {}).get("degraded") or len(recently_degraded)),
            "high_importance_degraded": len(high_importance_degraded),
        }
        queues = {
            "hot": {"title": "Hot memories", "description": "Tier 1 episodic memories retain full detail and full lifecycle weight.", "filter": {"kind": "episodic", "degradation_tier": "1", "sort": "oldest"}, "items": hot},
            "warm": {"title": "Warm memories", "description": "Tier 2 episodic memories are compressed and carry reduced recall weight.", "filter": {"kind": "episodic", "degradation_tier": "2", "sort": "oldest"}, "items": warm},
            "cold": {"title": "Cold memories", "description": "Tier 3 episodic memories keep key signal only and carry the lowest lifecycle weight.", "filter": {"kind": "episodic", "degradation_tier": "3", "sort": "oldest"}, "items": cold},
            "due_for_degradation": {"title": "Due for degradation", "description": "Hot or warm episodic memories old enough to move to the next lifecycle tier.", "filter": {"kind": "episodic", "due_for_degradation": "1", "sort": "oldest"}, "items": due},
            "recently_degraded": {"title": "Recently degraded", "description": "Memories already compressed into a lower lifecycle tier.", "filter": {"kind": "episodic", "degraded_only": "1", "sort": "recent"}, "items": recently_degraded},
            "high_importance_degraded": {"title": "High-importance degraded", "description": "Important degraded memories worth checking before further lifecycle compression.", "filter": {"kind": "episodic", "degraded_only": "1", "sort": "importance"}, "items": high_importance_degraded},
        }
        cards = [{"key": key, "title": queue["title"], "count": counts[key], "description": queue["description"]} for key, queue in queues.items()]
        return {
            "read_only": True,
            "generated_at": _utc_now(),
            "thresholds": {"tier2_days": tier2_days, "tier3_days": tier3_days, "weights": {str(k): v for k, v in DEGRADATION_WEIGHTS.items()}},
            "counts": counts,
            "cards": cards,
            "queues": queues,
        }

    def triples(self, q: str = "", subject: str = "", predicate: str = "", object_: str = "", limit: int = 200) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit or 200), 1000))
        where = []
        params: list[Any] = []
        if q:
            pattern = self._prefix_pattern(q)
            where.append("(COALESCE(subject, '') || ' ' || COALESCE(predicate, '') || ' ' || COALESCE(object, '') || ' ' || COALESCE(source, '')) REGEXP ?")
            params.append(pattern)
        for col, value in [("subject", subject), ("predicate", predicate), ("object", object_)]:
            if value:
                where.append(f"{col} REGEXP ?")
                params.append(self._prefix_pattern(value))
        clause = "WHERE " + " AND ".join(where) if where else ""
        with self.connect() as con:
            if "triples" not in self._tables(con):
                return []
            return [dict(r) for r in con.execute(
                f"SELECT id, subject, predicate, object, valid_from, valid_until, source, confidence, created_at FROM triples {clause} ORDER BY created_at DESC LIMIT ?",
                [*params, limit],
            )]

    def graph(self, q: str = "", limit: int = 300) -> dict[str, Any]:
        triples = self.triples(q=q, limit=limit)
        node_ids: dict[str, str] = {}
        node_counts: dict[str, int] = {}
        nodes: list[dict[str, Any]] = []
        edges: list[dict[str, Any]] = []

        def node(label: str) -> str:
            node_counts[label] = node_counts.get(label, 0) + 1
            if label not in node_ids:
                nid = f"n{len(node_ids)+1}"
                node_ids[label] = nid
                nodes.append({"id": nid, "label": label, "count": 0})
            return node_ids[label]

        for t in triples:
            s = node(str(t["subject"]))
            o = node(str(t["object"]))
            edges.append({
                "id": f"e{t['id']}",
                "triple_id": t.get("id"),
                "source": s,
                "target": o,
                "subject": t.get("subject"),
                "predicate": t["predicate"],
                "object": t.get("object"),
                "confidence": t.get("confidence"),
                "valid_from": t.get("valid_from"),
                "valid_until": t.get("valid_until"),
                "created_at": t.get("created_at"),
                "source_name": t.get("source"),
            })
        for n in nodes:
            n["count"] = node_counts.get(n["label"], 0)
        return {"nodes": nodes, "edges": edges}

    def consolidations(self, q: str = "", limit: int = 100) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit or 100), 500))
        q = (q or "").strip()
        where = ""
        params: list[Any] = []
        if q:
            where = "WHERE session_id REGEXP ? OR summary_preview REGEXP ? OR created_at REGEXP ?"
            pattern = self._prefix_pattern(q)
            params = [pattern, pattern, pattern]
        with self.connect() as con:
            if "consolidation_log" not in self._tables(con):
                return []
            return [dict(r) for r in con.execute(
                f"SELECT id, session_id, items_consolidated, summary_preview, created_at FROM consolidation_log {where} ORDER BY created_at DESC LIMIT ?",
                [*params, limit],
            )]
    def session_detail(self, session_id: str, limit: int = 200) -> dict[str, Any]:
        session_id = (session_id or "").strip()
        if not session_id:
            raise ValueError("session_id is required")
        limit = max(1, min(int(limit or 200), 500))
        memories = self.list_memories(kind="all", session_id=session_id, sort="recent", limit=limit)
        consolidations = self.consolidations(q=session_id, limit=limit)
        triples: list[dict[str, Any]] = []
        with self.connect() as con:
            tables = self._tables(con)
            if "triples" in tables:
                cols = {r[1] for r in con.execute("PRAGMA table_info(triples)")}
                where = []
                params: list[Any] = []
                if "session_id" in cols:
                    where.append("session_id = ?")
                    params.append(session_id)
                if "source" in cols:
                    where.append("source = ?")
                    params.append(session_id)
                if where:
                    triples = [dict(r) for r in con.execute(
                        f"SELECT * FROM triples WHERE {' OR '.join(where)} ORDER BY COALESCE(created_at, valid_from) DESC LIMIT ?",
                        [*params, limit],
                    )]
        events: list[dict[str, Any]] = []
        for m in memories:
            events.append({"type": "memory", "timestamp": m.get("timestamp") or m.get("created_at") or "", "title": m.get("tier") or "memory", "preview": str(m.get("content") or "")[:240], "item": m})
        for t in triples:
            events.append({"type": "triple", "timestamp": t.get("created_at") or t.get("valid_from") or "", "title": t.get("predicate") or "triple", "preview": f"{t.get('subject')} → {t.get('object')}", "item": t})
        for c in consolidations:
            if c.get("session_id") == session_id:
                events.append({"type": "consolidation", "timestamp": c.get("created_at") or "", "title": f"{c.get('items_consolidated')} items", "preview": c.get("summary_preview") or "", "item": c})
        events.sort(key=lambda e: e.get("timestamp") or "", reverse=True)
        return {
            "session_id": session_id,
            "counts": {"memories": len(memories), "triples": len(triples), "consolidations": len([c for c in consolidations if c.get("session_id") == session_id]), "events": len(events)},
            "memories": memories,
            "triples": triples,
            "consolidations": [c for c in consolidations if c.get("session_id") == session_id],
            "events": events[:limit],
        }


    def audit_log(self, limit: int = 100) -> list[dict[str, Any]]:
        path = plugin_data_dir() / "audit.jsonl"
        if not path.exists():
            return []
        lines = path.read_text().splitlines()[-max(1, min(int(limit or 100), 1000)):]
        rows = []
        for line in lines:
            try:
                rows.append(json.loads(line))
            except Exception:
                rows.append({"raw": line})
        return list(reversed(rows))

    def _audit(self, action: str, memory_id: str, before: dict[str, Any] | None = None, after: dict[str, Any] | None = None, extra: dict[str, Any] | None = None) -> None:
        path = plugin_data_dir() / "audit.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "timestamp": _utc_now(),
            "action": action,
            "memory_id": memory_id,
            "before": before,
            "after": after,
            "extra": extra or {},
        }
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")

    def backup_database(self) -> dict[str, Any]:
        if not self.db_path.exists():
            raise FileNotFoundError(f"Mnemosyne DB not found: {self.db_path}")
        backup_dir = plugin_data_dir() / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = _utc_now().replace(":", "").replace("-", "")
        target = backup_dir / f"mnemosyne-{stamp}-{uuid.uuid4().hex[:8]}.db"
        shutil.copy2(self.db_path, target)
        return {"path": str(target), "size_bytes": target.stat().st_size, "created_at": _utc_now()}

    def invalidate_memory(self, memory_id: str, backup: bool = True) -> dict[str, Any]:
        memory_id = (memory_id or "").strip()
        if not memory_id:
            raise ValueError("memory_id is required")
        before = self.get_memory(memory_id)
        if not before:
            raise ValueError("memory not found")
        backup_info = self.backup_database() if backup else None
        now = _utc_now()
        with self.connect_rw() as con:
            updated = 0
            for table in ("working_memory", "episodic_memory"):
                if table in self._tables(con):
                    cur = con.execute(f"UPDATE {table} SET valid_until = ?, superseded_by = NULL WHERE id = ?", (now, memory_id))
                    updated += cur.rowcount
            if "memories" in self._tables(con):
                cols = {r[1] for r in con.execute("PRAGMA table_info(memories)")}
                if "valid_until" in cols:
                    con.execute("UPDATE memories SET valid_until = ? WHERE id = ?", (now, memory_id))
            con.commit()
        after = self.get_memory(memory_id)
        self._audit("invalidate", memory_id, before, after, {"backup": backup_info})
        return {"ok": updated > 0, "memory_id": memory_id, "status": "expired", "backup": backup_info, "item": after}

    def set_memory_importance(self, memory_id: str, importance: float, backup: bool = True) -> dict[str, Any]:
        memory_id = (memory_id or "").strip()
        if not memory_id:
            raise ValueError("memory_id is required")
        importance = float(importance)
        if not 0 <= importance <= 1:
            raise ValueError("importance must be between 0.0 and 1.0")
        before = self.get_memory(memory_id)
        if not before:
            raise ValueError("memory not found")
        backup_info = self.backup_database() if backup else None
        with self.connect_rw() as con:
            updated = 0
            for table in ("working_memory", "episodic_memory", "memories"):
                if table in self._tables(con):
                    cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
                    if "importance" in cols:
                        cur = con.execute(f"UPDATE {table} SET importance = ? WHERE id = ?", (importance, memory_id))
                        updated += cur.rowcount
            con.commit()
        after = self.get_memory(memory_id)
        self._audit("importance", memory_id, before, after, {"importance": importance, "backup": backup_info})
        return {"ok": updated > 0, "memory_id": memory_id, "importance": importance, "backup": backup_info, "item": after}

    def set_memory_veracity(self, memory_id: str, veracity: str, backup: bool = True) -> dict[str, Any]:
        memory_id = (memory_id or "").strip()
        veracity = (veracity or "").strip().lower()
        if not memory_id:
            raise ValueError("memory_id is required")
        if veracity not in VERACITY_WEIGHTS:
            raise ValueError("veracity must be one of: " + ", ".join(VERACITY_WEIGHTS))
        before = self.get_memory(memory_id)
        if not before:
            raise ValueError("memory not found")
        backup_info = self.backup_database() if backup else None
        with self.connect_rw() as con:
            updated = 0
            for table in ("working_memory", "episodic_memory", "memories"):
                if table in self._tables(con):
                    cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
                    if "veracity" in cols:
                        cur = con.execute(f"UPDATE {table} SET veracity = ? WHERE id = ?", (veracity, memory_id))
                        updated += cur.rowcount
            con.commit()
        after = self.get_memory(memory_id)
        self._audit("veracity", memory_id, before, after, {"veracity": veracity, "backup": backup_info})
        return {"ok": updated > 0, "memory_id": memory_id, "veracity": veracity, "backup": backup_info, "item": after}

    def set_memory_expiry(self, memory_id: str, valid_until: str, backup: bool = True) -> dict[str, Any]:
        memory_id = (memory_id or "").strip()
        valid_until = (valid_until or "").strip()
        if not memory_id:
            raise ValueError("memory_id is required")
        if valid_until:
            try:
                datetime.fromisoformat(valid_until.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValueError("valid_until must be an ISO timestamp or empty") from exc
        before = self.get_memory(memory_id)
        if not before:
            raise ValueError("memory not found")
        backup_info = self.backup_database() if backup else None
        value = valid_until or None
        with self.connect_rw() as con:
            updated = 0
            for table in ("working_memory", "episodic_memory", "memories"):
                if table in self._tables(con):
                    cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
                    if "valid_until" in cols:
                        cur = con.execute(f"UPDATE {table} SET valid_until = ? WHERE id = ?", (value, memory_id))
                        updated += cur.rowcount
            con.commit()
        after = self.get_memory(memory_id)
        self._audit("expiry", memory_id, before, after, {"valid_until": value, "backup": backup_info})
        return {"ok": updated > 0, "memory_id": memory_id, "valid_until": value, "backup": backup_info, "item": after}

    def supersede_memory(self, memory_id: str, content: str, importance: float | None = None, backup: bool = True) -> dict[str, Any]:
        memory_id = (memory_id or "").strip()
        content = (content or "").strip()
        if not memory_id:
            raise ValueError("memory_id is required")
        if not content:
            raise ValueError("replacement content is required")
        before = self.get_memory(memory_id)
        if not before:
            raise ValueError("memory not found")
        replacement_id = f"dash_{uuid.uuid4().hex}"
        now = _utc_now()
        new_importance = float(before.get("importance") if importance is None else importance)
        if not 0 <= new_importance <= 1:
            raise ValueError("importance must be between 0.0 and 1.0")
        metadata = dict(before.get("metadata") or {})
        metadata.update({"supersedes": memory_id, "created_by": "mnemosyne-dashboard"})
        backup_info = self.backup_database() if backup else None
        with self.connect_rw() as con:
            tables = self._tables(con)
            if "working_memory" not in tables:
                raise ValueError("working_memory table not found")
            con.execute("""
                INSERT INTO working_memory(
                    id, content, source, timestamp, session_id, importance, metadata_json,
                    created_at, valid_until, superseded_by, scope, author_id, author_type, channel_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
            """, (
                replacement_id,
                content,
                before.get("source"),
                now,
                before.get("session_id") or "default",
                new_importance,
                json.dumps(metadata, ensure_ascii=False, sort_keys=True),
                now,
                before.get("scope") or "session",
                before.get("author_id"),
                before.get("author_type"),
                before.get("channel_id"),
            ))
            for table in ("working_memory", "episodic_memory"):
                if table in tables:
                    con.execute(f"UPDATE {table} SET valid_until = ?, superseded_by = ? WHERE id = ?", (now, replacement_id, memory_id))
            if "memories" in tables:
                cols = {r[1] for r in con.execute("PRAGMA table_info(memories)")}
                if {"id", "content"} <= cols:
                    keys = ["id", "content"]
                    values = [replacement_id, content]
                    optional = {
                        "source": before.get("source"),
                        "timestamp": now,
                        "session_id": before.get("session_id") or "default",
                        "importance": new_importance,
                        "metadata_json": json.dumps(metadata, ensure_ascii=False, sort_keys=True),
                    }
                    for k, v in optional.items():
                        if k in cols:
                            keys.append(k)
                            values.append(v)
                    con.execute(f"INSERT OR REPLACE INTO memories ({', '.join(keys)}) VALUES ({', '.join(['?'] * len(keys))})", values)
                    if "superseded_by" in cols or "valid_until" in cols:
                        sets = []
                        vals = []
                        if "valid_until" in cols:
                            sets.append("valid_until = ?")
                            vals.append(now)
                        if "superseded_by" in cols:
                            sets.append("superseded_by = ?")
                            vals.append(replacement_id)
                        vals.append(memory_id)
                        con.execute(f"UPDATE memories SET {', '.join(sets)} WHERE id = ?", vals)
            con.commit()
        replacement = self.get_memory(replacement_id)
        after = self.get_memory(memory_id)
        self._audit("supersede", memory_id, before, after, {"replacement_id": replacement_id, "backup": backup_info})
        return {"ok": True, "memory_id": memory_id, "replacement_id": replacement_id, "backup": backup_info, "item": after, "replacement": replacement}


    @staticmethod
    def _today_key() -> str:
        return datetime.now().astimezone().date().isoformat()

    @staticmethod
    def _entity_terms(*values: object, limit: int = 20) -> list[str]:
        stop = {
            "The", "This", "That", "User", "Assistant", "System", "When", "Involving", "Monday", "Tuesday", "Wednesday",
            "Thursday", "Friday", "Saturday", "Sunday", "January", "February", "March", "April", "May", "June", "July",
            "August", "September", "October", "November", "December", "Memory", "Dashboard", "Mnemosyne", "Hermes", "Agent",
        }
        counter: Counter[str] = Counter()
        for value in values:
            text = str(value or "")
            for match in re.findall(r"\b(?:[A-Z][A-Za-z0-9_&.-]{2,}|[A-Z]{2,}|[A-Za-z]+(?:-[A-Za-z]+)+)\b", text):
                label = match.strip(".,:;()[]{}'")
                if len(label) < 3 or label in stop:
                    continue
                counter[label] += 1
        return [label for label, _ in counter.most_common(limit)]

    @staticmethod
    def _context_category_names() -> list[str]:
        return [
            "Preferences",
            "People",
            "Home setup",
            "Work / business",
            "Health / wearables",
            "Devices",
            "Agent memory",
            "Dashboard / visualisers",
            "Messaging / WhatsApp",
            "Travel / leisure",
            "Creative / media",
            "Finance / assets",
            "Projects",
            "Privacy rules",
            "Other",
        ]

    @staticmethod
    def _category_for_text(text: str) -> str:
        """Classify a memory into a human domain for Context Bank and the Labyrinth.

        The first implementation used first-keyword wins, which made the memory dungeon feel random:
        Hindsight daemon "health checks" landed in Health/wearables, WhatsApp operations landed in
        Home setup, and Mnemosyne Labyrinth work split across People/Projects/Other. Use weighted
        domain signals instead so the dungeon becomes a map of actual topics.
        """
        hay = str(text or "").lower()
        buckets: list[tuple[str, tuple[tuple[str, int], ...]]] = [
            ("Privacy rules", (
                ("local-only", 9), ("local only", 9), ("no cloud", 9), ("privacy", 8),
                ("whatsapp history", 8), ("cannot", 3), ("access", 2), ("permission", 2),
            )),
            ("Dashboard / visualisers", (
                ("memory palace", 10), ("mnemosyne labyrinth", 10), ("labyrinth", 8),
                ("dungeon", 8), ("visualiser", 8), ("visualizer", 8), ("three.js", 7),
                ("fps", 7), ("first-person", 7), ("viewport", 5), ("portal", 5),
                ("joystick", 5), ("palace", 5), ("dashboard", 4), ("review", 2),
            )),
            ("Agent memory", (
                ("hindsight", 10), ("mnemosyne", 9), ("lcm", 9), ("memory provider", 8),
                ("memory setup", 8), ("memory migration", 8), ("daemon", 6),
                ("idle_timeout", 6), ("consolidation", 5), ("episodic", 5),
                ("working memory", 5), ("context engine", 5), ("hindsight-api", 5),
            )),
            ("Messaging / WhatsApp", (
                ("whatsapp-cli", 10), ("whatsapp", 8), ("daily summary", 6),
                ("watchdog", 6), ("sync", 4), ("jid", 4), ("telegram", 4),
                ("message bridge", 4), ("gateway", 3),
            )),
            ("Health / wearables", (
                ("whoop", 10), ("health connect", 10), ("samsung health", 10),
                ("sleep", 8), ("hrv", 8), ("recovery", 7), ("strain", 7),
                ("wearable", 7), ("resting heart", 6), ("spo2", 6), ("heart rate", 5),
                ("activity", 4), ("health digest", 4),
            )),
            ("People", (
                ("sheryl", 9), ("babu", 9), ("hope", 9), ("clyde", 9), ("wife", 7),
                ("kid", 6), ("child", 6), ("baby", 6), ("family", 5), ("helper", 5),
                ("friend", 3), ("person", 1),
            )),
            ("Home setup", (
                ("home assistant", 9), ("smart home", 9), ("home setup", 8),
                ("house", 5), ("light", 4), ("camera", 4), ("sensor", 4),
                ("switch", 3), ("automation", 3), ("cleaning", 3),
            )),
            ("Work / business", (
                ("promptlybuilt", 10), ("marketing", 8), ("business", 8),
                ("lead", 5), ("linkedin", 5), ("work", 5), ("office", 4),
                ("smb", 4), ("case study", 4), ("enrichment", 4),
            )),
            ("Devices", (
                ("mac studio", 10), ("draw things", 8), ("gpu", 7), ("iphone", 6),
                ("tesla", 6), ("zeekr", 6), ("device", 5), ("server", 4),
                ("omlx", 4), ("grpc", 4), ("lan", 3),
            )),
            ("Travel / leisure", (
                ("hokkaido", 9), ("japan", 7), ("travel", 7), ("trip", 5),
                ("hotel", 4), ("flight", 4), ("restaurant", 4), ("food", 3),
                ("watch", 3), ("shopback", 3),
            )),
            ("Creative / media", (
                ("comic", 9), ("image", 6), ("prompt", 5), ("draw", 5),
                ("video", 5), ("tts", 5), ("voice", 4), ("song", 4),
                ("visual", 3),
            )),
            ("Finance / assets", (
                ("finance", 8), ("net worth", 8), ("crypto", 7), ("property", 6),
                ("mortgage", 6), ("income", 5), ("cashback", 5), ("investment", 5),
                ("price", 2),
            )),
            ("Preferences", (
                ("prefers", 8), ("preference", 8), ("likes", 5), ("wants", 5),
                ("expects", 5), ("avoid", 5), ("tone", 4), ("style", 4),
                ("dislikes", 4), ("correction", 3),
            )),
            ("Projects", (
                ("project", 6), ("plugin", 5), ("github", 5), ("release", 5),
                ("commit", 4), ("pr #", 4), ("pull request", 4), ("config", 2),
            )),
        ]
        scores: Counter[str] = Counter()
        for label, terms in buckets:
            for term, weight in terms:
                if term in hay:
                    scores[label] += weight
        if not scores:
            return "Other"
        if scores.get("Health / wearables") and re.search(r"\b(health check|healthy state|system health|failing health)\b", hay):
            scores["Health / wearables"] -= 8
        if scores.get("Agent memory") and any(term in hay for term in ("dashboard", "labyrinth", "memory palace", "visualiser", "visualizer", "viewport")):
            scores["Agent memory"] -= 7
            scores["Dashboard / visualisers"] += 4
        if scores.get("Home setup") and "whatsapp" in hay:
            scores["Home setup"] -= 4
        priority = {name: i for i, name in enumerate(DashboardStore._context_category_names())}
        best, score = max(scores.items(), key=lambda item: (item[1], -priority.get(item[0], 999)))
        return best if score > 0 else "Other"

    def today_digest(self, day: str = "", limit: int = 80) -> dict[str, Any]:
        day = (day or self._today_key())[:10]
        limit = max(1, min(int(limit or 80), 300))
        memories_today: list[dict[str, Any]] = []
        recalled_today: list[dict[str, Any]] = []
        with self.connect() as con:
            tables = self._tables(con)
            for table, tier in (("working_memory", "working"), ("episodic_memory", "episodic")):
                if table not in tables:
                    continue
                cols = self._columns(con, table)
                select_cols = self._memory_select_columns(cols, tier)
                created_sql = f"SELECT {select_cols} FROM {table} WHERE substr(COALESCE(timestamp, created_at, ''), 1, 10) = ? ORDER BY COALESCE(timestamp, created_at) DESC LIMIT ?"
                for row in con.execute(created_sql, (day, limit)):
                    memories_today.append(self._enrich_memory(self._dict(row), tier))
                if "last_recalled" in cols:
                    recalled_sql = f"SELECT {select_cols} FROM {table} WHERE substr(COALESCE(last_recalled, ''), 1, 10) = ? ORDER BY last_recalled DESC LIMIT ?"
                    for row in con.execute(recalled_sql, (day, limit)):
                        recalled_today.append(self._enrich_memory(self._dict(row), tier))

            triples_today = []
            if "triples" in tables:
                triples_today = [dict(r) for r in con.execute(
                    "SELECT id, subject, predicate, object, valid_from, valid_until, source, confidence, created_at FROM triples WHERE substr(COALESCE(created_at, valid_from, ''), 1, 10) = ? ORDER BY COALESCE(created_at, valid_from) DESC LIMIT ?",
                    (day, limit),
                )]
            consolidations_today = []
            if "consolidation_log" in tables:
                consolidations_today = [dict(r) for r in con.execute(
                    "SELECT id, session_id, items_consolidated, summary_preview, created_at FROM consolidation_log WHERE substr(COALESCE(created_at, ''), 1, 10) = ? ORDER BY created_at DESC LIMIT ?",
                    (day, limit),
                )]

        memories_today.sort(key=lambda r: r.get("timestamp") or r.get("created_at") or "", reverse=True)
        recalled_today.sort(key=lambda r: r.get("last_recalled") or "", reverse=True)
        source_counts = Counter(str(m.get("source") or "unknown") for m in memories_today)
        session_counts = Counter(str(m.get("session_id") or "default") for m in memories_today)
        tier_counts = Counter(str(m.get("memory_kind") or m.get("tier") or "memory") for m in memories_today)
        scope_counts = Counter(str(m.get("scope") or "unknown") for m in memories_today)
        veracity_counts = Counter(str(m.get("veracity") or "unknown") for m in memories_today)
        degradation_counts = Counter(str(m.get("degradation_label") or "not degraded") for m in memories_today if m.get("memory_kind") == "episodic")
        contaminated_today = sum(1 for m in memories_today if m.get("contaminated"))
        degraded_today = sum(1 for m in memories_today if m.get("degraded_at"))
        entity_values = [m.get("content") for m in memories_today[:limit]]
        for t in triples_today:
            entity_values += [t.get("subject"), t.get("object")]
        top_entities = [{"label": x, "count": n} for x, n in Counter(self._entity_terms(*entity_values, limit=80)).most_common(16)]
        return {
            "day": day,
            "read_only": True,
            "counts": {
                "memories_added": len(memories_today),
                "memories_recalled": len(recalled_today),
                "contaminated_added": contaminated_today,
                "degraded_added": degraded_today,
                "triples_added": len(triples_today),
                "consolidations": len(consolidations_today),
            },
            "breakdowns": {
                "tiers": [{"label": k, "count": v} for k, v in tier_counts.most_common()],
                "veracity": [{"label": k, "count": v, "weight": VERACITY_WEIGHTS.get(k, VERACITY_WEIGHTS["unknown"])} for k, v in veracity_counts.most_common()],
                "degradation": [{"label": k, "count": v} for k, v in degradation_counts.most_common()],
                "sources": [{"label": k, "count": v} for k, v in source_counts.most_common(8)],
                "scopes": [{"label": k, "count": v} for k, v in scope_counts.most_common(8)],
                "sessions": [{"label": k, "count": v} for k, v in session_counts.most_common(8)],
                "entities": top_entities,
            },
            "memories_added": memories_today[:limit],
            "memories_recalled": recalled_today[:limit],
            "triples_added": triples_today[:limit],
            "consolidations": consolidations_today[:limit],
        }

    @staticmethod
    def _split_context_metadata(text: str) -> tuple[str, list[dict[str, str]]]:
        parts = [p.strip() for p in str(text or "").split("|") if p.strip()]
        if not parts:
            return "", []
        meta: list[dict[str, str]] = []
        for part in parts[1:]:
            if ":" in part:
                key, value = part.split(":", 1)
                key = key.strip()
                value = value.strip()
                if key and value:
                    meta.append({"label": key, "value": value})
        return parts[0], meta

    @staticmethod
    def _context_type(text: str, category: str, kind: str = "memory") -> tuple[str, str]:
        hay = f"{category} {text}".lower()
        if kind == "triple":
            return "Relationship", "schema"
        if "health" in hay or "whoop" in hay or "sleep" in hay or "hrv" in hay or "wearable" in hay or "recovery" in hay or "strain" in hay or "resting" in hay:
            return "Health insight", "sensitive"
        if "privacy" in hay or "local-only" in hay or "local only" in hay or "no cloud" in hay or "cannot" in hay:
            return "Privacy rule", "locked"
        if any(term in hay for term in ("specific pr", "this pr", "current pr", "temporary", "for this", "in this", "asked", "inquired", "testing", "test migrating")):
            return "Short-term notes", "review"
        if any(term in hay for term in ("prefers", "preference", "wants", "expects", "avoid", "should not", "do not", "tone", "style")):
            return "Preference", "confirmed"
        if any(term in hay for term in ("project", "plugin", "dashboard", "github", "release", "migration", "server", "config")):
            return "Project notes", "project"
        return "Fact", "fact"

    @staticmethod
    def _confidence_label(value: object) -> tuple[str, int]:
        try:
            score = max(0.0, min(1.0, float(value or 0)))
        except Exception:
            score = 0.0
        if score >= 0.8:
            label = "High confidence"
        elif score >= 0.55:
            label = "Medium confidence"
        else:
            label = "Needs review"
        return label, int(round(score * 100))

    def inferred_profile(self, limit_per_section: int = 10) -> dict[str, Any]:
        limit_per_section = max(3, min(int(limit_per_section or 10), 30))
        section_names = self._context_category_names()
        sections = {name: [] for name in section_names}
        all_items: list[dict[str, Any]] = []

        def add_row(*, kind: str, label: str, item: dict[str, Any], importance: object, timestamp: object, category: str) -> None:
            clean, extracted = self._split_context_metadata(label)
            context_type, type_tone = self._context_type(clean, category, kind)
            confidence_label, confidence_pct = self._confidence_label(importance)
            row = {
                "kind": kind,
                "label": clean[:220],
                "raw_label": label,
                "item": item,
                "importance": importance,
                "confidence_label": confidence_label,
                "confidence_pct": confidence_pct,
                "timestamp": timestamp,
                "category": category,
                "context_type": context_type,
                "type_tone": type_tone,
                "source": item.get("source") or item.get("tier") or kind,
                "scope": item.get("scope") or "",
                "status": item.get("status") or "active",
                "tier": item.get("tier") or kind,
                "extracted": extracted[:4],
                "sensitive": context_type == "Health insight",
                "needs_review": confidence_pct < 70 or context_type == "Short-term notes",
            }
            all_items.append(row)
            if len(sections[category]) < limit_per_section:
                sections[category].append(row)

        memories = self.list_memories(kind="all", status="active", sort="importance", limit=500)
        for m in memories:
            category = self._category_for_text(str(m.get("content") or ""))
            add_row(kind="memory", label=str(m.get("content") or ""), item=m, importance=m.get("importance"), timestamp=m.get("timestamp") or m.get("created_at"), category=category)
        for t in self.triples(limit=500):
            text = f"{t.get('subject')} {t.get('predicate')} {t.get('object')}"
            category = self._category_for_text(text)
            add_row(kind="triple", label=text, item=t, importance=t.get("confidence"), timestamp=t.get("created_at") or t.get("valid_from"), category=category)

        ordered = []
        for name in section_names:
            items = sections[name]
            if items:
                ordered.append({"name": name, "count": len(items), "items": items[:limit_per_section]})
        category_counts = Counter(row["category"] for row in all_items)
        top_types = category_counts.most_common(4)
        remainder = len(all_items) - sum(v for _, v in top_types)
        type_summary = [{"label": k, "count": v} for k, v in top_types]
        if remainder > 0:
            type_summary.append({"label": "Other types", "count": remainder})
        return {
            "read_only": True,
            "generated_at": _utc_now(),
            "sections": ordered,
            "summary": {
                "indexed_signals": len(all_items),
                "sections": len(ordered),
                "needs_review": sum(1 for row in all_items if row.get("needs_review")),
                "sensitive": sum(1 for row in all_items if row.get("sensitive")),
                "types": type_summary,
            },
        }

    @staticmethod
    def _pattern_origin_label(source: object, kind: str = "memory") -> str:
        raw = str(source or "").strip().lower()
        if kind == "triple" or raw == "triple":
            return "Knowledge graph"
        if not raw or raw in {"preference", "fact", "health", "task", "memory"}:
            return "Direct memory"
        if "hindsight" in raw:
            return "Hindsight"
        if "regex" in raw or "rule" in raw:
            return "Rule extraction"
        if "import" in raw or "migration" in raw:
            return "Migration"
        if "infer" in raw or "assistant" in raw or "agent" in raw:
            return "Agent inference"
        return raw.replace("_", " ").replace("-", " ").title()

    @staticmethod
    def _pattern_entity_is_noise(label: str) -> bool:
        text = str(label or "").strip()
        upper = text.upper()
        if not text:
            return True
        if upper in {"USER", "ASSISTANT", "SYSTEM", "API", "HTTP", "HTTPS", "JSON", "SQL", "CLI"}:
            return True
        if re.fullmatch(r"20\d{2}[-/]\d{2}[-/]\d{2}(?:T.*)?", text):
            return True
        if re.fullmatch(r"[0-9a-fA-F]{6,}", text):
            return True
        if re.fullmatch(r"[A-Z0-9_]{8,}", text) and any(ch.isdigit() for ch in text):
            return True
        return False

    @staticmethod
    def _pattern_item(pattern: Any) -> dict[str, Any]:
        data = pattern.to_dict() if hasattr(pattern, "to_dict") else dict(pattern or {})
        metadata = data.get("metadata") or {}
        description = str(data.get("description") or data.get("pattern_type") or "Pattern")
        confidence = float(data.get("confidence") or 0)
        count = metadata.get("count") or metadata.get("total") or metadata.get("hour") or round(confidence * 100)
        try:
            count_value = int(count)
        except Exception:
            count_value = round(confidence * 100)
        query = metadata.get("word") or metadata.get("word1") or metadata.get("source1") or description
        return {
            "label": description,
            "count": count_value,
            "confidence": round(confidence, 3),
            "percent": round(confidence * 100, 1),
            "query": str(query or ""),
            "pattern_type": data.get("pattern_type") or "pattern",
            "samples": data.get("samples") or [],
            "metadata": metadata,
        }

    def pattern_insights(self, limit: int = 10) -> dict[str, Any]:
        """Read-only pattern summary using Mnemosyne's PatternDetector plus separate dashboard taxonomy."""
        limit = max(3, min(int(limit or 10), 30))
        memories = self.list_memories(kind="all", status="active", sort="importance", limit=500)
        triples = self.triples(limit=500)
        topic_counts: Counter[str] = Counter()
        origin_counts: Counter[str] = Counter()
        memory_type_counts: Counter[str] = Counter()

        for m in memories:
            content = str(m.get("content") or "")
            category = self._category_for_text(content)
            topic_counts["Unclassified" if category == "Other" else category] += 1
            origin_counts[self._pattern_origin_label(m.get("source"), "memory")] += 1
            context_type, _ = self._context_type(content, category, "memory")
            memory_type_counts[context_type] += 1

        for t in triples:
            text = f"{t.get('subject')} {t.get('predicate')} {t.get('object')}"
            category = self._category_for_text(text)
            topic_counts["Unclassified" if category == "Other" else category] += 1
            origin_counts[self._pattern_origin_label(t.get("source"), "triple")] += 1
            memory_type_counts["Relationship"] += 1

        def ranked(counter: Counter[str]) -> list[dict[str, Any]]:
            total = sum(counter.values()) or 1
            return [
                {"label": k, "count": v, "percent": round((v / total) * 100, 1), "query": "" if k == "Unclassified" else k}
                for k, v in counter.most_common(limit)
                if k
            ]

        detector_summary: dict[str, Any]
        if PatternDetector is None:
            detector_summary = {
                "total_memories": len(memories),
                "patterns_found": 0,
                "temporal_patterns": [],
                "content_patterns": [],
                "sequence_patterns": [],
                "top_pattern": None,
                "error": "mnemosyne.core.PatternDetector unavailable",
            }
        else:
            detector = PatternDetector(min_confidence=0.35)
            detector_summary = detector.summarize_patterns(memories)

        content_patterns = [self._pattern_item(p) for p in detector_summary.get("content_patterns", [])][:limit]
        temporal_patterns = [self._pattern_item(p) for p in detector_summary.get("temporal_patterns", [])][:limit]
        sequence_patterns = [self._pattern_item(p) for p in detector_summary.get("sequence_patterns", [])][:limit]

        return {
            "read_only": True,
            "provider": "mnemosyne.core.PatternDetector",
            "generated_at": _utc_now(),
            "mnemosyne_summary": detector_summary,
            "content_patterns": content_patterns,
            "temporal_patterns": temporal_patterns,
            "sequence_patterns": sequence_patterns,
            "context_domains": ranked(topic_counts),
            "origins": ranked(origin_counts),
            "memory_types": ranked(memory_type_counts),
            "sources": ranked(origin_counts),
            "signals": [],
            "summary": {
                "indexed_memories": len(memories),
                "indexed_triples": len(triples),
                "patterns_found": detector_summary.get("patterns_found", 0),
                "context_domains": len(topic_counts),
            },
        }

    def constellation(self, limit: int = 240) -> dict[str, Any]:
        limit = max(40, min(int(limit or 240), 600))
        nodes_by_label: dict[str, dict[str, Any]] = {}
        edges: list[dict[str, Any]] = []

        def touch(label: str, kind: str = "entity", weight: float = 1.0, category: str = "Other", timestamp: str = "") -> dict[str, Any]:
            label = str(label or "unknown").strip()[:80]
            if not label:
                label = "unknown"
            node = nodes_by_label.setdefault(label, {"id": f"n{len(nodes_by_label)+1}", "label": label, "kind": kind, "category": category, "weight": 0.0, "count": 0, "last_seen": ""})
            node["weight"] = round(float(node["weight"]) + weight, 3)
            node["count"] = int(node["count"]) + 1
            if timestamp and timestamp > str(node.get("last_seen") or ""):
                node["last_seen"] = timestamp
            if node.get("category") == "Other" and category != "Other":
                node["category"] = category
            return node

        triples = self.triples(limit=limit)
        for t in triples:
            ts = t.get("created_at") or t.get("valid_from") or ""
            s_label, o_label = str(t.get("subject") or ""), str(t.get("object") or "")
            category = self._category_for_text(f"{s_label} {t.get('predicate')} {o_label}")
            s = touch(s_label, weight=float(t.get("confidence") or 0.8), category=category, timestamp=ts)
            o = touch(o_label, weight=float(t.get("confidence") or 0.8), category=category, timestamp=ts)
            edges.append({"id": f"e{t.get('id')}", "source": s["id"], "target": o["id"], "label": t.get("predicate"), "kind": "triple", "item": t})

        memories = self.list_memories(kind="all", status="active", sort="importance", limit=120)
        for m in memories:
            ts = m.get("timestamp") or m.get("created_at") or ""
            content = str(m.get("content") or "")
            category = self._category_for_text(content)
            m_node = touch(f"memory:{str(m.get('id') or '')[:10]}", kind="memory", weight=float(m.get("importance") or 0.4) * 1.5, category=category, timestamp=ts)
            m_node["preview"] = content[:180]
            m_node["memory_id"] = m.get("id")
            for entity in self._entity_terms(content, limit=3):
                e_node = touch(entity, category=category, timestamp=ts)
                edges.append({"id": f"em{m.get('id')}-{e_node['id']}", "source": m_node["id"], "target": e_node["id"], "label": "mentions", "kind": "memory", "item": {"memory_id": m.get("id"), "entity": entity}})

        nodes = sorted(nodes_by_label.values(), key=lambda n: (float(n.get("weight") or 0), str(n.get("last_seen") or "")), reverse=True)[:limit]
        kept = {n["id"] for n in nodes}
        edges = [e for e in edges if e["source"] in kept and e["target"] in kept][:limit * 2]
        clusters = Counter(str(n.get("category") or "Other") for n in nodes)
        return {"read_only": True, "nodes": nodes, "edges": edges, "clusters": [{"label": k, "count": v} for k, v in clusters.most_common()]}

    def global_search(self, q: str = "", limit: int = 30) -> dict[str, Any]:
        q = (q or "").strip()
        if not q:
            return {"query": q, "memories": [], "triples": [], "consolidations": []}
        per_kind = max(1, min(int(limit or 30), 100))
        return {
            "query": q,
            "memories": self.list_memories(kind="all", q=q, sort="recent", limit=per_kind),
            "triples": self.triples(q=q, limit=per_kind),
            "consolidations": self.consolidations(q=q, limit=per_kind),
        }

    def recall_debug(self, q: str = "", limit: int = 20) -> dict[str, Any]:
        q = (q or "").strip()
        rows = self.list_memories(kind="all", q=q, sort="importance", limit=max(1, min(int(limit or 20), 100))) if q else []
        terms = [t.lower() for t in q.split() if t.strip()]
        items = []
        for row in rows:
            content = str(row.get("content") or "")
            lower = content.lower()
            matched_terms = [t for t in terms if t in lower]
            importance = float(row.get("importance") or 0)
            recall_count = int(row.get("recall_count") or 0)
            term_score = len(matched_terms) / max(1, len(terms)) if terms else 0
            approx_score = round(((0.55 * term_score) + (0.30 * importance) + (0.15 * min(recall_count, 10) / 10)) * float(row.get("effective_memory_weight") or 1.0), 4)
            reasons = []
            if matched_terms:
                reasons.append(f"Matched terms: {', '.join(matched_terms[:8])}")
            if importance:
                reasons.append(f"Importance contributes {importance:.2f}")
            if recall_count:
                reasons.append(f"Previously recalled {recall_count} time(s)")
            if row.get("scope"):
                reasons.append(f"Scope: {row.get('scope')}")
            if row.get("source"):
                reasons.append(f"Source: {row.get('source')}")
            if row.get("veracity"):
                reasons.append(f"Trust: {row.get('veracity')} ×{float(row.get('trust_weight') or 1):.2f}")
            if row.get("degradation_label"):
                reasons.append(f"Lifecycle: {row.get('degradation_label')} ×{float(row.get('degradation_weight') or 1):.2f}")
            if row.get("effective_memory_weight") is not None:
                reasons.append(f"Effective memory weight: ×{float(row.get('effective_memory_weight') or 1):.2f}")
            items.append({"memory": row, "approx_score": approx_score, "matched_terms": matched_terms, "reasons": reasons})
        items.sort(key=lambda x: x["approx_score"], reverse=True)
        return {
            "query": q,
            "note": "Approximate debugger: uses text matches, importance, and recall_count available in SQLite. It does not expose Mnemosyne's internal vector score unless upstream stores it.",
            "items": items,
        }

    def timeline(self, q: str = "", group: str = "day", limit: int = 300) -> dict[str, Any]:
        limit = max(1, min(int(limit or 300), 1000))
        q = (q or "").strip()
        memories = self.list_memories(kind="all", q=q, sort="recent", limit=limit)
        triples = self.triples(q=q, limit=limit)
        consolidations = self.consolidations(q=q, limit=limit)
        events: list[dict[str, Any]] = []
        for m in memories:
            ts = m.get("timestamp") or m.get("created_at") or ""
            events.append({"type": "memory", "timestamp": ts, "session_id": m.get("session_id") or "", "title": m.get("tier") or "memory", "preview": str(m.get("content") or "")[:240], "item": m})
        for t in triples:
            ts = t.get("created_at") or t.get("valid_from") or ""
            events.append({"type": "triple", "timestamp": ts, "session_id": "", "title": t.get("predicate") or "triple", "preview": f"{t.get('subject')} → {t.get('object')}", "item": t})
        for c in consolidations:
            ts = c.get("created_at") or ""
            events.append({"type": "consolidation", "timestamp": ts, "session_id": c.get("session_id") or "", "title": f"{c.get('items_consolidated')} items", "preview": c.get("summary_preview") or "", "item": c})
        events.sort(key=lambda e: e.get("timestamp") or "", reverse=True)
        groups: dict[str, list[dict[str, Any]]] = {}
        for e in events[:limit]:
            if group == "session":
                key = e.get("session_id") or "no session"
            else:
                key = (e.get("timestamp") or "unknown")[:10]
            groups.setdefault(key or "unknown", []).append(e)
        return {"query": q, "group": group, "groups": [{"key": k, "events": v, "count": len(v)} for k, v in groups.items()]}

    # ── MEMORIA tables ─────────────────────────────────────────────────

    def memoria_stats(self) -> dict[str, Any]:
        """Overview of all MEMORIA tables."""
        with self.connect() as con:
            tables = self._tables(con)
            stats: dict[str, Any] = {"tables": {}}
            for tbl in ["memoria_facts", "memoria_timelines", "memoria_instructions", "memoria_kg", "memoria_preferences"]:
                if tbl in tables:
                    cols = self._columns(con, tbl)
                    stats["tables"][tbl] = {
                        "count": int(con.execute(f"SELECT count(*) FROM {tbl}").fetchone()[0]),
                        "columns": sorted(cols),
                    }
                else:
                    stats["tables"][tbl] = {"count": 0, "columns": []}
            # Top sessions across MEMORIA tables
            all_sessions: Counter[str] = Counter()
            for tbl in ["memoria_facts", "memoria_timelines", "memoria_instructions", "memoria_preferences"]:
                if tbl in tables and "session_id" in self._columns(con, tbl):
                    for row in con.execute(f"SELECT session_id, count(*) AS c FROM {tbl} GROUP BY session_id ORDER BY c DESC LIMIT 10"):
                        all_sessions[str(row["session_id"] or "default")] += int(row["c"] or 0)
            stats["top_sessions"] = [{"session_id": k, "count": v} for k, v in all_sessions.most_common(10)]
            return stats

    def _memoria_table(self, table: str, q: str = "", limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
        """Generic query against a MEMORIA table."""
        limit = max(1, min(int(limit or 200), 1000))
        offset = max(0, int(offset or 0))
        q = (q or "").strip()
        with self.connect() as con:
            tables = self._tables(con)
            if table not in tables:
                return []
            cols = self._columns(con, table)
            select = ", ".join(cols) if cols else "*"
            # Primary key name differs per table
            pk = "event_id" if table == "memoria_timelines" else "id"
            where = "1=1"
            params: list[Any] = []
            if q:
                # Search across text columns
                text_cols = [c for c in cols if c in ("key", "value", "subject", "predicate", "object", "preference", "instruction", "description", "topic", "context_snippet")]
                if text_cols:
                    conditions = [f"COALESCE({c},'') LIKE ?" for c in text_cols]
                    where = f"({' OR '.join(conditions)})"
                    params = [f"%{q}%"] * len(text_cols)
            rows = con.execute(
                f"SELECT {select} FROM {table} WHERE {where} ORDER BY {pk} DESC LIMIT ? OFFSET ?",
                params + [limit, offset],
            ).fetchall()
            return [dict(r) for r in rows]

    def memoria_facts(self, q: str = "", limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
        return self._memoria_table("memoria_facts", q=q, limit=limit, offset=offset)

    def memoria_timelines(self, q: str = "", limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
        return self._memoria_table("memoria_timelines", q=q, limit=limit, offset=offset)

    def memoria_instructions(self, q: str = "", limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
        return self._memoria_table("memoria_instructions", q=q, limit=limit, offset=offset)

    def memoria_kg(self, q: str = "", limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
        return self._memoria_table("memoria_kg", q=q, limit=limit, offset=offset)

    def memoria_preferences(self, q: str = "", limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
        return self._memoria_table("memoria_preferences", q=q, limit=limit, offset=offset)
