# ════════════════════════════════════════════════════════════
#  plans.py — plan / quota / expiry logic  (D1, D10, A9, A10)
#
#  WHAT WAS WRONG BEFORE
#  ---------------------
#  1. is_pro_user() checked only plan_tier and is_pro_override, and
#     nothing ever set an expiry — so a single ₦4,500 payment granted
#     Pro permanently. "Renews monthly" was not true in code.
#
#  2. check_and_bump_quota() did a READ then a separate WRITE:
#         current = user["msg_count"] ...
#         UPDATE users SET msg_count = current + 1
#     Ten concurrent requests all read the same count, so the limit was
#     trivially bypassable. Now it is a single atomic UPDATE ... RETURNING.
#
#  3. The quota was charged BEFORE the AI call, so a provider outage
#     burned a free user's whole daily allowance on error messages.
#     Now: reserve -> call -> refund on failure.
# ════════════════════════════════════════════════════════════

import os
from datetime import datetime, timedelta, timezone

PRO_PLAN_DAYS   = int(os.getenv("PRO_PLAN_DAYS", "30"))
ORG_PLAN_DAYS   = int(os.getenv("ORG_PLAN_DAYS", str(PRO_PLAN_DAYS)))
PLAN_GRACE_DAYS = int(os.getenv("PLAN_GRACE_DAYS", "2"))

PAID_TIERS = ("pro", "organisation")


def _now():
    return datetime.now(timezone.utc)


def _today():
    return _now().strftime("%Y-%m-%d")


def _parse(ts):
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
        # Treat naive timestamps as UTC rather than crashing on compare.
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def plan_days(plan):
    return ORG_PLAN_DAYS if plan == "organisation" else PRO_PLAN_DAYS


# ─────────────────────────────────────────
#  ENTITLEMENT
# ─────────────────────────────────────────
def plan_status(user):
    """Full entitlement picture for one user."""
    if not user:
        return {"is_pro": False, "reason": "anonymous", "tier": "free",
                "expires_at": None, "days_left": None, "in_grace": False}

    # Manual admin grant — no expiry, deliberately. Used for staff,
    # partners and demos.
    if user["is_pro_override"]:
        return {"is_pro": True, "reason": "override", "tier": user["plan_tier"],
                "expires_at": None, "days_left": None, "in_grace": False}

    if user["role"] == "admin":
        return {"is_pro": True, "reason": "admin", "tier": user["plan_tier"],
                "expires_at": None, "days_left": None, "in_grace": False}

    tier = user["plan_tier"] or "free"
    if tier not in PAID_TIERS:
        return {"is_pro": False, "reason": "free_tier", "tier": tier,
                "expires_at": None, "days_left": None, "in_grace": False}

    expires = _parse(user["plan_expires_at"])

    # Paid tier with no expiry recorded — a legacy row from before D1.
    # Honour it rather than cutting off a paying customer, but flag it.
    if not expires:
        return {"is_pro": True, "reason": "legacy_no_expiry", "tier": tier,
                "expires_at": None, "days_left": None, "in_grace": False}

    now = _now()
    if now <= expires:
        return {"is_pro": True, "reason": "active", "tier": tier,
                "expires_at": user["plan_expires_at"],
                "days_left": max(0, (expires - now).days), "in_grace": False}

    grace_end = expires + timedelta(days=PLAN_GRACE_DAYS)
    if now <= grace_end:
        return {"is_pro": True, "reason": "grace", "tier": tier,
                "expires_at": user["plan_expires_at"],
                "days_left": 0, "in_grace": True}

    return {"is_pro": False, "reason": "expired", "tier": tier,
            "expires_at": user["plan_expires_at"],
            "days_left": 0, "in_grace": False}


def is_pro_user(user):
    return plan_status(user)["is_pro"]


def grant_plan(conn, user_id, plan, days=None, extend_from_existing=True):
    """Activate or extend a paid plan.

    extend_from_existing stacks time onto an unexpired plan instead of
    truncating it — so renewing early never costs the user days.
    Returns the new expiry ISO string.
    """
    days = days or plan_days(plan)
    now = _now()

    start = now
    if extend_from_existing:
        row = conn.execute(
            "SELECT plan_expires_at FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        current = _parse(row["plan_expires_at"]) if row else None
        if current and current > now:
            start = current

    expires = start + timedelta(days=days)
    conn.execute(
        """UPDATE users
           SET plan_tier = ?, plan_started_at = ?, plan_expires_at = ?
           WHERE id = ?""",
        (plan, now.isoformat(), expires.isoformat(), user_id),
    )
    return expires.isoformat()


def downgrade_expired(conn):
    """Flip fully-expired paid users back to free. Run from the scheduler.
    Returns the affected user ids."""
    cutoff = (_now() - timedelta(days=PLAN_GRACE_DAYS)).isoformat()
    rows = conn.execute(
        """SELECT id FROM users
           WHERE plan_tier IN ('pro', 'organisation')
             AND is_pro_override = 0
             AND plan_expires_at IS NOT NULL
             AND plan_expires_at < ?""",
        (cutoff,),
    ).fetchall()
    ids = [r["id"] for r in rows]
    for uid in ids:
        conn.execute("UPDATE users SET plan_tier = 'free' WHERE id = ?", (uid,))
    return ids


# ─────────────────────────────────────────
#  QUOTA — atomic
# ─────────────────────────────────────────
def reserve_message(conn, user, daily_limit):
    """Atomically claim one message from today's allowance.

    Returns (ok, used, limit). ok=False means the limit is reached and
    nothing was consumed.

    The date reset happens inside the same statement: when msg_count_date
    is not today, the CASE restarts the counter at 1. One round trip, no
    read-then-write race.
    """
    if is_pro_user(user):
        return True, 0, None
    if not daily_limit or daily_limit <= 0:
        return True, 0, None       # 0 / unset = unlimited per day

    today = _today()
    row = conn.execute(
        """UPDATE users
           SET msg_count = CASE WHEN msg_count_date = ? THEN msg_count + 1 ELSE 1 END,
               msg_count_date = ?
           WHERE id = ?
             AND (msg_count_date <> ? OR msg_count < ?)
           RETURNING msg_count""",
        (today, today, user["id"], today, daily_limit),
    ).fetchone()

    if not row:
        # WHERE clause failed => already at the limit.
        current = conn.execute(
            "SELECT msg_count FROM users WHERE id = ?", (user["id"],)
        ).fetchone()
        return False, (current["msg_count"] if current else daily_limit), daily_limit

    return True, row["msg_count"], daily_limit


def refund_message(conn, user):
    """Give back a reserved message when the AI call failed.

    Without this, a provider outage silently eats a free user's daily
    allowance and they get 25 error messages instead of 25 answers.
    """
    if is_pro_user(user):
        return
    conn.execute(
        """UPDATE users SET msg_count = GREATEST(0, msg_count - 1)
           WHERE id = ? AND msg_count_date = ?""",
        (user["id"], _today()),
    )


def messages_used_today(user):
    if not user:
        return 0
    return user["msg_count"] if user["msg_count_date"] == _today() else 0


def can_upload_file(user, limit):
    if is_pro_user(user):
        return True, None
    used = user["file_uploads_used"] or 0
    if limit and used >= limit:
        return False, used
    return True, used


def reserve_daily_feature(conn, user, feature, daily_limit):
    """Atomically reserve one use of a limited free-tier feature."""
    if is_pro_user(user):
        return True, 0, None
    if not daily_limit or daily_limit <= 0:
        return True, 0, None

    today = _today()
    row = conn.execute(
        """INSERT INTO feature_usage (user_id, feature, usage_date, count)
           VALUES (?, ?, ?, 1)
           ON CONFLICT (user_id, feature, usage_date) DO UPDATE
               SET count = feature_usage.count + 1
               WHERE feature_usage.count < ?
           RETURNING count""",
        (user["id"], feature, today, daily_limit),
    ).fetchone()
    if row:
        return True, row["count"], daily_limit

    current = conn.execute(
        """SELECT count FROM feature_usage
           WHERE user_id = ? AND feature = ? AND usage_date = ?""",
        (user["id"], feature, today),
    ).fetchone()
    return False, (current["count"] if current else daily_limit), daily_limit


def refund_daily_feature(conn, user, feature):
    if is_pro_user(user):
        return
    conn.execute(
        """UPDATE feature_usage SET count = GREATEST(0, count - 1)
           WHERE user_id = ? AND feature = ? AND usage_date = ?""",
        (user["id"], feature, _today()),
    )


def daily_feature_usage(conn, user_id):
    rows = conn.execute(
        """SELECT feature, count FROM feature_usage
           WHERE user_id = ? AND usage_date = ?""",
        (user_id, _today()),
    ).fetchall()
    return {row["feature"]: row["count"] for row in rows}


# ─────────────────────────────────────────
#  ACTIVITY (D2)
# ─────────────────────────────────────────
def touch_login(conn, user_id):
    now = _now().isoformat()
    conn.execute(
        "UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?",
        (now, now, user_id),
    )


def touch_seen(conn, user_id):
    """Called from /api/user/me. Throttled to once an hour so a chatty
    client does not write on every poll."""
    row = conn.execute(
        "SELECT last_seen_at FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    last = _parse(row["last_seen_at"]) if row else None
    if last and (_now() - last).total_seconds() < 3600:
        return False
    conn.execute(
        "UPDATE users SET last_seen_at = ? WHERE id = ?",
        (_now().isoformat(), user_id),
    )
    return True
