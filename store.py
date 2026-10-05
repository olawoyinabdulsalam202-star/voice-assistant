# Section.

import os
import threading
import time

REDIS_URL = os.getenv("REDIS_URL", "").strip()
APP_ENV   = os.getenv("APP_ENV", "development").strip().lower()
if APP_ENV == "prod":
    APP_ENV = "production"


class MemoryStore:
    """Single-process fallback. Correct for local dev and for a single
    gunicorn worker; wrong for anything else."""

    backend = "memory"

    def __init__(self):
        self._counters = {}    # key -> [timestamps]
        self._values = {}      # key -> (value, expires_at)
        self._lock = threading.Lock()
        self._last_sweep = time.time()

    # Section.
    def _sweep(self):
        """The original dicts grew forever — a slow memory leak on a
        long-running process. Sweep every 10 minutes."""
        now = time.time()
        if now - self._last_sweep < 600:
            return
        self._last_sweep = now
        for key in list(self._values.keys()):
            _, expires = self._values[key]
            if expires and expires < now:
                del self._values[key]
        for key in list(self._counters.keys()):
            if not self._counters[key]:
                del self._counters[key]

    # Section.
    def hit(self, key, window_seconds, limit):
        """Record an event. Returns (allowed, current_count)."""
        with self._lock:
            self._sweep()
            now = time.time()
            stamps = [t for t in self._counters.get(key, []) if now - t < window_seconds]
            if len(stamps) >= limit:
                self._counters[key] = stamps
                return False, len(stamps)
            stamps.append(now)
            self._counters[key] = stamps
            return True, len(stamps)

    def count(self, key, window_seconds):
        with self._lock:
            now = time.time()
            stamps = [t for t in self._counters.get(key, []) if now - t < window_seconds]
            self._counters[key] = stamps
            return len(stamps)

    def add_event(self, key, window_seconds):
        """Record without checking a limit (used for failed logins)."""
        with self._lock:
            now = time.time()
            stamps = [t for t in self._counters.get(key, []) if now - t < window_seconds]
            stamps.append(now)
            self._counters[key] = stamps
            return len(stamps)

    def last_event(self, key, window_seconds):
        with self._lock:
            now = time.time()
            stamps = [t for t in self._counters.get(key, []) if now - t < window_seconds]
            self._counters[key] = stamps
            return stamps[-1] if stamps else None

    def clear(self, key):
        with self._lock:
            self._counters.pop(key, None)

    # Section.
    def set_value(self, key, value, ttl_seconds):
        with self._lock:
            self._sweep()
            self._values[key] = (value, time.time() + ttl_seconds)

    def pop_value(self, key):
        with self._lock:
            item = self._values.pop(key, None)
            if not item:
                return None
            value, expires = item
            return None if time.time() > expires else value

    def ping(self):
        return True


class RedisStore:
    """Shared across every worker. Sorted sets give a true sliding
    window; plain keys with TTL hold the challenges."""

    backend = "redis"

    def __init__(self, url):
        import redis  # imported lazily so the package stays optional
        self._r = redis.from_url(url, decode_responses=True,
                                 socket_connect_timeout=3, socket_timeout=3)
        self._r.ping()   # fail fast at boot, not on first request

    def _zkey(self, key):
        return f"kairos:ctr:{key}"

    def _vkey(self, key):
        return f"kairos:val:{key}"

    def hit(self, key, window_seconds, limit):
        zkey = self._zkey(key)
        now = time.time()
        cutoff = now - window_seconds
        member = f"{now}:{os.urandom(4).hex()}"
        result = self._r.eval(
            """
            redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[2])
            local current = redis.call('ZCARD', KEYS[1])
            if current >= tonumber(ARGV[3]) then return {0, current} end
            redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
            redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
            return {1, current + 1}
            """,
            1, zkey, now, cutoff, limit, member, window_seconds + 60,
        )
        return bool(result[0]), int(result[1])

    def count(self, key, window_seconds):
        zkey = self._zkey(key)
        self._r.zremrangebyscore(zkey, 0, time.time() - window_seconds)
        return self._r.zcard(zkey)

    def add_event(self, key, window_seconds):
        zkey = self._zkey(key)
        now = time.time()
        pipe = self._r.pipeline()
        pipe.zremrangebyscore(zkey, 0, now - window_seconds)
        pipe.zadd(zkey, {f"{now}:{os.urandom(4).hex()}": now})
        pipe.expire(zkey, window_seconds + 60)
        pipe.zcard(zkey)
        results = pipe.execute()
        return results[-1]

    def last_event(self, key, window_seconds):
        zkey = self._zkey(key)
        self._r.zremrangebyscore(zkey, 0, time.time() - window_seconds)
        items = self._r.zrange(zkey, -1, -1, withscores=True)
        return items[0][1] if items else None

    def clear(self, key):
        self._r.delete(self._zkey(key))

    def set_value(self, key, value, ttl_seconds):
        # Challenges are bytes; store hex so decode_responses is safe.
        payload = value.hex() if isinstance(value, (bytes, bytearray)) else str(value)
        self._r.setex(self._vkey(key), ttl_seconds, payload)

    def pop_value(self, key):
        vkey = self._vkey(key)
        pipe = self._r.pipeline()
        pipe.get(vkey)
        pipe.delete(vkey)
        raw, _ = pipe.execute()
        if raw is None:
            return None
        try:
            return bytes.fromhex(raw)
        except ValueError:
            return raw

    def ping(self):
        try:
            return bool(self._r.ping())
        except Exception:
            return False


def build_store():
    """Pick a backend. Falls back to memory rather than refusing to boot,
    but says so loudly."""
    if REDIS_URL:
        try:
            store = RedisStore(REDIS_URL)
            print("🗃️  Shared store: Redis (safe for multiple workers)")
            return store
        except ImportError:
            msg = ("REDIS_URL is set but the 'redis' package isn't installed. "
                   "Run: pip install redis")
            if APP_ENV == "production":
                raise RuntimeError(f"❌ {msg}")
            print(f"⚠️  {msg} — falling back to in-memory.")
        except Exception as e:
            msg = f"Could not connect to Redis ({str(e)[:120]})"
            if APP_ENV == "production":
                raise RuntimeError(
                    f"❌ {msg}. Fix REDIS_URL or unset it to run single-worker."
                )
            print(f"⚠️  {msg} — falling back to in-memory.")

    if APP_ENV == "production":
        raise RuntimeError(
            "❌ REDIS_URL is required in production. Shared rate limits, login "
            "lockouts, and WebAuthn challenges cannot safely use memory across "
            "multiple workers or serverless instances."
        )
    print("🗃️  Shared store: in-memory")
    return MemoryStore()


store = build_store()
