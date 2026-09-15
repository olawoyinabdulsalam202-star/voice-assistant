"""Fast checks for the beta's security and entitlement contracts.

These tests deliberately avoid importing backend.py: importing it runs live
migrations against the configured Postgres service. They cover pure modules
and verify the route-level guarantees that are safe to run in every clone.
"""

import os
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ.setdefault("SECRET_KEY", "test-secret-key-that-is-long-enough-for-signing-123")

import auth
import plans


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


if __name__ == "__main__":
    unittest.main()
