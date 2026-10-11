"""Small LRU cache with optional TTL (single event loop, no locking needed)."""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any, Generic, TypeVar

V = TypeVar("V")


class LRUCache(Generic[V]):
    def __init__(self, maxsize: int = 50_000, ttl: float | None = None) -> None:
        self.maxsize = max(0, maxsize)
        self.ttl = ttl
        self._data: OrderedDict[str, tuple[float, V]] = OrderedDict()
        self.hits = 0
        self.misses = 0

    def __len__(self) -> int:
        return len(self._data)

    def __contains__(self, key: str) -> bool:
        return self.get(key, count=False) is not None

    def get(self, key: str, count: bool = True) -> V | None:
        item = self._data.get(key)
        if item is None:
            if count:
                self.misses += 1
            return None
        ts, value = item
        if self.ttl is not None and time.monotonic() - ts > self.ttl:
            del self._data[key]
            if count:
                self.misses += 1
            return None
        self._data.move_to_end(key)
        if count:
            self.hits += 1
        return value

    def put(self, key: str, value: V) -> None:
        if self.maxsize == 0:
            return
        self._data[key] = (time.monotonic(), value)
        self._data.move_to_end(key)
        while len(self._data) > self.maxsize:
            self._data.popitem(last=False)

    def clear(self) -> None:
        self._data.clear()

    def stats(self) -> dict[str, Any]:
        total = self.hits + self.misses
        return {
            "size": len(self._data),
            "max": self.maxsize,
            "hits": self.hits,
            "misses": self.misses,
            "hit_rate": round(self.hits / total, 4) if total else 0.0,
        }
