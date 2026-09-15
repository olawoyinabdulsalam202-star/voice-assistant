# ════════════════════════════════════════════════════════════
#  preflight.py — boot-time configuration checks  (I5)
#
#  WHY
#  ---
#  Misconfiguration used to surface as a runtime 500 in front of a
#  user, or worse, as silence: WEBAUTHN_ORIGIN not matching the real
#  host meant every passkey login failed with "verification failed"
#  and nothing in the logs said why.
#
#  This runs once at startup and prints a report:
#    FATAL  — refuses to boot (or, in dev, warns loudly)
#    WARN   — boots, but something will not work
#    OK     — confirmed good
#
#  The rule of thumb: anything that would produce a confusing runtime
#  failure gets checked here, where the message can name the fix.
# ════════════════════════════════════════════════════════════

import os
from urllib.parse import urlparse

PLACEHOLDER_MARKERS = ("dev-only-placeholder", "replace-before-deploy",
                       "changeme", "your-key-here", "xxx")


class Preflight:
    def __init__(self, env):
        self.env = env
        self.is_prod = env == "production"
        self.fatal = []
        self.warn = []
        self.ok = []

    # ── helpers ──
    def _get(self, key, default=""):
        return os.getenv(key, default).strip()

    def _is_placeholder(self, value):
        low = (value or "").lower()
        return any(m in low for m in PLACEHOLDER_MARKERS)

    def require(self, key, hint=""):
        value = self._get(key)
        if not value:
            self.fatal.append(f"{key} is missing. {hint}".strip())
            return None
        if self._is_placeholder(value):
            msg = f"{key} is still a placeholder. {hint}".strip()
            (self.fatal if self.is_prod else self.warn).append(msg)
            return value
        self.ok.append(key)
        return value

    def optional(self, key, consequence):
        value = self._get(key)
        if not value:
            self.warn.append(f"{key} not set — {consequence}")
            return None
        if self._is_placeholder(value):
            self.warn.append(f"{key} is a placeholder — {consequence}")
            return value
        self.ok.append(key)
        return value

    # ── checks ──
    def run(self):
        self._core()
        self._providers()
        self._database()
        self._auth()
        self._webauthn()
        self._payments()
        self._email()
        self._scaling()
        return self

    def _core(self):
        secret = self.require(
            "SECRET_KEY",
            'Generate: python -c "import secrets; print(secrets.token_urlsafe(48))"',
        )
        if secret and len(secret) < 32 and not self._is_placeholder(secret):
            self.fatal.append(
                f"SECRET_KEY is only {len(secret)} chars — use at least 32."
            )

        base = self._get("PUBLIC_BASE_URL")
        if not base:
            self.warn.append(
                "PUBLIC_BASE_URL not set — password reset and unsubscribe links "
                "will point at localhost."
            )
        elif self.is_prod and base.startswith("http://"):
            self.warn.append(
                f"PUBLIC_BASE_URL is http:// in production ({base}) — "
                "reset links will be insecure and browsers may block features."
            )
        elif base.endswith("/"):
            self.warn.append("PUBLIC_BASE_URL has a trailing slash — remove it.")

    def _providers(self):
        groq = self._get("GROQ_API_KEY")
        openrouter = self._get("OPENROUTER_API_KEY")

        if not groq and not openrouter:
            self.fatal.append(
                "No AI provider configured. Set GROQ_API_KEY (free, fast — "
                "https://console.groq.com/keys) and/or OPENROUTER_API_KEY."
            )
        elif not groq:
            self.warn.append(
                "GROQ_API_KEY not set — the free tier falls back to slower "
                "OpenRouter models. Groq is what keeps replies near 1s."
            )
        elif not openrouter:
            self.warn.append(
                "OPENROUTER_API_KEY not set — Groq has no fallback, and vision "
                "and screen share will be unavailable (no vision model)."
            )

    def _database(self):
        host = self._get("SUPABASE_DB_HOST")
        user = self._get("SUPABASE_DB_USER")
        pw   = os.getenv("SUPABASE_DB_PASSWORD", "")
        url  = self._get("SUPABASE_DB_URL")

        if not (host and user and pw) and not url:
            self.fatal.append(
                "Database not configured. Set SUPABASE_DB_HOST / _USER / "
                "_PASSWORD, or SUPABASE_DB_URL."
            )
            return

        if url and not (host and user and pw):
            # A raw '@' or '#' in the password silently truncates the DSN.
            try:
                parsed = urlparse(url)
                if not parsed.hostname:
                    self.fatal.append(
                        "SUPABASE_DB_URL looks malformed — could not parse a host. "
                        "If the password contains @ # / or ?, URL-encode it, or "
                        "use the discrete SUPABASE_DB_* parameters instead."
                    )
                else:
                    self.ok.append("SUPABASE_DB_URL")
            except Exception:
                self.fatal.append("SUPABASE_DB_URL could not be parsed.")
        else:
            self.ok.append("SUPABASE_DB_* (discrete params)")

        try:
            pool_max = int(self._get("DB_POOL_MAX", "10"))
            workers = int(self._get("WEB_CONCURRENCY", "1"))
            if pool_max * workers > 60:
                self.warn.append(
                    f"DB_POOL_MAX ({pool_max}) x workers ({workers}) = "
                    f"{pool_max * workers} connections. Supabase's pooler will "
                    "start refusing connections — lower DB_POOL_MAX."
                )
        except ValueError:
            self.warn.append("DB_POOL_MAX is not a number.")

    def _auth(self):
        admin_email = self._get("ADMIN_EMAIL")
        admin_pw    = os.getenv("ADMIN_PASSWORD", "")

        if not admin_email or not admin_pw:
            self.warn.append(
                "ADMIN_EMAIL / ADMIN_PASSWORD not set — you cannot reach /admin."
            )
        else:
            weak = {"kairos@123", "admin", "password", "changeme", "admin123"}
            if admin_pw.lower() in weak or len(admin_pw) < 12:
                msg = ("ADMIN_PASSWORD is weak or was committed to git. The admin "
                       "account can delete every user — use a long random passphrase.")
                (self.fatal if self.is_prod else self.warn).append(msg)
            else:
                self.ok.append("ADMIN_PASSWORD")

        if not self._get("GOOGLE_CLIENT_ID"):
            self.warn.append("GOOGLE_CLIENT_ID not set — Google sign-in disabled.")

    def _webauthn(self):
        """The single most confusing failure in this app: a mismatch here
        produces 'Passkey verification failed' with no explanation."""
        rp_id  = self._get("WEBAUTHN_RP_ID")
        origin = self._get("WEBAUTHN_ORIGIN")
        base   = self._get("PUBLIC_BASE_URL")

        if not rp_id or not origin:
            self.warn.append("WebAuthn not configured — passkeys disabled.")
            return

        if "://" in rp_id or ":" in rp_id:
            self.fatal.append(
                f"WEBAUTHN_RP_ID must be a bare domain, not '{rp_id}'. "
                "Use 'example.com' or 'localhost' — no scheme, no port."
            )

        try:
            origin_host = urlparse(origin).hostname or ""
        except Exception:
            origin_host = ""

        if origin_host and rp_id and origin_host != rp_id \
                and not origin_host.endswith("." + rp_id):
            self.fatal.append(
                f"WEBAUTHN_ORIGIN host ('{origin_host}') does not match "
                f"WEBAUTHN_RP_ID ('{rp_id}'). Every passkey login will fail."
            )
        elif origin_host:
            self.ok.append("WebAuthn RP_ID/ORIGIN match")

        if base and origin and base.rstrip("/") != origin.rstrip("/"):
            self.warn.append(
                f"WEBAUTHN_ORIGIN ({origin}) differs from PUBLIC_BASE_URL ({base}). "
                "Passkeys only work on the origin the browser actually sees."
            )

        if self.is_prod and origin.startswith("http://") and "localhost" not in origin:
            self.fatal.append(
                "WEBAUTHN_ORIGIN must be https:// in production — browsers "
                "refuse WebAuthn over plain http."
            )

    def _payments(self):
        pub = self._get("PAYSTACK_PUBLIC_KEY")
        sec = self._get("PAYSTACK_SECRET_KEY")

        if not pub or not sec:
            self.warn.append("Paystack keys not set — Pro upgrades disabled.")
            return

        if self.is_prod and (pub.startswith("pk_test") or sec.startswith("sk_test")):
            self.warn.append(
                "Paystack is in TEST mode in production — no real payments will "
                "be taken. Swap to pk_live_/sk_live_ keys."
            )
        if pub.startswith("pk_") and sec.startswith("pk_"):
            self.fatal.append(
                "PAYSTACK_SECRET_KEY holds a public key. The secret starts sk_."
            )
        try:
            if int(self._get("PRO_PLAN_DAYS", "30")) <= 0:
                self.fatal.append("PRO_PLAN_DAYS must be greater than 0.")
        except ValueError:
            self.fatal.append("PRO_PLAN_DAYS is not a number.")

    def _email(self):
        key    = self._get("BREVO_API_KEY")
        sender = self._get("BREVO_FROM_EMAIL")
        resend_key = self._get("RESEND_API_KEY")
        resend_sender = self._get("RESEND_FROM_EMAIL", sender)

        if not key and not resend_key:
            self.warn.append(
                "BREVO_API_KEY not set — welcome, verification, reset and "
                "expiry emails will all be skipped silently."
            )
            return
        if key and not sender:
            self.fatal.append("BREVO_FROM_EMAIL is required when BREVO_API_KEY is set.")
        elif key and "@" not in sender:
            self.fatal.append(f"BREVO_FROM_EMAIL is not an email address: {sender}")
        elif key:
            self.ok.append("Brevo")
        if resend_key and not resend_sender:
            self.fatal.append("RESEND_FROM_EMAIL is required when RESEND_API_KEY is set.")
        elif resend_key and "@" not in resend_sender:
            self.fatal.append(f"RESEND_FROM_EMAIL is not an email address: {resend_sender}")
        elif resend_key:
            self.ok.append("Resend")

    def _scaling(self):
        """The combination that silently breaks passkeys and multiplies
        rate limits."""
        redis_url = self._get("REDIS_URL")
        try:
            workers = int(self._get("WEB_CONCURRENCY", "1"))
        except ValueError:
            workers = 1

        if not redis_url and workers > 1:
            self.fatal.append(
                f"WEB_CONCURRENCY={workers} without REDIS_URL. Rate limits would "
                f"be {workers}x too permissive and passkey logins would fail at "
                "random, because the WebAuthn challenge is stored on whichever "
                "worker served /login/options. Set REDIS_URL, or use 1 worker."
            )
        elif redis_url:
            self.ok.append("REDIS_URL")

        if self.is_prod and self._get("TRUST_PROXY_HEADERS", "false").lower() != "true":
            self.warn.append(
                "TRUST_PROXY_HEADERS is false in production — if you are behind "
                "Render/Railway/nginx, every request looks like it comes from the "
                "proxy IP, so rate limiting applies to ALL users collectively."
            )
        if not self.is_prod and self._get("TRUST_PROXY_HEADERS", "false").lower() == "true":
            self.warn.append(
                "TRUST_PROXY_HEADERS is true outside production — clients can "
                "spoof X-Forwarded-For and bypass rate limits entirely."
            )

    # ── output ──
    def report(self):
        print("\n" + "─" * 62)
        print(f"  PREFLIGHT  ·  env={self.env}")
        print("─" * 62)

        if self.ok:
            print(f"  ✅ {len(self.ok)} checks passed: {', '.join(self.ok[:6])}"
                  + (" …" if len(self.ok) > 6 else ""))
        for w in self.warn:
            print(f"  ⚠️  {w}")
        for f in self.fatal:
            print(f"  ❌ {f}")

        print("─" * 62 + "\n")

        if self.fatal:
            if self.is_prod:
                raise RuntimeError(
                    f"{len(self.fatal)} fatal configuration problem(s) — refusing "
                    "to start. Fix the ❌ items above."
                )
            print(f"  ⚠️  {len(self.fatal)} fatal issue(s) would BLOCK STARTUP in "
                  "production.\n     Running anyway because APP_ENV is not "
                  "'production'.\n")
        return self


def run(env):
    return Preflight(env).run().report()
