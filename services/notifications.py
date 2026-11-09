"""In-memory event feed shown as toasts / desktop notifications in the UI."""
from __future__ import annotations

import itertools
import threading
import time
from collections import deque


class EventFeed:
    def __init__(self, maxlen: int = 200):
        self._events: deque[dict] = deque(maxlen=maxlen)
        self._ids = itertools.count(1)
        self._lock = threading.Lock()

    def push(self, kind: str, message: str, level: str = "info", torrent_id: str | None = None) -> dict:
        ev = {"id": next(self._ids), "kind": kind, "message": message, "level": level,
              "torrent_id": torrent_id, "time": time.time()}
        with self._lock:
            self._events.append(ev)
        return ev

    def since(self, last_id: int) -> list[dict]:
        with self._lock:
            return [e for e in self._events if e["id"] > last_id]

    @property
    def last_id(self) -> int:
        with self._lock:
            return self._events[-1]["id"] if self._events else 0
