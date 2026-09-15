# ════════════════════════════════════════════════════════════
#  auth.py — signed authentication tokens  (fixes S2 / S3)
#
#  WHAT THIS REPLACES
#  ------------------
#  The previous scheme was:
#       token = "user-token-"  + email
#       token = "admin-token-" + email
#  and the admin check was:
#       return token.startswith("admin-token-")
#
#  That meant:
#    • Knowing someone's email = full account takeover.
#    • The literal string "Bearer admin-token-" passed the admin
#      check, so any anonymous request could list/delete every
#      user and rewrite the system prompt.
#
#  WHAT THIS DOES INSTEAD
#  ----------------------
#  Tokens are signed with SECRET_KEY using itsdangerous (already
#  in requirements.txt). The payload carries the user id, email,
#  role and plan tier, and the signature is verified on every
#  request. Tokens expire (TOKEN_TTL_HOURS) and cannot be edited
#  by the client without invalidating the signature.
#
#  The role in the token is a *hint* for the UI. Anything that
#  actually matters re-reads the role from the database, so a
#  demoted admin loses access immediately rather than at expiry.
# ════════════════════════════════════════════════════════════

import os
import time
from functools import wraps

from flask import request, jsonify
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

# ─────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────
SECRET_KEY      = os.getenv("SECRET_KEY", "").strip()
TOKEN_TTL_HOURS = int(os.getenv("TOKEN_TTL_HOURS", "720"))
APP_ENV         = os.getenv("APP_ENV", "development").strip().lower()

_SALT = "kairos-auth-v1"

_PLACEHOLDER_MARKERS = ("dev-only-placeholder", "REPLACE-BEFORE-DEPLOY", "changeme")


def _looks_like_placeholder(value: str) -> bool:
    return any(marker.lower() in value.lower() for marker in _PLACEHOLDER_MARKERS)


if not SECRET_KEY:
    raise RuntimeError(
        "❌ SECRET_KEY is missing. Add it to your .env file.\n"
        "   Generate one with:\n"
        '   python -c "import secrets; print(secrets.token_urlsafe(48))"'
    )

if len(SECRET_KEY) < 32:
    raise RuntimeError(
        f"❌ SECRET_KEY is too short ({len(SECRET_KEY)} chars). Use at least 32.\n"
        '   python -c "import secrets; print(secrets.token_urlsafe(48))"'
    )

if _looks_like_placeholder(SECRET_KEY):
    if APP_ENV == "production":
        raise RuntimeError(
            "❌ SECRET_KEY is still the development placeholder and APP_ENV=production.\n"
            "   Generate a real secret before deploying."
        )
    print("⚠️  SECRET_KEY is a development placeholder — fine locally, "
          "but generate a real one before deploying.")

_serializer = URLSafeTimedSerializer(SECRET_KEY, salt=_SALT)


# ─────────────────────────────────────────
#  ISSUE
# ─────────────────────────────────────────
def issue_token(user_id, email, role="user", plan_tier="free", auth_version=0):
    """Create a signed token for a logged-in user.

    The payload is readable by the client (it is signed, not encrypted),
    so it must never contain anything secret — no password hashes, no
    reset tokens. Identity only.
    """
    payload = {
        "uid":   str(user_id),
        "email": (email or "").strip().lower(),
        "role":  role or "user",
        "plan":  plan_tier or "free",
        "av":    int(auth_version or 0),
        "iat":   int(time.time()),
    }
    return _serializer.dumps(payload)


# ─────────────────────────────────────────
#  VERIFY
# ─────────────────────────────────────────
def verify_token(token):
    """Return the payload dict, or None if the token is missing,
    tampered with, or expired."""
    if not token:
        return None
    try:
        return _serializer.loads(token, max_age=TOKEN_TTL_HOURS * 3600)
    except SignatureExpired:
        return None
    except BadSignature:
        return None
    except Exception:
        return None


def extract_token():
    """Pull the bearer token out of the Authorization header."""
    header = request.headers.get("Authorization", "")
    if not header:
        return None
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    token = parts[1].strip()
    return token or None


def get_token_payload():
    """Verified payload for the current request, or None."""
    return verify_token(extract_token())


# ─────────────────────────────────────────
#  DECORATORS
#
#  These re-read the user from the database rather than trusting
#  the role baked into the token. A token issued while someone was
#  an admin stops working the moment their row says otherwise.
# ─────────────────────────────────────────
def _load_user_from_payload(payload, get_db):
    if not payload:
        return None
    conn = get_db()
    try:
        user = conn.execute(
            "SELECT * FROM users WHERE id = ?", (payload["uid"],)
        ).fetchone()
        if (
            not user
            or int(user["auth_version"] or 0) != int(payload.get("av", 0))
            or bool(user["suspended"])
        ):
            return None
        return user
    finally:
        conn.close()


def make_auth_decorators(get_db):
    """Build @require_auth and @require_admin bound to this app's get_db.

    Returns (require_auth, require_admin, current_user_getter).
    """

    def current_user():
        payload = get_token_payload()
        return _load_user_from_payload(payload, get_db)

    def require_auth(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = current_user()
            if not user:
                return jsonify({
                    "error": "Please log in to use K.A.I.R.O.S.",
                    "auth_required": True,
                }), 401
            request.kairos_user = user
            return fn(*args, **kwargs)
        return wrapper

    def require_admin(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = current_user()
            # Deliberately identical response for "not logged in" and
            # "logged in but not admin" — no probing for the admin route.
            if not user or user["role"] != "admin":
                return jsonify({"error": "Forbidden"}), 403
            request.kairos_user = user
            return fn(*args, **kwargs)
        return wrapper

    return require_auth, require_admin, current_user
