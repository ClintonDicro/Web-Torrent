"""SQLite persistence for torrent tasks, settings and history."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS torrents (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    total_size      INTEGER NOT NULL,
    selected_size   INTEGER NOT NULL,
    num_files       INTEGER NOT NULL,
    save_path       TEXT NOT NULL,
    torrent_file    TEXT NOT NULL,
    file_priorities TEXT NOT NULL DEFAULT '[]',
    renamed_files   TEXT NOT NULL DEFAULT '{}',
    user_state      TEXT NOT NULL DEFAULT 'active',
    last_status     TEXT,
    error           TEXT,
    added_at        REAL NOT NULL,
    completed_at    REAL,
    removed_at      REAL,
    files_deleted   INTEGER NOT NULL DEFAULT 0,
    downloaded      INTEGER NOT NULL DEFAULT 0,
    uploaded        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

TORRENT_COLUMNS = (
    "id", "name", "total_size", "selected_size", "num_files", "save_path", "torrent_file",
    "file_priorities", "renamed_files", "user_state", "last_status", "error", "added_at",
    "completed_at", "removed_at", "files_deleted", "downloaded", "uploaded",
)


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # --- torrents -------------------------------------------------------- #
    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict | None:
        if row is None:
            return None
        d = dict(row)
        d["file_priorities"] = json.loads(d["file_priorities"] or "[]")
        d["renamed_files"] = {int(k): v for k, v in json.loads(d["renamed_files"] or "{}").items()}
        return d

    def insert_torrent(self, rec: dict) -> None:
        rec = dict(rec)
        rec["file_priorities"] = json.dumps(rec.get("file_priorities", []))
        rec["renamed_files"] = json.dumps({str(k): v for k, v in rec.get("renamed_files", {}).items()})
        rec.setdefault("added_at", time.time())
        cols = [c for c in TORRENT_COLUMNS if c in rec]
        with self._lock:
            # A previously removed record with the same info hash is replaced.
            self._conn.execute("DELETE FROM torrents WHERE id=? AND removed_at IS NOT NULL", (rec["id"],))
            self._conn.execute(
                f"INSERT INTO torrents ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                [rec[c] for c in cols])

    def update_torrent(self, tid: str, **fields) -> None:
        if not fields:
            return
        if "file_priorities" in fields:
            fields["file_priorities"] = json.dumps(fields["file_priorities"])
        if "renamed_files" in fields:
            fields["renamed_files"] = json.dumps({str(k): v for k, v in fields["renamed_files"].items()})
        bad = set(fields) - set(TORRENT_COLUMNS)
        if bad:
            raise ValueError(f"unknown columns {bad}")
        sets = ", ".join(f"{k}=?" for k in fields)
        with self._lock:
            self._conn.execute(f"UPDATE torrents SET {sets} WHERE id=?", [*fields.values(), tid])

    def get_torrent(self, tid: str) -> dict | None:
        with self._lock:
            return self._row(self._conn.execute("SELECT * FROM torrents WHERE id=?", (tid,)).fetchone())

    def active_torrents(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM torrents WHERE removed_at IS NULL ORDER BY added_at").fetchall()
        return [self._row(r) for r in rows]

    def history(self, limit: int = 500) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM torrents ORDER BY added_at DESC LIMIT ?", (limit,)).fetchall()
        return [self._row(r) for r in rows]

    def purge_history(self, retention_days: int) -> int:
        if retention_days <= 0:
            return 0
        cutoff = time.time() - retention_days * 86400
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM torrents WHERE removed_at IS NOT NULL AND removed_at < ?", (cutoff,))
            return cur.rowcount

    # --- settings -------------------------------------------------------- #
    def load_settings(self) -> dict:
        with self._lock:
            rows = self._conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: json.loads(r["value"]) for r in rows}

    def save_settings(self, values: dict) -> None:
        with self._lock:
            self._conn.execute("BEGIN")
            try:
                for k, v in values.items():
                    self._conn.execute(
                        "INSERT INTO settings(key, value) VALUES(?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, json.dumps(v)))
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
