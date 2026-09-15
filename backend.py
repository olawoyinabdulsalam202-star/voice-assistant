"""
════════════════════════════════════════════════════════════
 K.A.I.R.O.S BACKEND  v18
════════════════════════════════════════════════════════════

 WHAT CHANGED FROM v17
 ---------------------
 S2/S3  Signed tokens. "user-token-"+email is gone. So is the admin
        check that accepted the literal string "Bearer admin-token-".
 S4     history is capped, role-filtered and sanitized. It used to be
        spliced into the prompt unvalidated, which bypassed the entire
        jailbreak filter and was an uncapped billing hole.
 S5     Paystack references are recorded and bound to the payer, so one
        reference can no longer upgrade unlimited accounts.
 S7/S8  Real email validation; CORS restricted to known origins.
 S17    Admin bootstrap no longer 500s if someone squats the email.
 S18    X-Forwarded-For is only trusted behind a real proxy.
 A1-A6  Multi-provider chains, circuit breaker, streaming, smart router.
 A9     Quota is charged AFTER success and refunded on provider failure.
 C1-C10 Config lives in Postgres; persona.json is only the seed.
 D1-D11 Real schema, incl. plan expiry and cascade deletes.

 Module layout:
   auth.py          signed tokens
   providers.py     provider registry + fallback + circuit breaker
   router.py        intent -> model chain
   config_store.py  DB-backed config
   plans.py         entitlement, quota, expiry
   migrations.py    schema
════════════════════════════════════════════════════════════
"""

import html
import io
import json
import os
import re
import secrets
import time
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps

from dotenv import load_dotenv

# Env must load before any module reads os.getenv at import time.
load_dotenv()

# Use the operating system trust store when available. This supports local
# Windows environments whose HTTPS traffic is signed by an organization or
# security product certificate that is absent from certifi's bundled roots.
try:
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

from flask import Flask, Response, jsonify, request, stream_with_context
from flask_cors import CORS
import psycopg2
import psycopg2.errors
import psycopg2.extensions
import psycopg2.extras
import psycopg2.pool
import requests
import dns.resolver
from werkzeug.security import check_password_hash, generate_password_hash
from google.oauth2 import id_token as google_id_token
from google.auth.transport import requests as google_auth_requests
import webauthn
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

import auth as auth_mod
import config_store
import migrations
import plans
import providers
import router
from store import store

# ─────────────────────────────────────────
#  ENV
# ─────────────────────────────────────────
APP_ENV         = os.getenv("APP_ENV", "development").strip().lower()
IS_PRODUCTION   = APP_ENV == "production"
DEBUG_ENABLED   = (
    not IS_PRODUCTION
    and os.getenv("FLASK_DEBUG", "0").strip().lower() in {"1", "true", "yes", "on"}
)
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://127.0.0.1:5000").strip().rstrip("/")

ADMIN_EMAIL    = os.getenv("ADMIN_EMAIL", "").strip().lower()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")

SUPABASE_DB_HOST     = os.getenv("SUPABASE_DB_HOST", "").strip()
SUPABASE_DB_PORT     = os.getenv("SUPABASE_DB_PORT", "5432").strip()
SUPABASE_DB_NAME     = os.getenv("SUPABASE_DB_NAME", "postgres").strip()
SUPABASE_DB_USER     = os.getenv("SUPABASE_DB_USER", "").strip()
SUPABASE_DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", "")
SUPABASE_DB_URL      = os.getenv("SUPABASE_DB_URL", "").strip()
DB_POOL_MIN          = int(os.getenv("DB_POOL_MIN", "1"))
DB_POOL_MAX          = int(os.getenv("DB_POOL_MAX", "10"))
DB_CONNECT_TIMEOUT   = int(os.getenv("DB_CONNECT_TIMEOUT_SECONDS", "5"))

BREVO_API_KEY    = os.getenv("BREVO_API_KEY", "").strip()
BREVO_FROM_EMAIL = os.getenv("BREVO_FROM_EMAIL", "").strip()
BREVO_FROM_NAME  = os.getenv("BREVO_FROM_NAME", "K.A.I.R.O.S").strip()
RESEND_API_KEY   = os.getenv("RESEND_API_KEY", "").strip()
RESEND_FROM_EMAIL = os.getenv("RESEND_FROM_EMAIL", BREVO_FROM_EMAIL).strip()
RESEND_FROM_NAME = os.getenv("RESEND_FROM_NAME", BREVO_FROM_NAME).strip()
EMAIL_DAILY_CAP  = int(os.getenv("EMAIL_DAILY_CAP", "300"))
EMAIL_BATCH_SIZE = int(os.getenv("EMAIL_BATCH_SIZE", "25"))
REQUIRE_EMAIL_VERIFICATION = (
    os.getenv("REQUIRE_EMAIL_VERIFICATION", "true").strip().lower() == "true"
)

PAYSTACK_SECRET_KEY = os.getenv("PAYSTACK_SECRET_KEY", "").strip()
PAYSTACK_PUBLIC_KEY = os.getenv("PAYSTACK_PUBLIC_KEY", "").strip()
PRO_PLAN_PRICE_NGN  = int(os.getenv("PRO_PLAN_PRICE_NGN", "4500"))
ORG_PLAN_PRICE_NGN  = int(os.getenv("ORG_PLAN_PRICE_NGN", str(PRO_PLAN_PRICE_NGN)))

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()

WEBAUTHN_RP_ID   = os.getenv("WEBAUTHN_RP_ID", "localhost").strip()
WEBAUTHN_RP_NAME = os.getenv("WEBAUTHN_RP_NAME", "K.A.I.R.O.S").strip()
WEBAUTHN_ORIGIN  = os.getenv("WEBAUTHN_ORIGIN", "http://127.0.0.1:5000").strip()

FREE_DAILY_MESSAGE_LIMIT = int(os.getenv("FREE_DAILY_MESSAGE_LIMIT", "25"))
FREE_PER_MINUTE_LIMIT    = int(os.getenv("FREE_PER_MINUTE_LIMIT", "10"))
FREE_FILE_UPLOAD_LIMIT   = int(os.getenv("FREE_FILE_UPLOAD_LIMIT", "1"))
FREE_VISION_DAILY_LIMIT  = int(os.getenv("FREE_VISION_DAILY_LIMIT", "3"))
FREE_SCREEN_DAILY_LIMIT  = int(os.getenv("FREE_SCREEN_DAILY_LIMIT", "2"))
FREE_MEMORY_LIMIT        = int(os.getenv("FREE_MEMORY_LIMIT", "5"))
FREE_REMINDER_LIMIT      = int(os.getenv("FREE_REMINDER_LIMIT", "3"))
MAX_HISTORY_MESSAGES     = int(os.getenv("MAX_HISTORY_MESSAGES", "20"))
MAX_MESSAGE_CHARS        = int(os.getenv("MAX_MESSAGE_CHARS", "8000"))
MAX_FILE_CONTEXT_CHARS   = int(os.getenv("MAX_FILE_CONTEXT_CHARS", "24000"))

RATE_LIMIT        = int(os.getenv("RATE_LIMIT_REQUESTS", "30"))
RATE_WINDOW       = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60"))
LOCKOUT_THRESHOLD = int(os.getenv("LOCKOUT_THRESHOLD", "5"))
LOCKOUT_WINDOW    = int(os.getenv("LOCKOUT_WINDOW_SECONDS", "300"))
LOCKOUT_DURATION  = int(os.getenv("LOCKOUT_DURATION_SECONDS", "300"))
TRUST_PROXY       = os.getenv("TRUST_PROXY_HEADERS", "false").strip().lower() == "true"

CRON_SECRET = os.getenv("CRON_SECRET", "").strip()


def effective_limit(key, fallback):
    """Read a numeric entitlement from DB config, with env fallback."""
    try:
        value = cfg.get(f"limits.{key}", fallback)
        value = int(value)
        return max(0, value)
    except (TypeError, ValueError):
        return fallback

# ─────────────────────────────────────────
#  PREFLIGHT  (I5)
#
#  Runs before anything connects. Catches the misconfigurations that
#  used to surface as confusing runtime failures — a WEBAUTHN_ORIGIN
#  mismatch producing "verification failed" with nothing in the logs,
#  or multiple workers without Redis silently breaking passkeys.
#  Fatal issues refuse to boot in production, warn in development.
# ─────────────────────────────────────────
import preflight
preflight.run(APP_ENV)

# The DB and provider checks that used to live here are now part of
# preflight, which reports every problem at once instead of failing on
# the first one and hiding the rest.

# ─────────────────────────────────────────
#  APP
# ─────────────────────────────────────────
app = Flask(__name__, static_folder=".", static_url_path="")

# S8: CORS(app) with no arguments sent Access-Control-Allow-Origin: *
# on every route including admin. Locked to known origins now.
_allowed_origins = {PUBLIC_BASE_URL, WEBAUTHN_ORIGIN,
                    "http://127.0.0.1:5000", "http://localhost:5000"}
CORS(
    app,
    resources={r"/api/*": {"origins": list(_allowed_origins)},
               r"/ask*":  {"origins": list(_allowed_origins)},
               r"/vision": {"origins": list(_allowed_origins)},
               r"/screen": {"origins": list(_allowed_origins)},
               r"/memory*": {"origins": list(_allowed_origins)},
               r"/upload_pdf": {"origins": list(_allowed_origins)}},
    supports_credentials=True,
)

# ─────────────────────────────────────────
#  DATABASE
# ─────────────────────────────────────────
if SUPABASE_DB_HOST and SUPABASE_DB_USER and SUPABASE_DB_PASSWORD:
    _pg_pool = psycopg2.pool.ThreadedConnectionPool(
        DB_POOL_MIN, DB_POOL_MAX,
        host=SUPABASE_DB_HOST, port=SUPABASE_DB_PORT, dbname=SUPABASE_DB_NAME,
        user=SUPABASE_DB_USER, password=SUPABASE_DB_PASSWORD,
        connect_timeout=DB_CONNECT_TIMEOUT,
    )
else:
    _pg_pool = psycopg2.pool.ThreadedConnectionPool(
        DB_POOL_MIN, DB_POOL_MAX, dsn=SUPABASE_DB_URL,
        connect_timeout=DB_CONNECT_TIMEOUT,
    )


class _PGCursorWrapper:
    def __init__(self, cursor):
        self._cursor = cursor

    def fetchone(self):
        return self._cursor.fetchone()

    def fetchall(self):
        return self._cursor.fetchall()

    @property
    def rowcount(self):
        return self._cursor.rowcount


class _PGConnWrapper:
    """Small sqlite-shaped facade over a pooled Postgres connection, so
    existing '?' placeholder call sites keep working."""

    def __init__(self, pool):
        self._pool = pool
        self._conn = pool.getconn()
        self._conn.autocommit = False

    def execute(self, sql, params=()):
        cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(sql.replace("?", "%s"), params)
        return _PGCursorWrapper(cur)

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        try:
            # Never hand a connection with an aborted transaction back
            # to the pool — the next borrower inherits the failure.
            if self._conn.status != psycopg2.extensions.STATUS_READY:
                self._conn.rollback()
        except Exception:
            pass
        self._pool.putconn(self._conn)


def get_db():
    return _PGConnWrapper(_pg_pool)


# ─────────────────────────────────────────
#  BOOT: migrations + config
# ─────────────────────────────────────────
migrations.run(get_db)

cfg = config_store.ConfigStore(get_db)
cfg.init_schema()
cfg.seed_if_empty()

require_auth, require_admin, current_user = auth_mod.make_auth_decorators(get_db)

print(f"🚀 KAIROS v18 — env={APP_ENV}")
print(f"🔑 Admin: {ADMIN_EMAIL or '(not set)'}")
_provider_names = [n for n, p in providers.PROVIDERS.items() if p.available]
print(f"🤖 Providers: {', '.join(_provider_names) or 'NONE'}")
if not providers.GROQ_API_KEY:
    print("⚠️  GROQ_API_KEY not set — the free tier will fall back to slower "
          "OpenRouter models. Get a free key at https://console.groq.com/keys")

# ─────────────────────────────────────────
#  STATIC FILE GUARD
#
#  static_folder='.' will serve ANY file in this directory by name,
#  including .env, backend.py and persona.json. Allowlist only real
#  frontend asset types, and block the config seed explicitly — it now
#  holds the jailbreak blocklist, which must not be readable.
# ─────────────────────────────────────────
ALLOWED_STATIC_EXTENSIONS = {
    ".htm", ".html", ".css", ".js", ".png", ".jpg", ".jpeg",
    ".ico", ".mp4", ".svg", ".webmanifest", ".woff", ".woff2", ".ttf",
}
ALLOWED_JSON_FILES = {"manifest.json"}
BLOCKED_FILES = {"persona.json", ".env", ".env.example", "backend.py",
                 "auth.py", "providers.py", "router.py", "config_store.py",
                 "plans.py", "migrations.py", "requirements.txt"}


@app.before_request
def guard_static_files():
    path = request.path
    if path.startswith("/api/") or path in ("/health", "/ask", "/ask/stream",
                                            "/vision", "/screen", "/memory",
                                            "/upload_pdf"):
        return
    last = path.rsplit("/", 1)[-1]
    if not last:
        return
    if last.lower() in BLOCKED_FILES:
        return jsonify({"error": "Not found"}), 404
    if "." in last:
        ext = "." + last.rsplit(".", 1)[-1].lower()
        if ext == ".json":
            if last.lower() not in ALLOWED_JSON_FILES:
                return jsonify({"error": "Not found"}), 404
            return
        if ext not in ALLOWED_STATIC_EXTENSIONS:
            return jsonify({"error": "Not found"}), 404


#  CONTENT SECURITY POLICY  (S9)
#
#  Tokens live in localStorage, so any XSS is a full account compromise.
#  This is the second line of defence behind output escaping.
#
#  'unsafe-inline' is present for script-src because the app has inline
#  <script> blocks and dozens of onclick= handlers. Removing it means
#  extracting every inline handler to an addEventListener — worth doing,
#  but a large mechanical change. The policy still blocks the main
#  exfiltration route (connect-src) and stops injected <script src> from
#  loading off arbitrary hosts, which is what an XSS payload needs.
_CSP = "; ".join([
    "default-src 'self'",
    # cdnjs: three.js, pdf.js, mammoth. jsdelivr: tabler icons (admin).
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com "
    "https://cdn.jsdelivr.net https://js.paystack.co https://accounts.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com "
    "https://cdn.jsdelivr.net",
    "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    # Whitelisting connect-src is the part that matters most: it stops a
    # stolen token being POSTed to an attacker's server.
    "connect-src 'self' https://api.openrouter.ai https://openrouter.ai "
    "https://api.groq.com https://api.open-meteo.com "
    "https://nominatim.openstreetmap.org https://api.paystack.co "
    "https://accounts.google.com",
    "frame-src 'self' https://js.paystack.co https://accounts.google.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
])


@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = (
        "geolocation=(self), microphone=(self), camera=(self), display-capture=(self)"
    )
    response.headers["Content-Security-Policy"] = _CSP
    if request.path in ("/api/config/public", "/api/user/me"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
    if IS_PRODUCTION:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


# ─────────────────────────────────────────
#  RATE LIMITING / LOCKOUT  (S10, S11)
#
#  Backed by store.py, which uses Redis when REDIS_URL is set. These
#  used to be per-process dicts, so with N gunicorn workers a 30/min
#  limit was really 30*N/min and a 5-attempt lockout took 5*N attempts.
# ─────────────────────────────────────────
def client_ip():
    """S18: X-Forwarded-For is client-controlled. Trusting it
    unconditionally let anyone bypass rate limits by rotating the
    header, so it is only honoured behind a known proxy."""
    if TRUST_PROXY:
        fwd = request.headers.get("X-Forwarded-For", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.remote_addr or "unknown"


def is_rate_limited(scope):
    allowed, _ = store.hit(f"rate:{scope}", RATE_WINDOW, RATE_LIMIT)
    return not allowed


def per_minute_limited(user):
    """A10: FREE_PER_MINUTE_LIMIT existed in .env but nothing enforced
    it. Now the free tier gets a burst limit instead of relying only on
    the daily cap — cheap to serve on Groq, and it stops one user
    hammering the shared key."""
    limit = effective_limit("free_per_minute", FREE_PER_MINUTE_LIMIT)
    if limit <= 0 or plans.is_pro_user(user):
        return False, 0
    allowed, current = store.hit(f"pm:{user['id']}", 60, limit)
    return (not allowed), current


def _lockout_key(email):
    # S11: keyed on email + IP. Email-only meant anyone could lock any
    # user out indefinitely with five bad guesses.
    return f"lock:{email}|{client_ip()}"


def is_locked_out(email):
    key = _lockout_key(email)
    count = store.count(key, LOCKOUT_WINDOW)
    if count < LOCKOUT_THRESHOLD:
        return 0
    last = store.last_event(key, LOCKOUT_WINDOW)
    if not last:
        return 0
    remaining = int(LOCKOUT_DURATION - (time.time() - last))
    return remaining if remaining > 0 else 0


def record_failed_login(email):
    store.add_event(_lockout_key(email), LOCKOUT_WINDOW)


def clear_failed_logins(email):
    store.clear(_lockout_key(email))


# ─────────────────────────────────────────
#  INPUT SANITIZATION
# ─────────────────────────────────────────
def _leet_table():
    return str.maketrans(cfg.get("security.leet_map", {}) or {})


def _normalize(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = text.lower().translate(_leet_table())
    text = re.sub(r"(?<=\w) (?=\w\b)", "", text)
    text = re.sub(r"[\-_.*~]+", "", text)
    return re.sub(r"\s+", " ", text).strip()


def is_jailbreak_attempt(text):
    patterns = cfg.get("security.jailbreak_patterns", []) or []
    normalized = _normalize(text)
    raw_lower = text.lower()
    return any(p in normalized or p in raw_lower for p in patterns)


def sanitize_input(text, limit=None):
    """A8: the limit used to be a hard 2000 chars, while the file reader
    sent up to 40 000 — so ~95% of every document was silently discarded
    after being assembled and transmitted. The cap is now configurable
    and matches what the client is told."""
    limit = limit or MAX_MESSAGE_CHARS
    if len(text) > limit:
        text = text[:limit]
    text = "".join(c for c in text if ord(c) >= 32 or c in "\n\t")
    return text.strip()


EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")


def valid_email_format(email):
    """S7: signup previously validated only that the DOMAIN had an MX
    record, never the address format — so
    '<img src=x onerror=...>@gmail.com' registered successfully and then
    executed in the admin panel."""
    return bool(email) and len(email) <= 254 and bool(EMAIL_RE.match(email))


def email_domain_can_receive_mail(email):
    if "@" not in email:
        return False
    domain = email.rsplit("@", 1)[-1].strip().lower()
    if not domain:
        return False
    try:
        try:
            answers = dns.resolver.resolve(domain, "MX", lifetime=5)
            return len(answers) > 0
        except dns.resolver.NoAnswer:
            dns.resolver.resolve(domain, "A", lifetime=5)
            return True
    except (dns.resolver.NXDOMAIN, dns.resolver.NoNameservers):
        return False
    except Exception as e:
        print("DNS check skipped:", e)
        return True


def sanitize_history(raw_history):
    """S4: history was passed straight through — unvalidated, unbounded
    and spliced into the prompt. That bypassed the whole jailbreak
    filter (put the payload in history instead of message) and allowed
    an injected {"role": "system"} turn to override the persona. It was
    also an uncapped billing hole: nothing stopped a 2MB array."""
    if not isinstance(raw_history, list):
        return []
    cleaned = []
    for item in raw_history[-MAX_HISTORY_MESSAGES:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role", "")).strip().lower()
        if role not in ("user", "assistant"):
            continue          # "system" is never accepted from a client
        content = item.get("content")
        if not isinstance(content, str):
            continue
        content = sanitize_input(content, MAX_MESSAGE_CHARS)
        if content:
            cleaned.append({"role": role, "content": content})
    return cleaned


def personalize(text, user):
    name = "friend"
    if user:
        name = (user["preferred_name"] or user["name"] or "friend")
    return (text or "").replace("{{USER_NAME}}", name)


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def audit(admin_email, action, target_type=None, target_id=None, detail=None):
    """N5: previously there was no record of who deleted whom."""
    try:
        conn = get_db()
        conn.execute(
            """INSERT INTO admin_audit_log
                   (admin_email, action, target_type, target_id, detail, ip, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (admin_email, action, target_type, str(target_id) if target_id else None,
             detail, client_ip(), utcnow()),
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print("audit log failed:", e)


# ─────────────────────────────────────────
#  EMAIL (Brevo)
# ─────────────────────────────────────────
_email_session = requests.Session()
_email_session.mount("https://", requests.adapters.HTTPAdapter(max_retries=2))


def _send_brevo(to_email, subject, html):
    if not BREVO_API_KEY:
        print(f"(Brevo not configured — skipped '{subject}' to {to_email})")
        return False

    payload = {
        "sender": {"name": BREVO_FROM_NAME, "email": BREVO_FROM_EMAIL},
        "to": [{"email": to_email}],
        "subject": subject,
        "htmlContent": html,
    }
    headers = {"api-key": BREVO_API_KEY, "Content-Type": "application/json"}

    for attempt in range(2):
        try:
            r = _email_session.post(
                "https://api.brevo.com/v3/smtp/email",
                headers=headers, json=payload, timeout=15,
            )
            if r.status_code >= 400:
                print("Brevo error:", r.status_code, r.text[:300])
                return False
            return True
        except requests.exceptions.SSLError as e:
            print(f"SSL error attempt {attempt + 1}:", str(e)[:200])
            if attempt == 0:
                time.sleep(1)   # retry with a fresh connection, never verify=False
                continue
            return False
        except Exception as e:
            print("Email send failed:", str(e)[:200])
            return False
    return False


def _send_resend(to_email, subject, html):
    if not RESEND_API_KEY or not RESEND_FROM_EMAIL:
        return False
    payload = {
        "from": f"{RESEND_FROM_NAME} <{RESEND_FROM_EMAIL}>",
        "to": [to_email],
        "subject": subject,
        "html": html,
    }
    try:
        r = _email_session.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {RESEND_API_KEY}",
                     "Content-Type": "application/json"},
            json=payload, timeout=15,
        )
        if r.status_code >= 400:
            print("Resend error:", r.status_code, r.text[:300])
            return False
        return True
    except Exception as e:
        print("Resend send failed:", str(e)[:200])
        return False


def send_email(to_email, subject, html):
    """Deliver through Brevo, then fail over to Resend when necessary."""
    if BREVO_API_KEY and BREVO_FROM_EMAIL:
        if _send_brevo(to_email, subject, html):
            return True
        print(f"Brevo delivery failed; trying Resend for '{subject}'")
    if RESEND_API_KEY and RESEND_FROM_EMAIL:
        return _send_resend(to_email, subject, html)
    print(f"(No email provider configured - skipped '{subject}' to {to_email})")
    return False


def _email_shell(body_html):
    return f"""
    <div style="background-color:#0a0a0a;padding:40px 20px;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:480px;margin:0 auto;background-color:#111;border:1px solid #262626;
                  border-radius:12px;padding:32px;color:#e5e5e5;">
        <h1 style="margin:0 0 24px;font-size:20px;letter-spacing:2px;color:#fff;
                   text-transform:uppercase;">K.A.I.R.O.S</h1>
        {body_html}
      </div>
    </div>
    """


def send_welcome_email(to_email, name, verify_token=None):
    whatsapp = "https://whatsapp.com/channel/0029Vb8KHvvH5JLqdS6ruD2s"
    verify_block = ""
    if verify_token:
        link = f"{PUBLIC_BASE_URL}/api/auth/verify-email?token={verify_token}"
        verify_block = f"""
          <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#a3a3a3;">
            Confirm your email so I can send you account notices:
          </p>
          <p style="margin:0 0 28px;">
            <a href="{link}" style="display:inline-block;padding:12px 24px;background:#fff;
               color:#0a0a0a;font-size:14px;font-weight:bold;text-decoration:none;
               border-radius:8px;">Verify my email →</a>
          </p>"""

    send_email(to_email, "Welcome to K.A.I.R.O.S", _email_shell(f"""
        <h2 style="margin:0 0 16px;font-size:22px;color:#fff;">Welcome, {name}!</h2>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#a3a3a3;">
          Your K.A.I.R.O.S account is ready.
        </p>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#a3a3a3;">
          Log in, say <strong style="color:#fff;">"Hey Kairos"</strong> or clap twice,
          and I'll take it from there.
        </p>
        {verify_block}
        <p style="margin:0 0 8px;font-size:13px;color:#737373;">
          <a href="{whatsapp}" style="color:#00d4ff;">Join our WhatsApp channel</a>
          for early access and updates.
        </p>
        <hr style="border:none;border-top:1px solid #262626;margin:28px 0;">
        <p style="margin:0;font-size:12px;color:#525252;">
          You're receiving this because you signed up for K.A.I.R.O.S.
        </p>"""))


def send_reset_email(to_email, reset_link):
    send_email(to_email, "Reset your K.A.I.R.O.S password", _email_shell(f"""
        <h2 style="margin:0 0 16px;font-size:22px;color:#fff;">Password reset</h2>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#a3a3a3;">
          Click below to set a new password. This link expires in 30 minutes.
        </p>
        <p style="margin:0 0 24px;">
          <a href="{reset_link}" style="display:inline-block;padding:12px 24px;background:#fff;
             color:#0a0a0a;font-size:14px;font-weight:bold;text-decoration:none;
             border-radius:8px;">Set a new password →</a>
        </p>
        <p style="margin:0;font-size:13px;color:#737373;">
          If you didn't request this, you can safely ignore it.
        </p>"""))


# ─────────────────────────────────────────
#  PAGE ROUTES
# ─────────────────────────────────────────
@app.route("/", methods=["GET"])
@app.route("/landing.htm", methods=["GET"])
def home():
    return app.send_static_file("main.htm")


@app.route("/auth.htm", methods=["GET"])
@app.route("/login", methods=["GET"])
def serve_auth():
    return app.send_static_file("auth.htm")


@app.route("/onboarding.htm", methods=["GET"])
@app.route("/onboarding", methods=["GET"])
def serve_onboarding():
    return app.send_static_file("onboarding.htm")


@app.route("/app", methods=["GET"])
@app.route("/app/new", methods=["GET"])
@app.route("/index.htm", methods=["GET"])
def serve_dashboard():
    return app.send_static_file("index.htm")


@app.route("/main.htm", methods=["GET"])
@app.route("/kairos.html", methods=["GET"])
def serve_main():
    return app.send_static_file("main.htm")


@app.route("/contact.html", methods=["GET"])
def serve_contact_alias():
    return app.send_static_file("conctact.html")


@app.route("/manual.htm", methods=["GET"])
def serve_manual():
    return app.send_static_file("manual.htm")


@app.route("/settings", methods=["GET"])
@app.route("/settings.htm", methods=["GET"])
def serve_settings():
    return app.send_static_file("settings.htm")


@app.route("/admin", methods=["GET"])
@app.route("/Admn.html", methods=["GET"])
def serve_admin():
    return app.send_static_file("Admn.html")


# ─────────────────────────────────────────
#  AUTH
# ─────────────────────────────────────────
def _login_payload(user, token):
    status = plans.plan_status(user)
    return {
        "token":          token,
        "role":           user["role"],
        "email":          user["email"],
        "user_id":        user["id"],
        "plan":           user["plan_tier"],
        "is_pro":         status["is_pro"],
        "plan_expires_at": status["expires_at"],
        "name":           user["name"] or "",
        "preferred_name": user["preferred_name"] or "",
        "onboarded":      bool(user["onboarded"]),
    }


def _issue_for(user):
    return auth_mod.issue_token(
        user["id"], user["email"], user["role"], user["plan_tier"],
        user["auth_version"] or 0,
    )


@app.route("/api/auth/logout", methods=["POST"])
@require_auth
def logout():
    """Revoke every active token for this account."""
    user = request.kairos_user
    conn = get_db()
    try:
        conn.execute(
            "UPDATE users SET auth_version = COALESCE(auth_version, 0) + 1 WHERE id = ?",
            (user["id"],),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


def _ensure_admin_row(conn, email):
    """S17: the old bootstrap used ON CONFLICT (id) DO NOTHING, which
    does not cover the UNIQUE constraint on email. So if anyone signed
    up as the admin address first, admin login raised UniqueViolation
    and 500'd — locking the admin out permanently. Look up by email
    first, and promote rather than insert."""
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    now = utcnow()
    if row:
        if row["role"] != "admin":
            conn.execute(
                "UPDATE users SET role = 'admin', onboarded = 1 WHERE id = ?",
                (row["id"],),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
        return row

    admin_id = "admin-" + email
    conn.execute(
        """INSERT INTO users (id, email, role, plan_tier, is_pro_override,
                              created_at, name, preferred_name, onboarded,
                              email_verified, unsubscribe_token)
           VALUES (?, ?, 'admin', 'pro', 1, ?, 'Admin', 'Admin', 1, 1, ?)
           ON CONFLICT (id) DO NOTHING""",
        (admin_id, email, now, secrets.token_urlsafe(32)),
    )
    conn.commit()
    return conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()


@app.route("/api/auth/login", methods=["POST"])
def login():
    data     = request.get_json(silent=True) or {}
    email    = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))

    if not email or not password:
        return jsonify({"error": "Email and password required"}), 400

    locked = is_locked_out(email)
    if locked > 0:
        return jsonify({
            "error": f"Too many failed attempts. Try again in {locked} seconds.",
            "locked": True, "retry_after": locked,
        }), 429

    # S13: constant-time compare so the admin password cannot be probed
    # a character at a time via response timing.
    if (ADMIN_EMAIL and email == ADMIN_EMAIL
            and secrets.compare_digest(password, ADMIN_PASSWORD)):
        conn = get_db()
        try:
            user = _ensure_admin_row(conn, email)
            plans.touch_login(conn, user["id"])
            conn.commit()
        finally:
            conn.close()
        clear_failed_logins(email)
        return jsonify(_login_payload(user, _issue_for(user)))

    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    finally:
        conn.close()

    if not user or not user["password_hash"] or \
            not check_password_hash(user["password_hash"], password):
        record_failed_login(email)
        return jsonify({"error": "Invalid credentials"}), 401

    if user["suspended"]:
        return jsonify({"error": "This account has been suspended."}), 403

    conn = get_db()
    try:
        plans.touch_login(conn, user["id"])
        conn.commit()
    finally:
        conn.close()

    clear_failed_logins(email)
    return jsonify(_login_payload(user, _issue_for(user)))


@app.route("/api/auth/signup", methods=["POST"])
def signup():
    data     = request.get_json(silent=True) or {}
    email    = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    name     = sanitize_input(str(data.get("name", "")), 80)
    referral_code = sanitize_input(str(data.get("referral_code", "")).strip().upper(), 40)

    if not email or not password or not name:
        return jsonify({"error": "Name, email and password required"}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters"}), 400
    if not valid_email_format(email):
        return jsonify({"error": "That doesn't look like a valid email address."}), 400
    if not email_domain_can_receive_mail(email):
        return jsonify({"error": "That email address doesn't exist. Double-check it."}), 400

    user_id = str(uuid.uuid4())
    now     = utcnow()
    conn = get_db()
    try:
        referrer = None
        if referral_code:
            referrer = conn.execute(
                "SELECT id FROM users WHERE referral_code = ?", (referral_code,)
            ).fetchone()
        conn.execute(
            """INSERT INTO users (id, email, role, plan_tier, is_pro_override,
                                  created_at, password_hash, name, preferred_name,
                                  onboarded, unsubscribe_token, verify_token,
                                  verify_sent_at, last_login_at, last_seen_at,
                                  referral_code, referred_by)
               VALUES (?, ?, 'user', 'free', 0, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)""",
            (user_id, email, now, generate_password_hash(password), name, name,
             secrets.token_urlsafe(32), secrets.token_urlsafe(32), now, now, now,
             secrets.token_urlsafe(8).upper(), referrer["id"] if referrer else None),
        )
        trial_days = int(effective_limit("new_user_trial_days", 0) or 0)
        if trial_days > 0:
            plans.grant_plan(conn, user_id, "pro", min(trial_days, 365),
                             extend_from_existing=False)
        conn.commit()
        row = conn.execute(
            "SELECT verify_token FROM users WHERE id = ?", (user_id,)
        ).fetchone()
    except psycopg2.errors.UniqueViolation:
        conn.rollback()
        return jsonify({"error": "Email already registered"}), 409
    finally:
        conn.close()

    send_welcome_email(email, name, row["verify_token"] if row else None)
    return jsonify({"message": "Account created. Please log in."}), 201


@app.route("/api/auth/verify-email", methods=["GET"])
def verify_email():
    """E1: signup previously only checked the domain's MX record, so
    typo'd addresses hard-bounced and damaged sender reputation. Marketing
    sends should require email_verified = 1."""
    token = (request.args.get("token") or "").strip()
    if not token:
        return jsonify({"error": "Missing token"}), 400
    conn = get_db()
    try:
        user = conn.execute(
            "SELECT id, referred_by, referral_rewarded FROM users WHERE verify_token = ?", (token,)
        ).fetchone()
        if not user:
            return jsonify({"error": "This link is invalid or already used."}), 400
        conn.execute(
            "UPDATE users SET email_verified = 1, verify_token = NULL WHERE id = ?",
            (user["id"],),
        )
        if user["referred_by"]:
            conn.execute(
                "UPDATE users SET referral_count = COALESCE(referral_count, 0) + 1 WHERE id = ?",
                (user["referred_by"],),
            )
        conn.commit()
    finally:
        conn.close()
    return Response(
        "<html><body style='background:#0a0a0a;color:#e5e5e5;font-family:Arial;"
        "text-align:center;padding:60px;'><h2>Email verified</h2>"
        "<p><a href='/login' style='color:#00d4ff;'>Log in to K.A.I.R.O.S →</a></p>"
        "</body></html>",
        mimetype="text/html",
    )


@app.route("/api/auth/resend-verification", methods=["POST"])
@require_auth
def resend_verification():
    """E1: there was no way to re-send a verification email. A user who
    lost the first one could never verify, and unverified users are
    excluded from campaign sends — so they became permanently
    unreachable."""
    user = request.kairos_user

    if user["email_verified"]:
        return jsonify({"message": "Your email is already verified.",
                        "verified": True})

    # Rate limited per user: this sends real email and burns Brevo quota.
    allowed, _ = store.hit(f"verify:{user['id']}", 3600, 3)
    if not allowed:
        return jsonify({
            "error": "You've requested this a few times already. "
                     "Check your spam folder, then try again in an hour."
        }), 429

    token = secrets.token_urlsafe(32)
    conn = get_db()
    try:
        conn.execute(
            "UPDATE users SET verify_token = ?, verify_sent_at = ? WHERE id = ?",
            (token, utcnow(), user["id"]),
        )
        conn.commit()
    finally:
        conn.close()

    link = f"{PUBLIC_BASE_URL}/api/auth/verify-email?token={token}"
    sent = send_email(
        user["email"], "Verify your K.A.I.R.O.S email", _email_shell(f"""
            <h2 style="margin:0 0 16px;font-size:22px;color:#fff;">Verify your email</h2>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#a3a3a3;">
              Confirm this address so we can send you account notices and
              plan reminders.
            </p>
            <p style="margin:0 0 24px;">
              <a href="{link}" style="display:inline-block;padding:12px 24px;background:#fff;
                 color:#0a0a0a;font-size:14px;font-weight:bold;text-decoration:none;
                 border-radius:8px;">Verify my email →</a>
            </p>
            <p style="margin:0;font-size:13px;color:#737373;">
              If you didn't create a K.A.I.R.O.S account, ignore this message.
            </p>"""))

    if not sent:
        return jsonify({"error": "Could not send the email right now. "
                                 "Please try again shortly."}), 502
    return jsonify({"message": f"Verification email sent to {user['email']}."})


def can_receive_marketing(user):
    """E1/E2: the gate every campaign send must pass through.

    - opted out          -> never, legally
    - unverified address -> skip when REQUIRE_EMAIL_VERIFICATION, because
                            signup only checked the domain's MX record, so
                            typo'd addresses hard-bounce and wreck sender
                            reputation
    - suspended          -> no marketing to a disabled account

    Transactional mail (password reset, receipts, verification itself)
    deliberately does NOT use this gate.
    """
    if not user:
        return False, "no user"
    if not user["email_opt_in"]:
        return False, "unsubscribed"
    if user["suspended"]:
        return False, "suspended"
    if REQUIRE_EMAIL_VERIFICATION and not user["email_verified"]:
        return False, "email not verified"
    return True, None


def unsubscribe_footer(user):
    """Every marketing email needs a working one-click unsubscribe —
    CAN-SPAM / GDPR / NDPR, and Brevo suspends over complaint rate long
    before a regulator gets involved."""
    token = user["unsubscribe_token"]
    if not token:
        return ""
    link = f"{PUBLIC_BASE_URL}/api/auth/unsubscribe?token={token}"
    return (
        '<hr style="border:none;border-top:1px solid #262626;margin:28px 0;">'
        '<p style="margin:0;font-size:12px;color:#525252;">'
        f'Don\'t want these? <a href="{link}" style="color:#737373;">Unsubscribe</a>.'
        '</p>'
    )


@app.route("/api/auth/unsubscribe", methods=["GET"])
def unsubscribe():
    """E2: one-click unsubscribe. Legally required for marketing email
    (CAN-SPAM / GDPR / NDPR), and Brevo will suspend the account over
    complaint rate long before a regulator gets involved."""
    token = (request.args.get("token") or "").strip()
    if not token:
        return jsonify({"error": "Missing token"}), 400
    conn = get_db()
    try:
        user = conn.execute(
            "SELECT id, email FROM users WHERE unsubscribe_token = ?", (token,)
        ).fetchone()
        if not user:
            return jsonify({"error": "Invalid unsubscribe link"}), 400
        conn.execute("UPDATE users SET email_opt_in = 0 WHERE id = ?", (user["id"],))
        conn.commit()
    finally:
        conn.close()
    return Response(
        "<html><body style='background:#0a0a0a;color:#e5e5e5;font-family:Arial;"
        "text-align:center;padding:60px;'><h2>Unsubscribed</h2>"
        "<p style='color:#a3a3a3;'>You won't receive further marketing email. "
        "Account and security notices still apply.</p></body></html>",
        mimetype="text/html",
    )


@app.route("/api/auth/google", methods=["POST"])
def google_auth():
    if not GOOGLE_CLIENT_ID:
        return jsonify({"error": "Google sign-in isn't configured yet."}), 503

    credential = (request.get_json(silent=True) or {}).get("credential", "")
    if not credential:
        return jsonify({"error": "Missing Google credential"}), 400

    try:
        payload = google_id_token.verify_oauth2_token(
            credential, google_auth_requests.Request(), GOOGLE_CLIENT_ID
        )
    except ValueError:
        return jsonify({"error": "Google sign-in verification failed."}), 401

    if not payload.get("email_verified", False):
        return jsonify({"error": "Your Google email isn't verified."}), 401

    email     = payload["email"].strip().lower()
    name      = sanitize_input(payload.get("name", email.split("@")[0]), 80)
    google_id = payload["sub"]
    now       = utcnow()

    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        is_new = not user
        if is_new:
            conn.execute(
                """INSERT INTO users (id, email, role, plan_tier, is_pro_override,
                                      created_at, name, preferred_name, onboarded,
                                      google_id, email_verified, unsubscribe_token,
                                      last_login_at, last_seen_at)
                   VALUES (?, ?, 'user', 'free', 0, ?, ?, ?, 0, ?, 1, ?, ?, ?)""",
                (str(uuid.uuid4()), email, now, name, name, google_id,
                 secrets.token_urlsafe(32), now, now),
            )
            conn.commit()
            user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        else:
            if user["suspended"]:
                return jsonify({"error": "This account has been suspended."}), 403
            if not user["google_id"]:
                conn.execute(
                    "UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?",
                    (google_id, user["id"]),
                )
            plans.touch_login(conn, user["id"])
            conn.commit()
            user = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    finally:
        conn.close()

    if is_new:
        send_welcome_email(email, name)

    clear_failed_logins(email)
    return jsonify(_login_payload(user, _issue_for(user)))


# ─────────────────────────────────────────
#  WEBAUTHN / PASSKEYS
#
#  S12: challenges live in the shared store now. They used to be a
#  module-level dict, which meant that under multiple gunicorn workers
#  the /login/options request stored the challenge on one worker and
#  /login/verify landed on another that had never seen it — so passkey
#  logins failed at random. Users read that as "passkeys are flaky".
# ─────────────────────────────────────────
WEBAUTHN_CHALLENGE_TTL = 300


def _store_webauthn_challenge(key, challenge):
    store.set_value(f"wa:{key}", challenge, WEBAUTHN_CHALLENGE_TTL)


def _pop_webauthn_challenge(key):
    return store.pop_value(f"wa:{key}")


@app.route("/api/auth/webauthn/register/options", methods=["POST"])
@require_auth
def webauthn_register_options():
    user = request.kairos_user
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT credential_id FROM webauthn_credentials WHERE user_id = ?",
            (user["id"],),
        ).fetchall()
    finally:
        conn.close()

    options = webauthn.generate_registration_options(
        rp_id=WEBAUTHN_RP_ID,
        rp_name=WEBAUTHN_RP_NAME,
        user_id=user["id"].encode("utf-8"),
        user_name=user["email"],
        user_display_name=user["name"] or user["email"],
        exclude_credentials=[
            PublicKeyCredentialDescriptor(
                id=webauthn.helpers.base64url_to_bytes(r["credential_id"])
            ) for r in existing
        ],
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
    )
    _store_webauthn_challenge("reg:" + user["id"], options.challenge)
    return webauthn.options_to_json(options), 200, {"Content-Type": "application/json"}


@app.route("/api/auth/webauthn/register/verify", methods=["POST"])
@require_auth
def webauthn_register_verify():
    user = request.kairos_user
    challenge = _pop_webauthn_challenge("reg:" + user["id"])
    if not challenge:
        return jsonify({"error": "Registration expired — try again."}), 400

    data = request.get_json(silent=True) or {}
    try:
        credential = webauthn.helpers.parse_registration_credential_json(json.dumps(data))
        verification = webauthn.verify_registration_response(
            credential=credential,
            expected_challenge=challenge,
            expected_origin=WEBAUTHN_ORIGIN,
            expected_rp_id=WEBAUTHN_RP_ID,
        )
    except Exception as e:
        print("WebAuthn registration failed:", repr(e))
        return jsonify({"error": "Passkey registration failed."}), 400

    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO webauthn_credentials
                   (user_id, credential_id, public_key, sign_count, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (user["id"],
             webauthn.helpers.bytes_to_base64url(verification.credential_id),
             webauthn.helpers.bytes_to_base64url(verification.credential_public_key),
             verification.sign_count, utcnow()),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.route("/api/auth/webauthn/login/options", methods=["POST"])
def webauthn_login_options():
    options = webauthn.generate_authentication_options(
        rp_id=WEBAUTHN_RP_ID,
        user_verification=UserVerificationRequirement.PREFERRED,
    )
    challenge_key = secrets.token_urlsafe(16)
    _store_webauthn_challenge("auth:" + challenge_key, options.challenge)
    payload = json.loads(webauthn.options_to_json(options))
    payload["challengeKey"] = challenge_key
    return jsonify(payload)


@app.route("/api/auth/webauthn/login/verify", methods=["POST"])
def webauthn_login_verify():
    data = request.get_json(silent=True) or {}
    challenge_key = data.pop("challengeKey", "")
    challenge = _pop_webauthn_challenge("auth:" + challenge_key)
    if not challenge:
        return jsonify({"error": "Login expired — try again."}), 400

    try:
        credential = webauthn.helpers.parse_authentication_credential_json(json.dumps(data))
    except Exception:
        return jsonify({"error": "Invalid passkey response."}), 400

    cred_id_b64 = webauthn.helpers.bytes_to_base64url(credential.raw_id)
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM webauthn_credentials WHERE credential_id = ?", (cred_id_b64,)
        ).fetchone()
        if not row:
            return jsonify({"error": "Passkey not recognised."}), 401

        try:
            verification = webauthn.verify_authentication_response(
                credential=credential,
                expected_challenge=challenge,
                expected_rp_id=WEBAUTHN_RP_ID,
                expected_origin=WEBAUTHN_ORIGIN,
                credential_public_key=webauthn.helpers.base64url_to_bytes(row["public_key"]),
                credential_current_sign_count=row["sign_count"],
            )
        except Exception as e:
            print("WebAuthn login verification failed:", repr(e))
            return jsonify({"error": "Passkey verification failed."}), 401

        conn.execute(
            "UPDATE webauthn_credentials SET sign_count = ? WHERE id = ?",
            (verification.new_sign_count, row["id"]),
        )
        user = conn.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
        if not user:
            return jsonify({"error": "Account not found."}), 404
        if user["suspended"]:
            return jsonify({"error": "This account has been suspended."}), 403
        plans.touch_login(conn, user["id"])
        conn.commit()
        user = conn.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
    finally:
        conn.close()

    clear_failed_logins(user["email"])
    return jsonify(_login_payload(user, _issue_for(user)))


# ─────────────────────────────────────────
#  PASSWORD RESET
# ─────────────────────────────────────────
@app.route("/api/auth/forgot-password", methods=["POST"])
def forgot_password():
    # S16: rate limited. Without this it was a free email-bombing tool
    # that also burned the Brevo daily quota.
    if is_rate_limited(f"forgot:{client_ip()}"):
        return jsonify({"error": "Too many requests. Please wait a moment."}), 429

    email = str((request.get_json(silent=True) or {}).get("email", "")).strip().lower()
    if not email:
        return jsonify({"error": "Email is required"}), 400

    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if user and user["password_hash"]:
            token = secrets.token_urlsafe(32)
            expires = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
            conn.execute(
                "UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?",
                (token, expires, user["id"]),
            )
            conn.commit()
            send_reset_email(email, f"{PUBLIC_BASE_URL}/auth.htm?token={token}")
    finally:
        conn.close()

    # Identical response either way — never reveal whether an email exists.
    return jsonify({"message": "If that email is registered, a reset link has been sent."})


@app.route("/api/auth/reset-password", methods=["POST"])
def reset_password():
    data     = request.get_json(silent=True) or {}
    token    = str(data.get("token") or "").strip()
    password = str(data.get("password", ""))

    if not token or not password:
        return jsonify({"error": "Token and new password required"}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters"}), 400

    conn = get_db()
    try:
        user = conn.execute(
            "SELECT * FROM users WHERE reset_token = ?", (token,)
        ).fetchone()
        if not user:
            return jsonify({"error": "This reset link is invalid or has already been used."}), 400

        expires = user["reset_token_expires"]
        if not expires or datetime.now(timezone.utc) > datetime.fromisoformat(expires):
            return jsonify({"error": "This reset link has expired. Request a new one."}), 400

        conn.execute(
            """UPDATE users SET password_hash = ?, reset_token = NULL,
                   reset_token_expires = NULL,
                   auth_version = COALESCE(auth_version, 0) + 1 WHERE id = ?""",
            (generate_password_hash(password), user["id"]),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"message": "Password updated. You can now log in."})


# ═════════════════════════════════════════
#  CHAT
# ═════════════════════════════════════════
def _build_messages(user, prompt_key, user_message, history):
    system_prompt = cfg.get(f"persona.{prompt_key}") or cfg.get("persona.system_prompt", "")
    messages = [{"role": "system", "content": personalize(system_prompt, user)}]
    messages.extend(history)
    messages.append({"role": "user", "content": user_message})
    return messages


def _route_for(user, text, forced_intent=None):
    decision = router.resolve(
        text,
        cfg.section("routing"),
        plans.is_pro_user(user),
        forced_intent=forced_intent,
    )
    # Keep the configured free/pro chains and their cost ordering, but make
    # the paid OpenAI account a last-resort text fallback. This matters when
    # Groq/OpenRouter are rate-limited or unavailable; previously an available
    # OpenAI key was never tried for Free users because it was absent from the
    # Free chain. Vision/screen routing remains explicitly configured.
    if (not forced_intent and providers.PROVIDERS["openai"].available
            and "openai/gpt-4o-mini" not in decision["chain"]):
        decision["chain"].append("openai/gpt-4o-mini")
    return decision


def _dev_credit_check(text):
    keywords = [
        "who made you", "who built you", "who developed you", "who created you",
        "who is your developer", "who designed you", "who programmed you",
        "your creator", "your developer", "who owns you", "who is your owner",
        "who is your maker", "who is your founder",
    ]
    lower = text.lower()
    return any(k in lower for k in keywords)


def _prepare_chat(forced_intent=None, image_field=None, max_bytes=None):
    """Shared front half of /ask, /ask/stream, /vision, /screen.

    Returns (error_response, context) — exactly one is None.
    """
    if is_rate_limited(client_ip()):
        return (jsonify({"error": "Too many requests. Please wait a moment."}), 429), None

    user = current_user()
    if not user:
        return (jsonify({"error": "Please log in to use K.A.I.R.O.S.",
                         "auth_required": True}), 401), None

    if user["suspended"]:
        return (jsonify({"error": "This account has been suspended."}), 403), None

    # A10: burst limit for free users. The env var existed but nothing
    # read it — the daily cap was the only control, so one user could
    # empty their whole allowance (and hammer the shared provider key)
    # in a few seconds.
    limited, _ = per_minute_limited(user)
    if limited:
        return (jsonify({
            "error": f"You're sending messages too quickly — the free plan "
                     f"allows {effective_limit('free_per_minute', FREE_PER_MINUTE_LIMIT)} per minute. "
                     f"Upgrade to Pro to remove this limit.",
            "rate_limited": True,
        }), 429), None

    if max_bytes and request.content_length and request.content_length > max_bytes:
        return (jsonify({"error": "Image too large."}), 413), None

    data = request.get_json(silent=True)
    if not data:
        return (jsonify({"error": "No data provided"}), 400), None

    if image_field:
        if image_field not in data:
            return (jsonify({"error": "No image provided"}), 400), None
        question = sanitize_input(str(data.get("question", "What do you see? Guide me.")))
        image_b64 = data[image_field]
        if "," in image_b64:
            image_b64 = image_b64.split(",")[1]
    else:
        if "message" not in data:
            return (jsonify({"error": "No message provided"}), 400), None
        question = sanitize_input(str(data["message"]))
        image_b64 = None

    if not question:
        return (jsonify({"error": "Empty message"}), 400), None

    if is_jailbreak_attempt(question):
        key = {"vision": "jailbreak_refusal_vision",
               "screen": "jailbreak_refusal_screen"}.get(forced_intent,
                                                         "jailbreak_refusal_ask")
        refusal = personalize(cfg.get(f"persona.{key}", "I can't process that."), user)
        return (jsonify({"reply": refusal, "refused": True}), 200), None

    history = sanitize_history(data.get("history", [])) if not image_field else []

    # A9: reserve the quota slot, but refund it if the provider fails.
    # Previously the quota was charged before the AI call, so an outage
    # burned a free user's entire daily allowance on error messages.
    conn = get_db()
    try:
        ok, used, limit = plans.reserve_message(conn, user, effective_limit("free_daily_messages", FREE_DAILY_MESSAGE_LIMIT))
        conn.commit()
    finally:
        conn.close()

    if not ok:
        msg = cfg.get("ui.quota_reached", "You've reached today's free-plan limit.")
        return (jsonify({
            "error": msg.replace("{{LIMIT}}", str(limit)),
            "limit_reached": True,
        }), 402), None

    return None, {
        "user": user, "question": question, "history": history,
        "image_b64": image_b64, "forced_intent": forced_intent,
    }


def _refund(user):
    try:
        conn = get_db()
        plans.refund_message(conn, user)
        conn.commit()
        conn.close()
    except Exception as e:
        print("quota refund failed:", e)


def _refund_feature(user, feature):
    try:
        conn = get_db()
        plans.refund_daily_feature(conn, user, feature)
        conn.commit()
        conn.close()
    except Exception as e:
        print("feature quota refund failed:", e)


@app.route("/ask", methods=["POST"])
def ask():
    err, ctx = _prepare_chat()
    if err:
        return err

    user, question, history = ctx["user"], ctx["question"], ctx["history"]

    # Answered locally — no model call, no quota impact worth refunding.
    if _dev_credit_check(question):
        return jsonify({
            "reply": cfg.get("persona.dev_credit_response", ""),
            "route": {"intent": "local", "label": "Built-in", "model": "kairos"},
        })

    decision = _route_for(user, question)
    messages = _build_messages(user, decision["system_prompt_key"], question, history)

    try:
        result = providers.complete(
            decision["chain"], messages,
            max_tokens=decision["max_tokens"],
            temperature=decision["temperature"],
        )
    except providers.AllProvidersFailed as e:
        print("All providers failed on /ask:", e)
        _refund(user)
        return jsonify({
            "error": cfg.get("ui.error_all_providers_down",
                             "All my AI providers are unreachable right now."),
        }), 503
    except Exception as e:
        print("Backend /ask error:", repr(e))
        _refund(user)
        return jsonify({"error": cfg.get("ui.error_generic", "Something went wrong.")}), 500

    return jsonify({
        "reply": result["text"],
        "route": {
            "intent":   decision["intent"],
            "label":    decision["label"],
            "model":    result["model"],
            "provider": result["provider"],
            "tier":     decision["tier"],
        },
    })


@app.route("/ask/stream", methods=["POST"])
def ask_stream():
    """A3: the single biggest perceived-speed fix. The old flow awaited
    the entire completion before showing anything, which is most of why
    replies felt like they took 30 seconds. Here the first token reaches
    the browser in roughly a second."""
    err, ctx = _prepare_chat()
    if err:
        return err

    user, question, history = ctx["user"], ctx["question"], ctx["history"]

    if _dev_credit_check(question):
        reply = cfg.get("persona.dev_credit_response", "")

        def _local():
            yield f"data: {json.dumps({'delta': reply})}\n\n"
            yield "data: [DONE]\n\n"

        return Response(_local(), mimetype="text/event-stream")

    decision = _route_for(user, question)
    messages = _build_messages(user, decision["system_prompt_key"], question, history)

    try:
        gen, meta = providers.stream(
            decision["chain"], messages,
            max_tokens=decision["max_tokens"],
            temperature=decision["temperature"],
        )
    except providers.AllProvidersFailed as e:
        print("All providers failed on /ask/stream:", e)
        _refund(user)
        return jsonify({
            "error": cfg.get("ui.error_all_providers_down",
                             "All my AI providers are unreachable right now."),
        }), 503

    def _events():
        # Route info first so the UI can show the model badge immediately.
        route_evt = {
            "route": {
                "intent":   decision["intent"],
                "label":    decision["label"],
                "model":    meta["model"],
                "provider": meta["provider"],
                "tier":     decision["tier"],
            }
        }
        yield "data: " + json.dumps(route_evt) + "\n\n"

        produced = False
        try:
            for delta in gen:
                produced = True
                yield "data: " + json.dumps({"delta": delta}) + "\n\n"
        except Exception as e:
            print("stream interrupted:", repr(e))
            if not produced:
                yield "data: " + json.dumps(
                    {"error": "The reply was interrupted."}
                ) + "\n\n"
        yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(_events()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",   # stops nginx buffering the stream
            "Connection": "keep-alive",
        },
    )


def _vision_like(forced_intent, max_bytes, default_error):
    err, ctx = _prepare_chat(forced_intent=forced_intent,
                             image_field="image", max_bytes=max_bytes)
    if err:
        return err

    user, question, image_b64 = ctx["user"], ctx["question"], ctx["image_b64"]
    feature_limit = effective_limit("free_vision_daily", FREE_VISION_DAILY_LIMIT) if forced_intent == "vision" else effective_limit("free_screen_daily", FREE_SCREEN_DAILY_LIMIT)
    conn = get_db()
    try:
        feature_ok, feature_used, _ = plans.reserve_daily_feature(
            conn, user, forced_intent, feature_limit
        )
        conn.commit()
    finally:
        conn.close()
    if not feature_ok:
        _refund(user)
        label = "camera analyses" if forced_intent == "vision" else "screen analyses"
        return jsonify({
            "error": f"You have used all {feature_limit} free {label} for today.",
            "limit_reached": True,
            "pro_required": True,
            "feature": forced_intent,
            "used": feature_used,
            "limit": feature_limit,
        }), 402

    decision = _route_for(user, question, forced_intent=forced_intent)

    # Older database routing rows may still contain OpenAI-only vision chains.
    # Keep those admin edits, but append current OpenRouter vision fallbacks.
    if forced_intent in ("vision", "screen"):
        fallbacks = ["google/gemini-2.5-flash", "openai/gpt-4o-mini"]
        decision["chain"] = list(dict.fromkeys((decision.get("chain") or []) + fallbacks))

    if not decision["chain"]:
        _refund(user)
        _refund_feature(user, forced_intent)
        return jsonify({"error": "No vision model is configured on this server."}), 503

    if not any(p.available for p in providers.PROVIDERS.values()):
        _refund(user)
        _refund_feature(user, forced_intent)
        return jsonify({
            "error": "Vision is not configured. Add OPENAI_API_KEY (or an OpenRouter key) to the backend environment and restart KAIROS.",
            "configuration_required": True,
        }), 503

    system_prompt = cfg.get(f"persona.{decision['system_prompt_key']}", "")
    detail = "low" if forced_intent == "vision" else "high"
    messages = [
        {"role": "system", "content": personalize(system_prompt, user)},
        {"role": "user", "content": [
            {"type": "image_url",
             "image_url": {"url": f"data:image/jpeg;base64,{image_b64}", "detail": detail}},
            {"type": "text", "text": question},
        ]},
    ]

    try:
        result = providers.complete(
            decision["chain"], messages,
            max_tokens=decision["max_tokens"],
            temperature=decision["temperature"],
            timeout=providers.TIMEOUT_VISION,
        )
    except providers.AllProvidersFailed as e:
        print(f"All providers failed on /{forced_intent}:", e)
        _refund(user)
        _refund_feature(user, forced_intent)
        return jsonify({"error": default_error}), 503
    except Exception as e:
        print(f"Backend /{forced_intent} error:", repr(e))
        _refund(user)
        _refund_feature(user, forced_intent)
        return jsonify({"error": default_error}), 500

    return jsonify({
        "reply": result["text"],
        "usage": {"feature": forced_intent, "used": feature_used,
                  "limit": None if plans.is_pro_user(user) else feature_limit},
        "route": {"intent": decision["intent"], "label": decision["label"],
                  "model": result["model"], "provider": result["provider"]},
    })


@app.route("/vision", methods=["POST"])
def vision():
    return _vision_like("vision", 5_000_000, "Vision analysis failed.")


@app.route("/screen", methods=["POST"])
def screen():
    return _vision_like("screen", 8_000_000, "Screen analysis failed.")


# ─────────────────────────────────────────
#  CONFIG / PROFILE
# ─────────────────────────────────────────
@app.route("/api/config/public", methods=["GET"])
def public_config():
    """C2: wake words, shortcuts and UI copy now come from here, so the
    admin panel can change them without a deploy. Private sections
    (jailbreak patterns, full prompts) are never included."""
    return jsonify(cfg.public_view(extra={
        "paystack_public_key": PAYSTACK_PUBLIC_KEY,
        "pro_price_ngn":       PRO_PLAN_PRICE_NGN,
        "org_price_ngn":       ORG_PLAN_PRICE_NGN,
        "google_client_id":    GOOGLE_CLIENT_ID,
        "free_daily_limit":    effective_limit("free_daily_messages", FREE_DAILY_MESSAGE_LIMIT),
        "limits": {
            "free_daily_messages":    effective_limit("free_daily_messages", FREE_DAILY_MESSAGE_LIMIT),
            "free_per_minute":        effective_limit("free_per_minute", FREE_PER_MINUTE_LIMIT),
            "free_file_uploads":      effective_limit("free_file_uploads", FREE_FILE_UPLOAD_LIMIT),
            "free_vision_daily":      effective_limit("free_vision_daily", FREE_VISION_DAILY_LIMIT),
            "free_screen_daily":      effective_limit("free_screen_daily", FREE_SCREEN_DAILY_LIMIT),
            "free_memories":          effective_limit("free_memories", FREE_MEMORY_LIMIT),
            "free_active_reminders":  effective_limit("free_active_reminders", FREE_REMINDER_LIMIT),
            "max_file_context_chars": MAX_FILE_CONTEXT_CHARS,
            "max_message_chars":      MAX_MESSAGE_CHARS,
        },
        "referrals": cfg.section("referrals", {"enabled": False, "required_referrals": 5, "reward_type": "pro_days", "reward_amount": 1}),
    }))


@app.route("/api/user/me", methods=["GET"])
@require_auth
def user_me():
    user = request.kairos_user
    status = plans.plan_status(user)
    referral_cfg = cfg.section("referrals", {}) or {}

    conn = get_db()
    try:
        referral_code = user["referral_code"]
        referral_created = False
        if not referral_code:
            referral_code = secrets.token_urlsafe(8).upper()
            conn.execute("UPDATE users SET referral_code = ? WHERE id = ?",
                         (referral_code, user["id"]))
            referral_created = True
        feature_usage = plans.daily_feature_usage(conn, user["id"])
        feature_usage["memories"] = conn.execute(
            "SELECT COUNT(*) AS n FROM memories WHERE user_id = ?",
            (user["id"],),
        ).fetchone()["n"]
        feature_usage["active_reminders"] = conn.execute(
            "SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND fired = 0",
            (user["id"],),
        ).fetchone()["n"]
        if plans.touch_seen(conn, user["id"]) or referral_created:
            conn.commit()
    finally:
        conn.close()

    return jsonify({
        "email":               user["email"],
        "role":                user["role"],
        "name":                user["name"] or "",
        "preferred_name":      user["preferred_name"] or "",
        "plan":                user["plan_tier"],
        "is_pro":              status["is_pro"],
        "plan_expires_at":     status["expires_at"],
        "plan_days_left":      status["days_left"],
        "in_grace_period":     status["in_grace"],
        "onboarded":           bool(user["onboarded"]),
        "email_verified":      bool(user["email_verified"]),
        "referral_code":       referral_code,
        "referral": {
            "enabled": bool(referral_cfg.get("enabled")),
            "count": int(user.get("referral_count") or 0),
            "claimed": int(user.get("referral_claimed") or 0),
            "credits": int(user.get("credit_balance") or 0),
            "required_referrals": int(referral_cfg.get("required_referrals", 5) or 5),
            "reward_type": referral_cfg.get("reward_type", "pro_days"),
            "reward_amount": int(referral_cfg.get("reward_amount", 1) or 1),
        },
        "messages_used_today": plans.messages_used_today(user),
        "daily_limit":         None if status["is_pro"] else effective_limit("free_daily_messages", FREE_DAILY_MESSAGE_LIMIT),
        "file_uploads_used":   user["file_uploads_used"] or 0,
        "file_upload_limit":   None if status["is_pro"] else effective_limit("free_file_uploads", FREE_FILE_UPLOAD_LIMIT),
        "feature_usage_today": feature_usage,
        "feature_limits": {
            "vision": None if status["is_pro"] else effective_limit("free_vision_daily", FREE_VISION_DAILY_LIMIT),
            "screen": None if status["is_pro"] else effective_limit("free_screen_daily", FREE_SCREEN_DAILY_LIMIT),
            "memories": None if status["is_pro"] else effective_limit("free_memories", FREE_MEMORY_LIMIT),
            "active_reminders": None if status["is_pro"] else effective_limit("free_active_reminders", FREE_REMINDER_LIMIT),
        },
    })


@app.route("/api/referrals/claim", methods=["POST"])
@require_auth
def claim_referral_reward():
    referral_cfg = cfg.section("referrals", {}) or {}
    if not referral_cfg.get("enabled"):
        return jsonify({"error": "Referrals are not currently active."}), 400
    required = max(1, int(referral_cfg.get("required_referrals", 5) or 5))
    reward_type = str(referral_cfg.get("reward_type", "pro_days"))
    amount = max(1, int(referral_cfg.get("reward_amount", 1) or 1))
    if reward_type not in ("pro_days", "credits"):
        return jsonify({"error": "The referral reward configuration is invalid."}), 500

    conn = get_db()
    try:
        row = conn.execute(
            "SELECT referral_count, referral_claimed FROM users WHERE id = ? FOR UPDATE",
            (request.kairos_user["id"],),
        ).fetchone()
        count = int(row["referral_count"] or 0)
        claimed = int(row["referral_claimed"] or 0)
        available = count // required - claimed
        if available < 1:
            return jsonify({"error": f"You need {required} verified referrals for the next reward."}), 400
        if reward_type == "pro_days":
            plans.grant_plan(conn, request.kairos_user["id"], "pro", amount)
            message = f"Referral reward claimed: {amount} Pro day(s)."
        else:
            conn.execute(
                "UPDATE users SET credit_balance = COALESCE(credit_balance, 0) + ? WHERE id = ?",
                (amount, request.kairos_user["id"]),
            )
            message = f"Referral reward claimed: {amount} credits."
        conn.execute(
            "UPDATE users SET referral_claimed = COALESCE(referral_claimed, 0) + 1 WHERE id = ?",
            (request.kairos_user["id"],),
        )
        now = utcnow()
        conn.execute(
            """INSERT INTO notifications
               (user_id, template_key, channel, subject, body, status, scheduled_at, created_at)
               VALUES (?, ?, 'in_app', 'Referral reward', ?, 'delivered', ?, ?)""",
            (request.kairos_user["id"], f"referral_claim_{claimed + 1}", message, now, now),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "message": message})


@app.route("/api/user/onboard", methods=["POST"])
@require_auth
def user_onboard():
    user = request.kairos_user
    data = request.get_json(silent=True) or {}
    preferred_name = sanitize_input(str(data.get("preferred_name", "")), 50)
    plan = data.get("plan", "free")

    if plan not in ("free", "pro", "organisation"):
        return jsonify({"error": "Invalid plan"}), 400
    if not preferred_name:
        return jsonify({"error": "preferred_name is required"}), 400

    conn = get_db()
    try:
        # Paid tiers only take effect once Paystack verifies — the name
        # is saved now so the modal doesn't block the user.
        conn.execute(
            "UPDATE users SET preferred_name = ?, onboarded = 1 WHERE id = ?",
            (preferred_name, user["id"]),
        )
        if plan == "free":
            conn.execute("UPDATE users SET plan_tier = 'free' WHERE id = ?", (user["id"],))
        conn.commit()
    finally:
        conn.close()

    return jsonify({"ok": True, "preferred_name": preferred_name,
                    "plan": plan, "payment_required": plan != "free"})


# ─────────────────────────────────────────
#  PAYSTACK
# ─────────────────────────────────────────
@app.route("/api/payment/paystack/verify", methods=["POST"])
@require_auth
def paystack_verify():
    user = request.kairos_user
    if not PAYSTACK_SECRET_KEY:
        return jsonify({"error": "Payments are not configured on this server yet."}), 503

    data      = request.get_json(silent=True) or {}
    reference = str(data.get("reference", "")).strip()
    plan      = data.get("plan", "pro")

    if not reference:
        return jsonify({"error": "Missing payment reference"}), 400
    if plan not in ("pro", "organisation"):
        return jsonify({"error": "Invalid plan"}), 400

    # S5: the reference was never recorded, so ONE successful payment
    # reference could be replayed by anyone to get Pro — post it in a
    # group chat and everyone upgrades free.
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT user_id FROM payments WHERE reference = ?", (reference,)
        ).fetchone()
        if existing:
            if existing["user_id"] == user["id"]:
                return jsonify({"error": "This payment has already been applied.",
                                "already_applied": True}), 409
            return jsonify({"error": "That payment reference is not valid for this account."}), 403
    finally:
        conn.close()

    required_ngn = PRO_PLAN_PRICE_NGN if plan == "pro" else ORG_PLAN_PRICE_NGN

    try:
        resp = requests.get(
            f"https://api.paystack.co/transaction/verify/{reference}",
            headers={"Authorization": f"Bearer {PAYSTACK_SECRET_KEY}"},
            timeout=15,
        )
        result = resp.json()
    except Exception as e:
        print("Paystack verify error:", e)
        return jsonify({"error": "Could not reach Paystack. Try again."}), 502

    tx = result.get("data") or {}
    if result.get("status") is not True or tx.get("status") != "success":
        return jsonify({"error": "Payment was not successful."}), 402

    paid_kobo = tx.get("amount", 0)
    if paid_kobo < required_ngn * 100:
        return jsonify({"error": "Amount paid does not meet the plan's minimum price."}), 402

    # S5: bind the payment to the payer. Without this, a valid reference
    # from someone else's transaction still upgraded the caller.
    payer_email = ((tx.get("customer") or {}).get("email") or "").strip().lower()
    if payer_email and payer_email != (user["email"] or "").strip().lower():
        print(f"Paystack email mismatch: paid by {payer_email}, claimed by {user['email']}")
        return jsonify({"error": "That payment was made with a different email address."}), 403

    days = plans.plan_days(plan)
    conn = get_db()
    try:
        inserted = conn.execute(
            """INSERT INTO payments (reference, user_id, email, plan, amount_kobo,
                                     days_granted, verified_at, raw)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (reference) DO NOTHING""",
            (reference, user["id"], payer_email or user["email"], plan, paid_kobo,
             days, utcnow(), json.dumps(tx)[:4000]),
        )
        if inserted.rowcount != 1:
            owner = conn.execute(
                "SELECT user_id FROM payments WHERE reference = ?", (reference,)
            ).fetchone()
            conn.rollback()
            if owner and owner["user_id"] == user["id"]:
                return jsonify({"error": "This payment has already been applied.",
                                "already_applied": True}), 409
            return jsonify({"error": "That payment reference is not valid for this account."}), 403

        # The unique reference is reserved in this transaction before the
        # entitlement changes. Concurrent verification can no longer grant
        # the same payment twice.
        expires = plans.grant_plan(conn, user["id"], plan, days)
        conn.commit()
    except Exception as e:
        conn.rollback()
        print("Paystack grant failed:", repr(e))
        return jsonify({"error": "Payment verified but the upgrade failed. Contact support."}), 500
    finally:
        conn.close()

    return jsonify({"ok": True, "plan": plan, "expires_at": expires, "days": days})


# ─────────────────────────────────────────
#  FILES
# ─────────────────────────────────────────
@app.route("/api/file/use", methods=["POST"])
@require_auth
def use_file_share():
    user = request.kairos_user
    if plans.is_pro_user(user):
        return jsonify({"ok": True, "unlimited": True})

    file_limit = effective_limit("free_file_uploads", FREE_FILE_UPLOAD_LIMIT)
    allowed, used = plans.can_upload_file(user, file_limit)
    if not allowed:
        msg = cfg.get("ui.file_limit_reached",
                      "File sharing is limited on the Free plan.")
        return jsonify({"error": msg.replace("{{LIMIT}}", str(file_limit)),
                        "pro_required": True}), 403

    conn = get_db()
    try:
        conn.execute(
            "UPDATE users SET file_uploads_used = file_uploads_used + 1 WHERE id = ?",
            (user["id"],),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "remaining": max(0, file_limit - used - 1)})


@app.route("/upload_pdf", methods=["POST"])
@require_auth
def upload_pdf():
    if is_rate_limited(client_ip()):
        return jsonify({"error": "Too many requests."}), 429

    user = request.kairos_user
    file_limit = effective_limit("free_file_uploads", FREE_FILE_UPLOAD_LIMIT)
    allowed, _ = plans.can_upload_file(user, file_limit)
    if not allowed:
        msg = cfg.get("ui.file_limit_reached",
                      "File sharing is limited on the Free plan.")
        return jsonify({"error": msg.replace("{{LIMIT}}", str(file_limit)),
                        "pro_required": True}), 403

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not (file.filename or "").lower().endswith(".pdf"):
        return jsonify({"error": "Only PDF files are accepted"}), 400

    file.seek(0, 2)
    size = file.tell()
    file.seek(0)
    if size > 20 * 1024 * 1024:
        return jsonify({"error": "PDF too large. Max 20MB."}), 413

    try:
        import pdfplumber
        pdf_bytes = file.read()
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            page_count = len(pdf.pages)
            text = "\n".join(page.extract_text() or "" for page in pdf.pages)

        if not text.strip():
            return jsonify({"error": "Could not extract text from PDF"}), 400

        truncated = len(text) > MAX_FILE_CONTEXT_CHARS
        if truncated:
            text = text[:MAX_FILE_CONTEXT_CHARS] + "\n\n[Document truncated — too long]"

        if not plans.is_pro_user(user):
            conn = get_db()
            try:
                conn.execute(
                    "UPDATE users SET file_uploads_used = file_uploads_used + 1 WHERE id = ?",
                    (user["id"],),
                )
                conn.commit()
            finally:
                conn.close()

        # F3: 'chars' is returned because the frontend reads it —
        # it previously showed "undefined chars" to every user.
        return jsonify({"text": text, "pages": page_count,
                        "chars": len(text), "truncated": truncated})
    except Exception as e:
        print("PDF error:", repr(e))
        return jsonify({"error": "Failed to process PDF"}), 500


# ─────────────────────────────────────────
#  MEMORY
# ─────────────────────────────────────────
def _require_pro(user, feature_key, label):
    if plans.is_pro_user(user):
        return None
    return jsonify({
        "error": cfg.get(f"ui.{feature_key}", f"{label} is available for Pro users only."),
        "pro_required": True,
    }), 403


@app.route("/memory", methods=["GET"])
@require_auth
def get_memories():
    user = request.kairos_user
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT id, key, value, created_at FROM memories
               WHERE user_id = ? ORDER BY id DESC""", (user["id"],)
        ).fetchall()
    finally:
        conn.close()
    return jsonify({"memories": [dict(r) for r in rows]})


@app.route("/memory", methods=["POST"])
@require_auth
def save_memory():
    user = request.kairos_user
    data = request.get_json(silent=True) or {}
    key   = sanitize_input(str(data.get("key", "")).strip(), 120)
    value = sanitize_input(str(data.get("value", "")).strip(), 500)
    if not key or not value:
        return jsonify({"error": "key and value are required"}), 400

    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT id FROM memories WHERE user_id = ? AND key = ?",
            (user["id"], key),
        ).fetchone()
        if not existing and not plans.is_pro_user(user):
            total = conn.execute(
                "SELECT COUNT(*) AS n FROM memories WHERE user_id = ?",
                (user["id"],),
            ).fetchone()["n"]
            memory_limit = effective_limit("free_memories", FREE_MEMORY_LIMIT)
            if total >= memory_limit:
                return jsonify({
                    "error": f"Free accounts can save up to {memory_limit} memories.",
                    "limit_reached": True,
                    "pro_required": True,
                    "used": total,
                    "limit": memory_limit,
                }), 402
        conn.execute(
            """INSERT INTO memories (user_id, key, value, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT (user_id, key) DO UPDATE
                   SET value = EXCLUDED.value, created_at = EXCLUDED.created_at""",
            (user["id"], key, value, utcnow()),
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, key, value, created_at FROM memories WHERE user_id = ? AND key = ?",
            (user["id"], key),
        ).fetchone()
    finally:
        conn.close()
    return jsonify({"memory": dict(row)}), 201


@app.route("/memory/<path:key>", methods=["DELETE"])
@app.route("/memory", methods=["DELETE"])
@require_auth
def delete_memory(key=None):
    user = request.kairos_user
    conn = get_db()
    try:
        if key:
            conn.execute("DELETE FROM memories WHERE user_id = ? AND key = ?",
                         (user["id"], key))
        else:
            conn.execute("DELETE FROM memories WHERE user_id = ?", (user["id"],))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"deleted": True})


# ─────────────────────────────────────────
#  CONVERSATIONS
# ─────────────────────────────────────────
@app.route("/api/conversations", methods=["GET"])
@require_auth
def list_conversations():
    user = request.kairos_user
    conn = get_db()
    try:
        rows = conn.execute("""
            SELECT c.id, c.title, c.created_at, c.updated_at,
                   (SELECT content FROM conversation_history
                     WHERE conversation_id = c.id ORDER BY id ASC LIMIT 1) AS preview,
                   (SELECT COUNT(*) FROM conversation_history
                     WHERE conversation_id = c.id) AS message_count
            FROM conversations c
            WHERE c.user_id = ?
            ORDER BY c.updated_at DESC
            LIMIT 100
        """, (user["id"],)).fetchall()
    finally:
        conn.close()
    return jsonify({"conversations": [{
        "id": c["id"], "title": c["title"],
        "preview": (c["preview"] or "")[:80],
        "message_count": c["message_count"],
        "created_at": c["created_at"], "updated_at": c["updated_at"],
    } for c in rows]})


@app.route("/api/conversations", methods=["POST"])
@require_auth
def create_conversation():
    user = request.kairos_user
    now = utcnow()
    conn = get_db()
    try:
        row = conn.execute(
            """INSERT INTO conversations (user_id, title, created_at, updated_at)
               VALUES (?, ?, ?, ?) RETURNING id""",
            (user["id"], None, now, now),
        ).fetchone()
        conn.commit()
    finally:
        conn.close()
    return jsonify({"id": row["id"], "created_at": now}), 201


@app.route("/api/conversations/<int:conv_id>/messages", methods=["GET"])
@require_auth
def get_conversation_messages(conv_id):
    user = request.kairos_user
    conn = get_db()
    try:
        owner = conn.execute(
            "SELECT id FROM conversations WHERE id = ? AND user_id = ?",
            (conv_id, user["id"]),
        ).fetchone()
        if not owner:
            return jsonify({"error": "Conversation not found"}), 404
        rows = conn.execute(
            """SELECT role, content, created_at FROM conversation_history
               WHERE conversation_id = ? ORDER BY id ASC""", (conv_id,)
        ).fetchall()
    finally:
        conn.close()
    return jsonify({"messages": [dict(r) for r in rows]})


@app.route("/api/conversations/<int:conv_id>/messages", methods=["POST"])
@require_auth
def add_conversation_message(conv_id):
    user = request.kairos_user
    data = request.get_json(silent=True) or {}
    role    = str(data.get("role", "")).strip()
    content = sanitize_input(str(data.get("content", "")).strip(), 4000)
    if role not in ("user", "kairos") or not content:
        return jsonify({"error": "role ('user' or 'kairos') and content are required"}), 400

    conn = get_db()
    try:
        owner = conn.execute(
            "SELECT id, title FROM conversations WHERE id = ? AND user_id = ?",
            (conv_id, user["id"]),
        ).fetchone()
        if not owner:
            return jsonify({"error": "Conversation not found"}), 404

        now = utcnow()
        conn.execute(
            """INSERT INTO conversation_history
                   (user_id, role, content, created_at, conversation_id)
               VALUES (?, ?, ?, ?, ?)""",
            (user["id"], role, content, now, conv_id),
        )
        if not owner["title"] and role == "user":
            conn.execute(
                "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
                (content[:60], now, conv_id),
            )
        else:
            conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?",
                         (now, conv_id))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True}), 201


@app.route("/api/conversations/<int:conv_id>", methods=["DELETE"])
@require_auth
def delete_conversation(conv_id):
    user = request.kairos_user
    conn = get_db()
    try:
        owner = conn.execute(
            "SELECT id FROM conversations WHERE id = ? AND user_id = ?",
            (conv_id, user["id"]),
        ).fetchone()
        if not owner:
            return jsonify({"error": "Conversation not found"}), 404
        conn.execute("DELETE FROM conversation_history WHERE conversation_id = ?", (conv_id,))
        conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"deleted": True})


# ─────────────────────────────────────────
#  REMINDERS
# ─────────────────────────────────────────
@app.route("/api/reminders", methods=["GET"])
@require_auth
def list_reminders():
    user = request.kairos_user
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT id, text, remind_at, fired, created_at FROM reminders
               WHERE user_id = ? ORDER BY remind_at ASC""", (user["id"],)
        ).fetchall()
    finally:
        conn.close()
    return jsonify({"reminders": [{
        "id": r["id"], "text": r["text"], "remind_at": r["remind_at"],
        "fired": bool(r["fired"]), "created_at": r["created_at"],
    } for r in rows]})


@app.route("/api/reminders", methods=["POST"])
@require_auth
def create_reminder():
    user = request.kairos_user
    data = request.get_json(silent=True) or {}
    text      = sanitize_input(str(data.get("text", "")).strip(), 300)
    remind_at = str(data.get("remind_at", "")).strip()
    if not text or not remind_at:
        return jsonify({"error": "text and remind_at are required"}), 400

    conn = get_db()
    try:
        if not plans.is_pro_user(user):
            active = conn.execute(
                "SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND fired = 0",
                (user["id"],),
            ).fetchone()["n"]
            reminder_limit = effective_limit("free_active_reminders", FREE_REMINDER_LIMIT)
            if active >= reminder_limit:
                return jsonify({
                    "error": f"Free accounts can keep {reminder_limit} active reminders.",
                    "limit_reached": True,
                    "pro_required": True,
                    "used": active,
                    "limit": reminder_limit,
                }), 402
        row = conn.execute(
            """INSERT INTO reminders (user_id, text, remind_at, fired, created_at)
               VALUES (?, ?, ?, 0, ?) RETURNING id""",
            (user["id"], text, remind_at, utcnow()),
        ).fetchone()
        conn.commit()
    finally:
        conn.close()
    return jsonify({"id": row["id"]}), 201


@app.route("/api/reminders/<int:rem_id>", methods=["PATCH"])
@require_auth
def update_reminder(rem_id):
    user = request.kairos_user
    data = request.get_json(silent=True) or {}
    conn = get_db()
    try:
        owner = conn.execute(
            "SELECT id FROM reminders WHERE id = ? AND user_id = ?", (rem_id, user["id"])
        ).fetchone()
        if not owner:
            return jsonify({"error": "Reminder not found"}), 404
        text = sanitize_input(str(data.get("text", "")).strip(), 300)
        remind_at = str(data.get("remind_at", "")).strip()
        if text and remind_at:
            conn.execute(
                "UPDATE reminders SET text = ?, remind_at = ?, fired = ? WHERE id = ?",
                (text, remind_at, 1 if data.get("fired") else 0, rem_id),
            )
        else:
            conn.execute("UPDATE reminders SET fired = ? WHERE id = ?",
                         (1 if data.get("fired") else 0, rem_id))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.route("/api/reminders/<int:rem_id>", methods=["DELETE"])
@require_auth
def delete_reminder(rem_id):
    user = request.kairos_user
    conn = get_db()
    try:
        conn.execute("DELETE FROM reminders WHERE id = ? AND user_id = ?",
                     (rem_id, user["id"]))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"deleted": True})


# ═════════════════════════════════════════
#  ADMIN
#
#  Every route below is gated by @require_admin, which verifies a
#  SIGNED token and re-reads the role from the database. The old check
#  was `token.startswith("admin-token-")` — so the literal string
#  "Bearer admin-token-" gave any anonymous caller the ability to list
#  and delete every user.
# ═════════════════════════════════════════
@app.route("/api/admin/users", methods=["GET"])
@require_admin
def admin_get_users():
    # N3: paginated. The old endpoint returned every row and the panel
    # rendered them all into the DOM at once.
    try:
        limit  = min(int(request.args.get("limit", 50)), 200)
        offset = max(int(request.args.get("offset", 0)), 0)
    except ValueError:
        limit, offset = 50, 0

    search = (request.args.get("q") or "").strip().lower()

    conn = get_db()
    try:
        if search:
            total = conn.execute(
                "SELECT COUNT(*) AS n FROM users WHERE LOWER(email) LIKE ?",
                (f"%{search}%",),
            ).fetchone()["n"]
            rows = conn.execute(
                """SELECT id, email, role, plan_tier, is_pro_override, created_at,
                          plan_expires_at, last_login_at, last_seen_at, onboarded,
                          email_verified, suspended, msg_count, msg_count_date
                   FROM users WHERE LOWER(email) LIKE ?
                   ORDER BY created_at DESC LIMIT ? OFFSET ?""",
                (f"%{search}%", limit, offset),
            ).fetchall()
        else:
            total = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
            rows = conn.execute(
                """SELECT id, email, role, plan_tier, is_pro_override, created_at,
                          plan_expires_at, last_login_at, last_seen_at, onboarded,
                          email_verified, suspended, msg_count, msg_count_date
                   FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?""",
                (limit, offset),
            ).fetchall()
    finally:
        conn.close()

    return jsonify({
        "users": [{
            "id": r["id"], "email": r["email"], "role": r["role"],
            "plan_tier": r["plan_tier"],
            "is_pro_override": bool(r["is_pro_override"]),
            "created_at": r["created_at"],
            "plan_expires_at": r["plan_expires_at"],
            "last_login_at": r["last_login_at"],
            "last_seen_at": r["last_seen_at"],
            "onboarded": bool(r["onboarded"]),
            "email_verified": bool(r["email_verified"]),
            "suspended": bool(r["suspended"]),
        } for r in rows],
        "total": total, "limit": limit, "offset": offset,
    })


@app.route("/api/admin/users/<user_id>", methods=["GET"])
@require_admin
def admin_get_user(user_id):
    """N4: there was no way to see one user in detail — only the row in
    the list. Support questions ("why can't they use camera?", "did their
    payment go through?") needed database access to answer."""
    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            return jsonify({"error": "User not found"}), 404

        payments = conn.execute(
            """SELECT reference, plan, amount_kobo, days_granted, verified_at
               FROM payments WHERE user_id = ? ORDER BY verified_at DESC LIMIT 20""",
            (user_id,),
        ).fetchall()

        counts = {}
        for label, sql in (
            ("conversations", "SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?"),
            ("messages",      "SELECT COUNT(*) AS n FROM conversation_history WHERE user_id = ?"),
            ("memories",      "SELECT COUNT(*) AS n FROM memories WHERE user_id = ?"),
            ("reminders",     "SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?"),
            ("passkeys",      "SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?"),
        ):
            counts[label] = conn.execute(sql, (user_id,)).fetchone()["n"]

        notifications = conn.execute(
            """SELECT template_key, status, scheduled_at, sent_at, error
               FROM notifications WHERE user_id = ?
               ORDER BY scheduled_at DESC LIMIT 20""",
            (user_id,),
        ).fetchall()
        feature_usage = plans.daily_feature_usage(conn, user_id)
        feature_usage["memories"] = counts["memories"]
        feature_usage["active_reminders"] = conn.execute(
            "SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND fired = 0",
            (user_id,),
        ).fetchone()["n"]
    finally:
        conn.close()

    status = plans.plan_status(user)
    marketing_ok, marketing_reason = can_receive_marketing(user)

    return jsonify({
        "user": {
            "id": user["id"], "email": user["email"], "role": user["role"],
            "name": user["name"] or "", "preferred_name": user["preferred_name"] or "",
            "plan_tier": user["plan_tier"],
            "is_pro_override": bool(user["is_pro_override"]),
            "is_pro": status["is_pro"],
            "plan_reason": status["reason"],
            "plan_expires_at": status["expires_at"],
            "plan_days_left": status["days_left"],
            "in_grace": status["in_grace"],
            "created_at": user["created_at"],
            "last_login_at": user["last_login_at"],
            "last_seen_at": user["last_seen_at"],
            "onboarded": bool(user["onboarded"]),
            "email_verified": bool(user["email_verified"]),
            "email_opt_in": bool(user["email_opt_in"]),
            "suspended": bool(user["suspended"]),
            "suspended_reason": user["suspended_reason"],
            "messages_used_today": plans.messages_used_today(user),
            "file_uploads_used": user["file_uploads_used"] or 0,
            "can_receive_marketing": marketing_ok,
            "marketing_blocked_reason": marketing_reason,
        },
        "counts": counts,
        "feature_usage_today": feature_usage,
        "feature_limits": {
            "vision": None if status["is_pro"] else effective_limit("free_vision_daily", FREE_VISION_DAILY_LIMIT),
            "screen": None if status["is_pro"] else effective_limit("free_screen_daily", FREE_SCREEN_DAILY_LIMIT),
            "memories": None if status["is_pro"] else effective_limit("free_memories", FREE_MEMORY_LIMIT),
            "active_reminders": None if status["is_pro"] else effective_limit("free_active_reminders", FREE_REMINDER_LIMIT),
        },
        "payments": [{
            "reference": p["reference"], "plan": p["plan"],
            "amount_ngn": (p["amount_kobo"] or 0) / 100,
            "days": p["days_granted"], "at": p["verified_at"],
        } for p in payments],
        "notifications": [dict(n) for n in notifications],
    })


@app.route("/api/admin/users/<user_id>/override", methods=["PATCH"])
@require_admin
def admin_toggle_override(user_id):
    val = 1 if (request.get_json(silent=True) or {}).get("is_pro_override") else 0
    conn = get_db()
    try:
        conn.execute("UPDATE users SET is_pro_override = ? WHERE id = ?", (val, user_id))
        conn.commit()
    finally:
        conn.close()
    audit(request.kairos_user["email"], "toggle_override", "user", user_id,
          f"is_pro_override={val}")
    return jsonify({"ok": True})


@app.route("/api/admin/users/<user_id>/plan", methods=["PATCH"])
@require_admin
def admin_set_plan(user_id):
    """N6: grant or revoke a paid plan directly — previously impossible
    without editing the database by hand."""
    data = request.get_json(silent=True) or {}
    plan = data.get("plan", "free")
    days = data.get("days")

    if plan not in ("free", "pro", "organisation"):
        return jsonify({"error": "Invalid plan"}), 400

    conn = get_db()
    try:
        if plan == "free":
            conn.execute(
                "UPDATE users SET plan_tier = 'free', plan_expires_at = NULL WHERE id = ?",
                (user_id,),
            )
            expires = None
        else:
            expires = plans.grant_plan(conn, user_id, plan,
                                       int(days) if days else None,
                                       extend_from_existing=False)
        conn.commit()
    finally:
        conn.close()
    audit(request.kairos_user["email"], "set_plan", "user", user_id,
          f"plan={plan} expires={expires}")
    return jsonify({"ok": True, "plan": plan, "expires_at": expires})


@app.route("/api/admin/users/<user_id>/suspend", methods=["PATCH"])
@require_admin
def admin_suspend_user(user_id):
    data = request.get_json(silent=True) or {}
    suspended = 1 if data.get("suspended") else 0
    reason = sanitize_input(str(data.get("reason", "")), 200)
    conn = get_db()
    try:
        conn.execute(
            "UPDATE users SET suspended = ?, suspended_reason = ? WHERE id = ?",
            (suspended, reason or None, user_id),
        )
        conn.commit()
    finally:
        conn.close()
    audit(request.kairos_user["email"], "suspend", "user", user_id,
          f"suspended={suspended} reason={reason}")
    return jsonify({"ok": True})


@app.route("/api/admin/users/<user_id>/send-reset", methods=["POST"])
@require_admin
def admin_send_reset(user_id):
    """N6: support could not help a locked-out user without database
    access. This mails them a reset link — it never reveals or sets a
    password, so an admin still cannot read or choose someone's
    credentials."""
    conn = get_db()
    try:
        user = conn.execute(
            "SELECT id, email, password_hash FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not user:
            return jsonify({"error": "User not found"}), 404
        if not user["password_hash"]:
            return jsonify({
                "error": "This account signs in with Google or a passkey — "
                         "there is no password to reset."
            }), 400

        token = secrets.token_urlsafe(32)
        expires = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
        conn.execute(
            "UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?",
            (token, expires, user_id),
        )
        conn.commit()
    finally:
        conn.close()

    send_reset_email(user["email"], f"{PUBLIC_BASE_URL}/auth.htm?token={token}")
    audit(request.kairos_user["email"], "send_reset", "user", user_id, user["email"])
    return jsonify({"ok": True, "message": f"Reset link sent to {user['email']}."})


@app.route("/api/admin/users/<user_id>", methods=["DELETE"])
@require_admin
def admin_delete_user(user_id):
    if user_id == request.kairos_user["id"]:
        return jsonify({"error": "You cannot delete your own admin account."}), 400

    conn = get_db()
    try:
        row = conn.execute("SELECT email FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            return jsonify({"error": "User not found"}), 404
        # D5: ON DELETE CASCADE now removes memories, conversations,
        # history, reminders, passkeys and payments with the user.
        # Previously those rows were orphaned — a data-protection problem,
        # since "delete user" did not actually delete their data.
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()
    audit(request.kairos_user["email"], "delete_user", "user", user_id, row["email"])
    return jsonify({"deleted": True})


@app.route("/api/admin/stats", methods=["GET"])
@require_admin
def admin_stats():
    """N1: the Analytics tab said "CONNECT YOUR DATABASE TO SEE
    ANALYTICS" — but the database was already connected. The data was
    there the whole time with no endpoint exposing it."""
    conn = get_db()
    try:
        def scalar(sql, params=()):
            row = conn.execute(sql, params).fetchone()
            return (row or {}).get("n", 0)

        now = datetime.now(timezone.utc)
        today    = now.strftime("%Y-%m-%d")
        week_ago = (now - timedelta(days=7)).isoformat()
        month_ago = (now - timedelta(days=30)).isoformat()
        soon     = (now + timedelta(days=7)).isoformat()

        stats = {
            "users_total":     scalar("SELECT COUNT(*) AS n FROM users"),
            "users_new_7d":    scalar("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", (week_ago,)),
            "users_new_30d":   scalar("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", (month_ago,)),
            "paying":          scalar("""SELECT COUNT(*) AS n FROM users
                                          WHERE plan_tier IN ('pro','organisation')
                                            AND is_pro_override = 0"""),
            "overrides":       scalar("SELECT COUNT(*) AS n FROM users WHERE is_pro_override = 1"),
            "free":            scalar("SELECT COUNT(*) AS n FROM users WHERE plan_tier = 'free'"),
            "suspended":       scalar("SELECT COUNT(*) AS n FROM users WHERE suspended = 1"),
            "unverified":      scalar("SELECT COUNT(*) AS n FROM users WHERE email_verified = 0"),
            "not_onboarded":   scalar("SELECT COUNT(*) AS n FROM users WHERE onboarded = 0"),
            "active_7d":       scalar("SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?", (week_ago,)),
            "dormant_7d":      scalar("""SELECT COUNT(*) AS n FROM users
                                          WHERE last_seen_at < ? AND onboarded = 1""", (week_ago,)),
            "expiring_7d":     scalar("""SELECT COUNT(*) AS n FROM users
                                          WHERE plan_tier IN ('pro','organisation')
                                            AND is_pro_override = 0
                                            AND plan_expires_at IS NOT NULL
                                            AND plan_expires_at BETWEEN ? AND ?""", (now.isoformat(), soon)),
            "messages_today":  scalar("SELECT COALESCE(SUM(msg_count),0) AS n FROM users WHERE msg_count_date = ?", (today,)),
            "conversations":   scalar("SELECT COUNT(*) AS n FROM conversations"),
            "messages_stored": scalar("SELECT COUNT(*) AS n FROM conversation_history"),
            "memories":        scalar("SELECT COUNT(*) AS n FROM memories"),
            "reminders_open":  scalar("SELECT COUNT(*) AS n FROM reminders WHERE fired = 0"),
            "passkeys":        scalar("SELECT COUNT(*) AS n FROM webauthn_credentials"),
        }

        revenue = conn.execute(
            """SELECT COALESCE(SUM(amount_kobo),0) AS kobo, COUNT(*) AS n
               FROM payments WHERE verified_at >= ?""", (month_ago,)
        ).fetchone()
        stats["revenue_30d_ngn"] = (revenue["kobo"] or 0) / 100
        stats["payments_30d"] = revenue["n"] or 0

        signups = conn.execute(
            """SELECT SUBSTRING(created_at, 1, 10) AS day, COUNT(*) AS n
               FROM users WHERE created_at >= ?
               GROUP BY day ORDER BY day ASC""", (month_ago,)
        ).fetchall()
        stats["signups_by_day"] = [{"day": s["day"], "count": s["n"]} for s in signups]
    finally:
        conn.close()

    stats["providers"] = providers.health()
    return jsonify(stats)


@app.route("/api/admin/notifications", methods=["POST"])
@require_admin
def admin_send_notification():
    data = request.get_json(silent=True) or {}
    title = sanitize_input(str(data.get("title", "")).strip(), 120)
    body = sanitize_input(str(data.get("body", "")).strip(), 2000)
    segment = str(data.get("segment", "all")).strip().lower()
    channel = str(data.get("channel", "in_app")).strip().lower()
    if not title or not body:
        return jsonify({"error": "Title and message are required"}), 400
    if segment not in ("all", "free", "pro", "inactive", "free_near_limit", "expiring"):
        return jsonify({"error": "Invalid audience segment"}), 400
    if channel not in ("in_app", "email", "both"):
        return jsonify({"error": "Channel must be in_app, email, or both"}), 400
    now_dt = datetime.now(timezone.utc)
    params = []
    where = ""
    if segment == "free":
        where = " AND plan_tier = 'free'"
    elif segment == "pro":
        where = " AND plan_tier IN ('pro','organisation')"
    elif segment == "inactive":
        where = " AND COALESCE(last_seen_at, created_at) < ?"
        params.append((now_dt - timedelta(days=7)).isoformat())
    elif segment == "free_near_limit":
        where = " AND plan_tier = 'free' AND msg_count_date = ? AND msg_count >= ?"
        params.extend([now_dt.strftime("%Y-%m-%d"), max(1, int(effective_limit("free_daily_messages", FREE_DAILY_MESSAGE_LIMIT) * 0.8))])
    elif segment == "expiring":
        where = " AND plan_tier IN ('pro','organisation') AND plan_expires_at BETWEEN ? AND ?"
        params.extend([now_dt.isoformat(), (now_dt + timedelta(days=7)).isoformat()])
    conn = get_db()
    try:
        users = conn.execute("SELECT * FROM users WHERE suspended = 0" + where, tuple(params)).fetchall()
        now = utcnow()
        for row in users:
            if channel in ("in_app", "both"):
                conn.execute(
                    """INSERT INTO notifications
                       (user_id, template_key, channel, subject, body, status, scheduled_at, created_at)
                       VALUES (?, ?, 'in_app', ?, ?, 'delivered', ?, ?)""",
                    (row["id"], f"admin_manual_{secrets.token_hex(6)}", title, body, now, now),
                )
        conn.commit()
    finally:
        conn.close()
    emails_sent = 0
    if channel in ("email", "both"):
        for user in users:
            allowed, _ = can_receive_marketing(user)
            if allowed and send_email(user["email"], title,
                                      _email_shell(f"<p style='font-size:15px;line-height:1.7;color:#a3a3a3;'>{html.escape(body)}</p>{unsubscribe_footer(user)}")):
                emails_sent += 1
    audit(request.kairos_user["email"], "send_notification", "users", segment,
          f"recipients={len(users)} emails={emails_sent} channel={channel} title={title}")
    return jsonify({"ok": True, "recipients": len(users), "emails_sent": emails_sent})


@app.route("/api/notifications", methods=["GET"])
@require_auth
def user_notifications():
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT id, subject, body, status, created_at, read_at
               FROM notifications WHERE user_id = ? AND read_at IS NULL
               ORDER BY created_at DESC LIMIT 50""",
            (request.kairos_user["id"],),
        ).fetchall()
    finally:
        conn.close()
    return jsonify({"notifications": [dict(row) for row in rows]})


@app.route("/api/notifications/<int:notification_id>/read", methods=["PATCH"])
@require_auth
def mark_notification_read(notification_id):
    conn = get_db()
    try:
        conn.execute(
            "UPDATE notifications SET read_at = ?, status = 'read' WHERE id = ? AND user_id = ?",
            (utcnow(), notification_id, request.kairos_user["id"]),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.route("/api/admin/audit", methods=["GET"])
@require_admin
def admin_audit_log():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT 200"
        ).fetchall()
    finally:
        conn.close()
    return jsonify({"entries": [dict(r) for r in rows]})


# ── CONFIG EDITOR (N2 — backend was already built, no UI existed) ──
@app.route("/api/admin/config", methods=["GET"])
@require_admin
def admin_get_config():
    return jsonify({"config": cfg.admin_view(),
                    "sections": cfg.editable_sections()})


@app.route("/api/admin/limits", methods=["GET", "PUT"])
@require_admin
def admin_limits():
    keys = ("free_daily_messages", "free_per_minute", "free_file_uploads",
            "free_vision_daily", "free_screen_daily", "free_memories",
            "free_active_reminders", "new_user_trial_days")
    if request.method == "GET":
        return jsonify({"limits": {key: effective_limit(key, 0) for key in keys}})
    data = request.get_json(silent=True) or {}
    value = data.get("limits", data.get("value", {}))
    if not isinstance(value, dict):
        return jsonify({"error": "limits must be an object"}), 400
    current = cfg.section("limits", {}) or {}
    for key in keys:
        if key in value:
            try:
                number = int(value[key])
            except (TypeError, ValueError):
                return jsonify({"error": f"{key} must be a whole number"}), 400
            if number < 0 or number > 100000:
                return jsonify({"error": f"{key} is outside the allowed range"}), 400
            current[key] = number
    cfg.update_section("limits", current, request.kairos_user["email"])
    conn = get_db()
    try:
        row = conn.execute("SELECT value FROM config WHERE section = 'limits'").fetchone()
        persisted = json.loads(row["value"]) if row and isinstance(row["value"], str) else (row["value"] if row else {})
    finally:
        conn.close()
    for key in keys:
        if key in value and int(persisted.get(key, -1)) != int(current[key]):
            return jsonify({"error": f"Database did not persist {key}. Please retry."}), 500
    audit(request.kairos_user["email"], "update_limits", "config", "limits",
          json.dumps({key: current.get(key) for key in keys}))
    return jsonify({"ok": True, "limits": {key: int(persisted.get(key, 0) or 0) for key in keys},
                    "config_version": cfg._version})


@app.route("/api/admin/config/<section>", methods=["PUT"])
@require_admin
def admin_update_config(section):
    data = request.get_json(silent=True) or {}
    value = data.get("value")
    if value is None:
        return jsonify({"error": "Missing 'value'"}), 400
    try:
        cfg.update_section(section, value, request.kairos_user["email"])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        print("config update failed:", repr(e))
        return jsonify({"error": "Could not save config"}), 500
    audit(request.kairos_user["email"], "update_config", "config", section)
    return jsonify({"ok": True, "section": section, "value": cfg.section(section)})


@app.route("/api/admin/config/<section>/reset", methods=["POST"])
@require_admin
def admin_reset_config(section):
    try:
        value = cfg.reset_section(section, request.kairos_user["email"])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    audit(request.kairos_user["email"], "reset_config", "config", section)
    return jsonify({"ok": True, "section": section, "value": value})


# Legacy persona endpoints, kept so the existing admin panel keeps working.
@app.route("/api/admin/persona", methods=["GET"])
@require_admin
def admin_get_persona():
    return jsonify(cfg.section("persona"))


@app.route("/api/admin/persona", methods=["POST"])
@require_admin
def admin_update_persona():
    data = request.get_json(silent=True) or {}
    allowed = {"wake_word", "system_prompt", "vision_system_prompt",
               "screen_system_prompt", "code_system_prompt",
               "security_system_prompt", "dev_credit_response",
               "jailbreak_refusal_ask", "jailbreak_refusal_vision",
               "jailbreak_refusal_screen"}
    updates = {k: v for k, v in data.items()
               if k in allowed and isinstance(v, str) and v.strip()}
    if not updates:
        return jsonify({"error": "No valid fields to update"}), 400
    merged = cfg.patch_section("persona", updates, request.kairos_user["email"])
    audit(request.kairos_user["email"], "update_persona", "config", "persona",
          ",".join(updates.keys()))
    return jsonify({"ok": True, "persona": merged})


@app.route("/api/admin/router/test", methods=["POST"])
@require_admin
def admin_test_router():
    """Tune routing without guesswork — shows per-intent keyword scores
    and the model chain a given message would take."""
    data = request.get_json(silent=True) or {}
    text = str(data.get("text", ""))
    is_pro = bool(data.get("is_pro", True))
    return jsonify(router.explain(text, cfg.section("routing"), is_pro))


# ─────────────────────────────────────────
#  HEALTH
# ─────────────────────────────────────────
@app.route("/health", methods=["GET"])
def health():
    """I4: this used to return hardcoded "enabled" strings for every
    subsystem, so it stayed green while the database was unreachable.
    Now it actually checks."""
    db_ok, db_error = True, None
    try:
        conn = get_db()
        conn.execute("SELECT 1")
        conn.close()
    except Exception as e:
        db_ok, db_error = False, str(e)[:200]

    provider_health = providers.health()
    any_provider = any(p["configured"] for p in provider_health["providers"].values())

    healthy = db_ok and any_provider
    return jsonify({
        "status":    "ok" if healthy else "degraded",
        "version":   "v18",
        "env":       APP_ENV,
        "database":  {"ok": db_ok, "error": db_error},
        "ai":        provider_health,
        "config_version": cfg._version,
    }), (200 if healthy else 503)


# ─────────────────────────────────────────
#  ENTRYPOINT
# ─────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    print("╔══════════════════════════════════════════════╗")
    print("║   K.A.I.R.O.S BACKEND  v18                   ║")
    print(f"║   http://127.0.0.1:{port}{' ' * (26 - len(str(port)))}║")
    print("║   Signed tokens · Multi-provider · Streaming ║")
    print("╚══════════════════════════════════════════════╝")
    app.run(debug=DEBUG_ENABLED, use_reloader=DEBUG_ENABLED, port=port, threaded=True)
