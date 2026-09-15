# ════════════════════════════════════════════════════════════
#  config_store.py — DB-backed config  (C1-C4, C7, C9, C10)
#
#  WHY NOT persona.json
#  --------------------
#  The old design read/wrote persona.json directly. Four problems:
#
#  1. PUBLICLY DOWNLOADABLE. '.json' is allowlisted by the static
#     guard and persona.json sits in the served directory, so anyone
#     could GET /persona.json. Putting the jailbreak blocklist there
#     would publish it to attackers, who then just pick an unlisted
#     phrase. Hence the public/private split below.
#
#  2. WIPED ON DEPLOY. Render/Railway/Heroku filesystems are
#     ephemeral, so every admin edit silently reverted on next deploy.
#
#  3. PER-WORKER. PERSONA was a module global loaded once at import.
#     With 4 gunicorn workers an admin edit reached 1 of 4 — 75% of
#     users kept the old prompt.
#
#  4. NON-ATOMIC WRITES. json.dump straight onto the live path meant a
#     crash or concurrent save left a truncated file that failed to
#     parse, and load fell back to defaults — silently losing every
#     custom prompt.
#
#  HOW THIS WORKS
#  --------------
#  Postgres `config` table, one row per top-level section. A `version`
#  counter is bumped on every write; each worker re-reads when its
#  cached version is stale or the TTL expires, so all workers converge
#  within seconds. persona.json becomes the seed for first boot only.
# ════════════════════════════════════════════════════════════

import copy
import json
import os
import threading
import time

SEED_PATH = os.path.join(os.path.dirname(__file__), "persona.json")

# Sections never sent to the browser.
PRIVATE_SECTIONS = {"security"}

# Sections safe for /api/config/public.
PUBLIC_SECTIONS = {"wake", "shortcuts", "ui"}

# Persona keys the client may see (the assistant's own name / wake word).
# Full prompts stay server-side so they are not trivially extractable.
PUBLIC_PERSONA_KEYS = {"wake_word", "assistant_name"}

# Entitlements are user-visible and admin-editable. A long cache made a
# successful quota edit appear broken for up to 20 seconds (and longer when
# a browser also cached the profile response). Keep the convergence window
# short; the version check still avoids replacing unchanged config data.
CACHE_TTL_SECONDS = 1


class ConfigStore:
    def __init__(self, get_db):
        self._get_db = get_db
        self._cache = {}
        self._version = -1
        self._fetched_at = 0.0
        self._lock = threading.Lock()
        self._seed = self._load_seed()

    # ── seed ──
    @staticmethod
    def _load_seed():
        try:
            with open(SEED_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            return {k: v for k, v in data.items() if not k.startswith("_")}
        except FileNotFoundError:
            print(f"⚠️  {SEED_PATH} not found — starting with empty config.")
            return {}
        except json.JSONDecodeError as e:
            # Loud, because silently falling back to defaults is exactly
            # how custom prompts used to disappear without anyone noticing.
            print(f"❌ persona.json is not valid JSON ({e}). Using empty config. "
                  f"Fix the file and restart.")
            return {}

    # ── schema ──
    def init_schema(self):
        conn = self._get_db()
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS config (
                    section    TEXT PRIMARY KEY,
                    value      TEXT NOT NULL,
                    version    INTEGER NOT NULL DEFAULT 1,
                    updated_by TEXT,
                    updated_at TEXT NOT NULL
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS config_meta (
                    id      INTEGER PRIMARY KEY,
                    version INTEGER NOT NULL DEFAULT 1
                )
            """)
            conn.execute("""
                INSERT INTO config_meta (id, version) VALUES (1, 1)
                ON CONFLICT (id) DO NOTHING
            """)
            conn.commit()
        finally:
            conn.close()

    def seed_if_empty(self):
        """First boot: copy persona.json into the DB. Existing rows are
        never overwritten, so admin edits are safe across deploys."""
        conn = self._get_db()
        try:
            now = _utcnow()
            inserted = []
            for section, value in self._seed.items():
                row = conn.execute(
                    "SELECT section FROM config WHERE section = ?", (section,)
                ).fetchone()
                if row:
                    continue
                conn.execute(
                    """INSERT INTO config (section, value, version, updated_by, updated_at)
                       VALUES (?, ?, 1, 'seed', ?)""",
                    (section, json.dumps(value), now),
                )
                inserted.append(section)
            conn.commit()
            if inserted:
                print(f"🌱 Seeded config sections from persona.json: "
                      f"{', '.join(inserted)}")
        finally:
            conn.close()

    # ── read ──
    def _remote_version(self, conn):
        row = conn.execute("SELECT version FROM config_meta WHERE id = 1").fetchone()
        return row["version"] if row else 1

    def _refresh(self, force=False):
        now = time.time()
        if not force and (now - self._fetched_at) < CACHE_TTL_SECONDS:
            return

        conn = self._get_db()
        try:
            remote = self._remote_version(conn)
            if not force and remote == self._version and self._cache:
                self._fetched_at = now
                return
            rows = conn.execute("SELECT section, value FROM config").fetchall()
            loaded = {}
            for r in rows:
                try:
                    loaded[r["section"]] = json.loads(r["value"])
                except (json.JSONDecodeError, TypeError):
                    print(f"⚠️  config section '{r['section']}' is corrupt — "
                          f"using seed value for it.")
                    loaded[r["section"]] = copy.deepcopy(
                        self._seed.get(r["section"], {})
                    )
            self._cache = loaded
            self._version = remote
            self._fetched_at = now
        except Exception as e:
            # Never let a config hiccup take down request handling.
            print(f"⚠️  config refresh failed ({e}) — serving last known values.")
            if not self._cache:
                self._cache = copy.deepcopy(self._seed)
            self._fetched_at = now
        finally:
            conn.close()

    def all(self):
        with self._lock:
            self._refresh()
            return copy.deepcopy(self._cache)

    def section(self, name, default=None):
        with self._lock:
            self._refresh()
            value = self._cache.get(name)
            if value is None:
                value = self._seed.get(name, default if default is not None else {})
            return copy.deepcopy(value)

    def get(self, path, default=None):
        """Dotted lookup: cfg.get('persona.system_prompt')."""
        parts = (path or "").split(".")
        if not parts:
            return default
        node = self.section(parts[0])
        for part in parts[1:]:
            if isinstance(node, dict) and part in node:
                node = node[part]
            else:
                return default
        return node if node is not None else default

    # ── write ──
    def update_section(self, name, value, updated_by="admin"):
        """Replace a whole section and bump the global version so other
        workers pick it up. Single transaction — no torn state."""
        if not isinstance(value, (dict, list)):
            raise ValueError("config section must be an object or array")

        conn = self._get_db()
        try:
            now = _utcnow()
            conn.execute(
                """INSERT INTO config (section, value, version, updated_by, updated_at)
                   VALUES (?, ?, 1, ?, ?)
                   ON CONFLICT (section) DO UPDATE SET
                       value      = EXCLUDED.value,
                       version    = config.version + 1,
                       updated_by = EXCLUDED.updated_by,
                       updated_at = EXCLUDED.updated_at""",
                (name, json.dumps(value), updated_by, now),
            )
            conn.execute("UPDATE config_meta SET version = version + 1 WHERE id = 1")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

        with self._lock:
            self._refresh(force=True)

    def patch_section(self, name, updates, updated_by="admin"):
        """Shallow-merge keys into a section. Only replaces provided keys,
        so a partial admin save cannot wipe unrelated settings."""
        current = self.section(name)
        if not isinstance(current, dict):
            raise ValueError(f"section '{name}' is not an object")
        merged = {**current, **(updates or {})}
        self.update_section(name, merged, updated_by)
        return merged

    def reset_section(self, name, updated_by="admin"):
        """Restore one section to the persona.json seed."""
        seed = copy.deepcopy(self._seed.get(name))
        if seed is None:
            raise ValueError(f"no seed value for section '{name}'")
        self.update_section(name, seed, updated_by)
        return seed

    # ── views ──
    def public_view(self, extra=None):
        """Only what the browser needs. Never includes `security`, and
        only whitelisted persona keys."""
        data = self.all()
        out = {k: v for k, v in data.items() if k in PUBLIC_SECTIONS}

        persona = data.get("persona", {}) or {}
        out["persona"] = {
            k: v for k, v in persona.items() if k in PUBLIC_PERSONA_KEYS
        }

        limits = data.get("limits", {}) or {}
        out["limits"] = {
            "free_daily_messages": limits.get("free_daily_messages"),
            "free_per_minute":     limits.get("free_per_minute"),
            "free_file_uploads":   limits.get("free_file_uploads"),
            "free_vision_daily":   limits.get("free_vision_daily"),
            "free_screen_daily":   limits.get("free_screen_daily"),
            "free_memories":       limits.get("free_memories"),
            "free_active_reminders": limits.get("free_active_reminders"),
        }

        if extra:
            out.update(extra)
        return out

    def admin_view(self):
        """Everything, including private sections. Auth-gated by caller."""
        return self.all()

    def editable_sections(self):
        return sorted(set(self.all().keys()) | set(self._seed.keys()))


def _utcnow():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
