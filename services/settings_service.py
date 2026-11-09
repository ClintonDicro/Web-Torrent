"""Settings validation and persistence."""
from __future__ import annotations

import threading

from config import DEFAULT_SETTINGS
from services.database import Database


class SettingsError(Exception):
    def __init__(self, errors: dict[str, str]):
        super().__init__("Invalid settings")
        self.errors = errors


def _int(name, lo, hi):
    def check(v):
        if isinstance(v, bool) or not isinstance(v, (int, float, str)):
            raise ValueError("must be a whole number")
        try:
            iv = int(str(v).strip())
        except ValueError:
            raise ValueError("must be a whole number")
        if not lo <= iv <= hi:
            raise ValueError(f"must be between {lo} and {hi}")
        return iv
    return check


def _bool(v):
    if isinstance(v, bool):
        return v
    if v in ("true", "1", 1):
        return True
    if v in ("false", "0", 0):
        return False
    raise ValueError("must be true or false")


def _choice(*opts):
    def check(v):
        if v not in opts:
            raise ValueError(f"must be one of: {', '.join(opts)}")
        return v
    return check


def _path(v):
    if not isinstance(v, str):
        raise ValueError("must be a folder path")
    return v.strip()


VALIDATORS = {
    "download_dir": _path,
    "max_active_downloads": _int("max_active_downloads", 1, 20),
    "max_queue_size": _int("max_queue_size", 1, 1000),
    "download_limit_kbps": _int("download_limit_kbps", 0, 10_000_000),
    "upload_limit_kbps": _int("upload_limit_kbps", 0, 10_000_000),
    "listen_port": _int("listen_port", 1024, 65535),
    "open_browser_on_start": _bool,
    "theme": _choice("dark", "light", "system"),
    "notifications": _bool,
    "auto_resume": _bool,
    "seed_after_complete": _bool,
    "enable_dht": _bool,
    "history_retention_days": _int("history_retention_days", 0, 3650),
    "stall_timeout_seconds": _int("stall_timeout_seconds", 1, 3600),
}


class SettingsService:
    def __init__(self, db: Database):
        self.db = db
        self._lock = threading.Lock()
        stored = db.load_settings()
        self._values = {**DEFAULT_SETTINGS, **{k: v for k, v in stored.items() if k in DEFAULT_SETTINGS}}

    def all(self) -> dict:
        with self._lock:
            return dict(self._values)

    def get(self, key: str):
        with self._lock:
            return self._values[key]

    def validate(self, updates: dict) -> dict:
        if not isinstance(updates, dict):
            raise SettingsError({"_": "settings must be a JSON object"})
        errors, clean = {}, {}
        for k, v in updates.items():
            if k not in VALIDATORS:
                errors[k] = "unknown setting"
                continue
            try:
                clean[k] = VALIDATORS[k](v)
            except ValueError as exc:
                errors[k] = str(exc)
        if errors:
            raise SettingsError(errors)
        return clean

    def update(self, clean: dict) -> dict:
        with self._lock:
            self.db.save_settings(clean)
            self._values.update(clean)
            return dict(self._values)
