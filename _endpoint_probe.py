import os

os.environ["PYTHONUTF8"] = "1"

import requests
from dotenv import load_dotenv

load_dotenv(".env")

import auth
from backend import get_db

conn = get_db()
try:
    user = conn.execute(
        """SELECT u.id, u.email, u.role, u.plan_tier, COALESCE(u.auth_version, 0) AS auth_version
           FROM users u
           JOIN conversations c ON c.user_id = u.id
           WHERE c.id = ?""",
        (28,),
    ).fetchone()
finally:
    conn.close()

if not user:
    raise SystemExit("No user found for conversation 28")

token = auth.issue_token(
    user["id"], user["email"], user["role"], user["plan_tier"], user["auth_version"]
)
response = requests.post(
    "http://127.0.0.1:5000/ask/stream",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    json={"message": "Reply with exactly KAIROS_OK", "history": []},
    timeout=60,
)
print("STATUS", response.status_code)
print(response.text[:2000])
