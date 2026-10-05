"""Fast checks for the beta's security and entitlement contracts.

These tests deliberately avoid importing backend.py: importing it runs live
migrations against the configured Postgres service. They cover pure modules
and verify the route-level guarantees that are safe to run in every clone.
"""

import os
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("SECRET_KEY", "test-secret-key-that-is-long-enough-for-signing-123")

import auth
import plans
import preflight


ROOT = Path(__file__).resolve().parents[1]


def user(**changes):
    value = {
        "id": "user-1", "role": "user", "plan_tier": "free",
        "plan_expires_at": None, "is_pro_override": 0,
        "msg_count": 0, "msg_count_date": "", "file_uploads_used": 0,
    }
    value.update(changes)
    return value


class AuthTests(unittest.TestCase):
    def test_signed_token_round_trip_and_tamper_rejection(self):
        token = auth.issue_token("user-1", "member@example.com", auth_version=3)
        payload = auth.verify_token(token)
        self.assertEqual(payload["uid"], "user-1")
        self.assertEqual(payload["av"], 3)
        self.assertIsNone(auth.verify_token(token + "tampered"))

    def test_logout_auth_version_revokes_existing_token(self):
        class Connection:
            def __init__(self, row):
                self.row = row

            def execute(self, _sql, _params):
                return self

            def fetchone(self):
                return self.row

            def close(self):
                pass

        database_user = {
            "id": "user-1",
            "auth_version": 4,
            "suspended": 0,
        }
        token = auth.issue_token(
            "user-1", "member@example.com", auth_version=4
        )
        payload = auth.verify_token(token)

        self.assertIsNotNone(
            auth._load_user_from_payload(payload, lambda: Connection(database_user))
        )

        # The logout endpoint performs this version increment in the database.
        database_user["auth_version"] += 1

        self.assertIsNone(
            auth._load_user_from_payload(payload, lambda: Connection(database_user))
        )


class PlanTests(unittest.TestCase):
    def test_expired_paid_plan_loses_pro_access_after_grace(self):
        expired = (datetime.now(timezone.utc) - timedelta(days=plans.PLAN_GRACE_DAYS + 1)).isoformat()
        status = plans.plan_status(user(plan_tier="pro", plan_expires_at=expired))
        self.assertFalse(status["is_pro"])
        self.assertEqual(status["reason"], "expired")

    def test_admin_and_override_remain_unlimited(self):
        self.assertTrue(plans.is_pro_user(user(role="admin")))
        self.assertTrue(plans.is_pro_user(user(is_pro_override=1)))


class BackendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (ROOT / "backend.py").read_text(encoding="utf-8")

    def test_paystack_reserves_reference_before_granting_plan(self):
        insert = self.source.index("INSERT INTO payments")
        grant = self.source.index("plans.grant_plan", insert)
        self.assertLess(insert, grant)
        self.assertIn("ON CONFLICT (reference) DO NOTHING", self.source)

    def test_free_feature_quota_is_atomic(self):
        source = (ROOT / "plans.py").read_text(encoding="utf-8")
        self.assertIn("ON CONFLICT (user_id, feature, usage_date) DO UPDATE", source)
        self.assertIn("WHERE feature_usage.count < ?", source)

    def test_admin_mutations_are_guarded_and_audited(self):
        for route in ("admin_toggle_override", "admin_set_plan",
                      "admin_suspend_user", "admin_delete_user"):
            position = self.source.index(f"def {route}")
            preceding = self.source[max(0, position - 300):position]
            self.assertIn("@require_admin", preceding)
            following = self.source[position:position + 1800]
            self.assertIn("audit(", following)

    def test_production_alias_is_normalized_before_boot_checks(self):
        self.assertIn('if APP_ENV == "prod":', self.source)
        self.assertIn('APP_ENV = "production"', self.source)

    def test_speech_api_is_optional_in_frontend(self):
        source = (ROOT / "script.js").read_text(encoding="utf-8")
        self.assertIn("if (!window.speechSynthesis) return;", source)
        self.assertIn("typeof SpeechSynthesisUtterance === 'undefined'", source)


class DeploymentContractTests(unittest.TestCase):
    def test_production_requires_shared_redis_state(self):
        with patch.dict(os.environ, {"WEB_CONCURRENCY": "1"}, clear=True):
            checks = preflight.Preflight("production")
            checks._scaling()
        self.assertTrue(any("REDIS_URL is required" in item for item in checks.fatal))

    def test_redis_rate_limit_increment_is_atomic(self):
        source = (ROOT / "store.py").read_text(encoding="utf-8")
        self.assertIn("self._r.eval(", source)
        self.assertIn("return bool(result[0]), int(result[1])", source)

    def test_health_includes_shared_store_readiness(self):
        source = (ROOT / "backend.py").read_text(encoding="utf-8")
        self.assertIn("store_ok = bool(store.ping())", source)
        self.assertIn("healthy = db_ok and store_ok and any_provider", source)

    def test_tokenless_stream_falls_back_to_standard_chat(self):
        source = (ROOT / "brain.js").read_text(encoding="utf-8")
        self.assertGreaterEqual(source.count("return window.askKairos(userMessage, opts);"), 3)


if __name__ == "__main__":
    unittest.main()
