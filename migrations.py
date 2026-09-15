# ════════════════════════════════════════════════════════════
#  migrations.py — schema  (D1-D11)
#
#  Idempotent: safe to run on every boot. Each statement uses
#  IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so no version table
#  is needed yet.
#
#  WHAT THIS UNBLOCKS
#  ------------------
#  D1  plan_expires_at   — subscriptions previously NEVER expired.
#                          One payment set plan_tier='pro' forever, so
#                          "warn 7 days before expiry" was impossible
#                          and a single ₦4,500 charge bought lifetime
#                          Pro. This is the column the whole comms
#                          system depends on.
#  D2  last_login/seen   — "signed in and left" was undetectable.
#                          msg_count_date only holds TODAY, not history.
#  D3  email verify/optin— marketing mail legally needs unsubscribe
#                          (CAN-SPAM / GDPR / NDPR), and signup only
#                          checked the MX record, so typo'd addresses
#                          hard-bounce and wreck sender reputation.
#  D4  payments          — Paystack references were never recorded, so
#                          one reference could be replayed by anyone to
#                          get Pro.
#  D5  CASCADE           — "delete user" orphaned rows in 5 tables. That
#                          is a data-protection problem, not just mess.
#  D7  notifications     — UNIQUE(user_id, template_key, scheduled_at)
#                          is the idempotency guard that stops a crashed
#                          job or a second gunicorn worker from emailing
#                          the same person twice.
# ════════════════════════════════════════════════════════════

from datetime import datetime, timezone


def _now():
    return datetime.now(timezone.utc).isoformat()


# ─────────────────────────────────────────
#  BASE TABLES
# ─────────────────────────────────────────
BASE_TABLES = [
    ("feature_usage", """
        CREATE TABLE IF NOT EXISTS feature_usage (
            id         SERIAL PRIMARY KEY,
            user_id    TEXT NOT NULL,
            feature    TEXT NOT NULL,
            usage_date TEXT NOT NULL,
            count      INTEGER DEFAULT 0,
            UNIQUE(user_id, feature, usage_date)
        )
    """),
    ("memories", """
        CREATE TABLE IF NOT EXISTS memories (
            id         SERIAL PRIMARY KEY,
            user_id    TEXT    NOT NULL,
            key        TEXT    NOT NULL,
            value      TEXT    NOT NULL,
            created_at TEXT    NOT NULL,
            UNIQUE(user_id, key)
        )
    """),
    ("users", """
        CREATE TABLE IF NOT EXISTS users (
            id              TEXT PRIMARY KEY,
            email           TEXT UNIQUE NOT NULL,
            role            TEXT DEFAULT 'user',
            plan_tier       TEXT DEFAULT 'free',
            is_pro_override INTEGER DEFAULT 0,
            created_at      TEXT NOT NULL
        )
    """),
    ("webauthn_credentials", """
        CREATE TABLE IF NOT EXISTS webauthn_credentials (
            id            SERIAL PRIMARY KEY,
            user_id       TEXT NOT NULL,
            credential_id TEXT UNIQUE NOT NULL,
            public_key    TEXT NOT NULL,
            sign_count    INTEGER DEFAULT 0,
            created_at    TEXT NOT NULL
        )
    """),
    ("conversations", """
        CREATE TABLE IF NOT EXISTS conversations (
            id         SERIAL PRIMARY KEY,
            user_id    TEXT NOT NULL,
            title      TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """),
    ("conversation_history", """
        CREATE TABLE IF NOT EXISTS conversation_history (
            id         SERIAL PRIMARY KEY,
            user_id    TEXT    NOT NULL,
            role       TEXT    NOT NULL,
            content    TEXT    NOT NULL,
            created_at TEXT    NOT NULL
        )
    """),
    ("reminders", """
        CREATE TABLE IF NOT EXISTS reminders (
            id         SERIAL PRIMARY KEY,
            user_id    TEXT NOT NULL,
            text       TEXT NOT NULL,
            remind_at  TEXT NOT NULL,
            fired      INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """),
]


# ─────────────────────────────────────────
#  NEW TABLES
# ─────────────────────────────────────────
NEW_TABLES = [
    # D4 — payment replay prevention
    ("payments", """
        CREATE TABLE IF NOT EXISTS payments (
            reference    TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL,
            email        TEXT,
            plan         TEXT NOT NULL,
            amount_kobo  INTEGER NOT NULL,
            days_granted INTEGER,
            verified_at  TEXT NOT NULL,
            raw          TEXT
        )
    """),

    # D6 — editable message templates (NOT hardcoded, NOT in persona.json:
    # they need their own versioning and change independently of prompts)
    ("message_templates", """
        CREATE TABLE IF NOT EXISTS message_templates (
            key        TEXT PRIMARY KEY,
            channel    TEXT NOT NULL DEFAULT 'email',
            subject    TEXT,
            body       TEXT NOT NULL,
            enabled    INTEGER DEFAULT 1,
            updated_by TEXT,
            updated_at TEXT NOT NULL
        )
    """),

    # D7 — send log + idempotency
    ("notifications", """
        CREATE TABLE IF NOT EXISTS notifications (
            id            SERIAL PRIMARY KEY,
            user_id       TEXT NOT NULL,
            template_key  TEXT NOT NULL,
            channel       TEXT NOT NULL DEFAULT 'email',
            subject       TEXT,
            body          TEXT,
            status        TEXT NOT NULL DEFAULT 'queued',
            error         TEXT,
            campaign_id   INTEGER,
            scheduled_at  TEXT NOT NULL,
            sent_at       TEXT,
            read_at       TEXT,
            created_at    TEXT NOT NULL,
            UNIQUE(user_id, template_key, scheduled_at)
        )
    """),

    # D8 — campaigns, incl. standing ones the admin can stop
    ("campaigns", """
        CREATE TABLE IF NOT EXISTS campaigns (
            id              SERIAL PRIMARY KEY,
            name            TEXT NOT NULL,
            template_key    TEXT,
            segment         TEXT NOT NULL,
            channel         TEXT NOT NULL DEFAULT 'email',
            subject         TEXT,
            body            TEXT,
            status          TEXT NOT NULL DEFAULT 'draft',
            recurring       INTEGER DEFAULT 0,
            active          INTEGER DEFAULT 0,
            recipient_count INTEGER DEFAULT 0,
            sent_count      INTEGER DEFAULT 0,
            failed_count    INTEGER DEFAULT 0,
            created_by      TEXT,
            approved_by     TEXT,
            approved_at     TEXT,
            last_run_at     TEXT,
            created_at      TEXT NOT NULL
        )
    """),

    # N5 — admin audit trail (no record of who deleted whom before)
    ("admin_audit_log", """
        CREATE TABLE IF NOT EXISTS admin_audit_log (
            id           SERIAL PRIMARY KEY,
            admin_email  TEXT NOT NULL,
            action       TEXT NOT NULL,
            target_type  TEXT,
            target_id    TEXT,
            detail       TEXT,
            ip           TEXT,
            created_at   TEXT NOT NULL
        )
    """),

    # E4 — daily email counter so the Brevo 300/day cap is respected
    # and the queue resumes instead of dropping the tail of the list
    ("email_quota", """
        CREATE TABLE IF NOT EXISTS email_quota (
            day        TEXT PRIMARY KEY,
            sent_count INTEGER NOT NULL DEFAULT 0
        )
    """),
]


# ─────────────────────────────────────────
#  COLUMN ADDITIONS
# ─────────────────────────────────────────
USER_COLUMNS = {
    # pre-existing
    "password_hash":       "TEXT",
    "name":                "TEXT DEFAULT ''",
    "preferred_name":      "TEXT DEFAULT ''",
    "onboarded":           "INTEGER DEFAULT 0",
    "msg_count":           "INTEGER DEFAULT 0",
    "msg_count_date":      "TEXT DEFAULT ''",
    "google_id":           "TEXT",
    "reset_token":         "TEXT",
    "reset_token_expires": "TEXT",
    "file_uploads_used":   "INTEGER DEFAULT 0",

    # D1 — subscriptions that actually expire
    "plan_expires_at":     "TEXT",
    "plan_started_at":     "TEXT",

    # D2 — lifecycle / segmentation
    "last_login_at":       "TEXT",
    "last_seen_at":        "TEXT",

    # D3 — deliverability + legal
    "email_verified":      "INTEGER DEFAULT 0",
    "email_opt_in":        "INTEGER DEFAULT 1",
    "unsubscribe_token":   "TEXT",
    "verify_token":        "TEXT",
    "verify_sent_at":      "TEXT",
    "auth_version":        "INTEGER DEFAULT 0",
    "referral_code":       "TEXT",
    "referred_by":         "TEXT",
    "referral_rewarded":   "INTEGER DEFAULT 0",
    "referral_count":      "INTEGER DEFAULT 0",
    "referral_claimed":    "INTEGER DEFAULT 0",
    "credit_balance":      "INTEGER DEFAULT 0",

    # admin ops
    "suspended":           "INTEGER DEFAULT 0",
    "suspended_reason":    "TEXT",
}

OTHER_COLUMNS = [
    ("conversation_history", "conversation_id", "INTEGER"),
    ("conversations",        "archived",        "INTEGER DEFAULT 0"),
    ("reminders",            "notified",        "INTEGER DEFAULT 0"),
]


# ─────────────────────────────────────────
#  FOREIGN KEYS (D5) — real cascade deletes
#
#  Named constraints so re-running is safe: we drop-if-exists then
#  add, which also repairs a half-applied earlier run.
# ─────────────────────────────────────────
CASCADES = [
    ("feature_usage",         "fk_feature_usage_user", "user_id"),
    ("memories",             "fk_memories_user",      "user_id"),
    ("webauthn_credentials", "fk_webauthn_user",      "user_id"),
    ("conversations",        "fk_conversations_user", "user_id"),
    ("conversation_history", "fk_convhist_user",      "user_id"),
    ("reminders",            "fk_reminders_user",     "user_id"),
    ("notifications",        "fk_notifications_user", "user_id"),
    ("payments",             "fk_payments_user",      "user_id"),
]

INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_feature_usage_user ON feature_usage(user_id, usage_date)",
    "CREATE INDEX IF NOT EXISTS idx_memories_user       ON memories(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_convhist_user       ON conversation_history(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_convhist_conv       ON conversation_history(conversation_id)",
    "CREATE INDEX IF NOT EXISTS idx_conversations_user  ON conversations(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_reminders_user      ON reminders(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_reminders_due       ON reminders(fired, remind_at)",
    "CREATE INDEX IF NOT EXISTS idx_webauthn_user       ON webauthn_credentials(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_users_email_lower   ON users(email)",
    "CREATE INDEX IF NOT EXISTS idx_users_plan_expiry   ON users(plan_tier, plan_expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_users_last_seen     ON users(last_seen_at)",
    "CREATE INDEX IF NOT EXISTS idx_notif_status        ON notifications(status, scheduled_at)",
    "CREATE INDEX IF NOT EXISTS idx_notif_user          ON notifications(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_payments_user       ON payments(user_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_audit_created       ON admin_audit_log(created_at)",
]


# ─────────────────────────────────────────
#  DEFAULT MESSAGE TEMPLATES
#
#  Seeded once, then fully editable from the admin panel. Variables are
#  filled per-recipient, which is how you get "not the same message to
#  all users" without an LLM call per person.
# ─────────────────────────────────────────
DEFAULT_TEMPLATES = [
    {
        "key": "pro_expiry_7d",
        "channel": "email",
        "subject": "Your K.A.I.R.O.S Pro plan renews in 7 days",
        "body": (
            "Hi {{name}},\n\n"
            "Your K.A.I.R.O.S {{plan}} plan expires on {{expiry_date}} "
            "— that's {{days_left}} days from now.\n\n"
            "You've sent {{messages_used}} messages this month and used "
            "{{file_uploads}} file uploads. Renew to keep camera, screen "
            "share and memory active.\n\n"
            "— K.A.I.R.O.S"
        ),
    },
    {
        "key": "pro_expiry_3d",
        "channel": "email",
        "subject": "3 days left on your K.A.I.R.O.S Pro plan",
        "body": (
            "Hi {{name}},\n\n"
            "Your {{plan}} plan ends on {{expiry_date}}. After that, camera, "
            "screen sharing and memory switch off and you'll return to the "
            "free plan's {{free_limit}} messages a day.\n\n"
            "Renew any time from Settings.\n\n"
            "— K.A.I.R.O.S"
        ),
    },
    {
        "key": "pro_expiry_1d",
        "channel": "email",
        "subject": "Your K.A.I.R.O.S Pro plan ends tomorrow",
        "body": (
            "Hi {{name}},\n\n"
            "Tomorrow ({{expiry_date}}) your {{plan}} plan expires.\n\n"
            "Renew today and nothing changes — same models, same features, "
            "no interruption.\n\n"
            "— K.A.I.R.O.S"
        ),
    },
    {
        "key": "upgrade_nudge_heavy_user",
        "channel": "email",
        "subject": "{{name}}, you're hitting your daily limit",
        "body": (
            "Hi {{name}},\n\n"
            "You've hit the free plan's {{free_limit}}-message limit "
            "{{cap_hit_days}} days recently. Pro removes the limit entirely "
            "and unlocks camera, screen sharing and memory.\n\n"
            "— K.A.I.R.O.S"
        ),
    },
    {
        "key": "onboarding_incomplete",
        "channel": "email",
        "subject": "You're one step from meeting K.A.I.R.O.S",
        "body": (
            "Hi {{name}},\n\n"
            "You created your account but never finished setting up. It takes "
            "about thirty seconds — pick a name for me to call you and you're "
            "in.\n\n"
            "{{app_url}}\n\n"
            "— K.A.I.R.O.S"
        ),
    },
    {
        "key": "inactive_reengage",
        "channel": "email",
        "subject": "Still here when you need me, {{name}}",
        "body": (
            "Hi {{name}},\n\n"
            "It's been {{days_inactive}} days. Since you were last here I can "
            "route coding questions to stronger models, read your documents, "
            "and remember what matters to you.\n\n"
            "Say \"{{wake_word}}\" and I'll pick up where we left off.\n\n"
            "— K.A.I.R.O.S"
        ),
    },
]


# ─────────────────────────────────────────
#  RUNNER
# ─────────────────────────────────────────
def run(get_db, verbose=True):
    conn = get_db()
    applied = {"tables": [], "columns": [], "cascades": [], "indexes": 0,
               "templates": 0, "warnings": []}
    try:
        # base + new tables
        for name, ddl in BASE_TABLES + NEW_TABLES:
            conn.execute(ddl)
            applied["tables"].append(name)

        # user columns
        for col, coltype in USER_COLUMNS.items():
            conn.execute(f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {col} {coltype}")
            applied["columns"].append(f"users.{col}")

        # other columns
        for table, col, coltype in OTHER_COLUMNS:
            conn.execute(
                f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {coltype}"
            )
            applied["columns"].append(f"{table}.{col}")

        conn.commit()

        # cascades — each in its own try so one pre-existing constraint
        # or an orphaned row cannot abort the whole migration
        for table, constraint, column in CASCADES:
            try:
                conn.execute(
                    f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {constraint}"
                )
                conn.execute(
                    f"""ALTER TABLE {table}
                        ADD CONSTRAINT {constraint}
                        FOREIGN KEY ({column}) REFERENCES users(id)
                        ON DELETE CASCADE NOT VALID"""
                )
                conn.commit()
                applied["cascades"].append(f"{table}.{column}")
            except Exception as e:
                conn.rollback()
                # Almost always orphaned rows from before CASCADE existed.
                applied["warnings"].append(
                    f"cascade {table}.{column} skipped: {str(e)[:120]}"
                )

        # indexes
        for ddl in INDEXES:
            try:
                conn.execute(ddl)
                applied["indexes"] += 1
            except Exception as e:
                conn.rollback()
                applied["warnings"].append(f"index skipped: {str(e)[:120]}")
        conn.commit()

        # backfill
        _backfill(conn, applied)

        # templates
        now = _now()
        for tpl in DEFAULT_TEMPLATES:
            conn.execute(
                """INSERT INTO message_templates
                       (key, channel, subject, body, enabled, updated_by, updated_at)
                   VALUES (?, ?, ?, ?, 1, 'seed', ?)
                   ON CONFLICT (key) DO NOTHING""",
                (tpl["key"], tpl["channel"], tpl["subject"], tpl["body"], now),
            )
            applied["templates"] += 1
        conn.commit()

    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    if verbose:
        print(f"🗄️  Migrations OK — {len(applied['tables'])} tables, "
              f"{len(applied['columns'])} columns, "
              f"{len(applied['cascades'])} cascades, "
              f"{applied['indexes']} indexes, "
              f"{applied['templates']} templates")
        for w in applied["warnings"]:
            print(f"   ⚠️  {w}")
    return applied


def _backfill(conn, applied):
    """Give existing rows sane values for the new columns."""
    now = _now()

    # Unsubscribe tokens for everyone — required before any bulk send,
    # since a missing token means an unsubscribe link we cannot honour.
    rows = conn.execute(
        "SELECT id FROM users WHERE unsubscribe_token IS NULL OR unsubscribe_token = ''"
    ).fetchall()
    if rows:
        import secrets
        for r in rows:
            conn.execute(
                "UPDATE users SET unsubscribe_token = ? WHERE id = ?",
                (secrets.token_urlsafe(32), r["id"]),
            )
        applied.setdefault("backfill", []).append(
            f"{len(rows)} unsubscribe tokens"
        )

    # Existing Google / passkey accounts already proved control of the
    # inbox, so mark them verified rather than emailing them to re-verify.
    conn.execute(
        """UPDATE users SET email_verified = 1
           WHERE email_verified = 0 AND google_id IS NOT NULL AND google_id <> ''"""
    )

    # Anyone already on a paid tier with no expiry: seed last_seen so the
    # inactivity segment does not immediately treat them as dormant.
    conn.execute(
        "UPDATE users SET last_seen_at = ? WHERE last_seen_at IS NULL",
        (now,),
    )

    conn.commit()
