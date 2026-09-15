// ════════════════════════════════════════
//  Onboarding.js — Auth guard + name caching for the dashboard (index.htm)
//  The actual onboarding flow now lives in onboarding.htm.
// ════════════════════════════════════════

(function () {
  const BASE_URL = "";
  const token = localStorage.getItem("kairos_token");

  // ── AUTH GUARD — bounce straight to login if not signed in ──
  if (!token) {
    window.location.href = "/login";
    return;
  }

  // Make the cached name available immediately (no flash of "friend"
  // while the /api/user/me fetch is in flight).
  window.KAIROS_USER_NAME =
    localStorage.getItem("kairos_preferred_name") ||
    localStorage.getItem("kairos_name") ||
    "friend";

  window.getKairosName = function () {
    return window.KAIROS_USER_NAME || "friend";
  };

  // ── Fetch live profile; bounce to onboarding if it was never completed ──
  async function init() {
    try {
      const res = await fetch(`${BASE_URL}/api/user/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        localStorage.clear();
        window.location.href = "/login";
        return;
      }
      const data = await res.json();

      if (!data.onboarded) {
        window.location.href = "/onboarding.htm";
        return;
      }

      window.KAIROS_USER_NAME = data.preferred_name || data.name || "friend";
      localStorage.setItem("kairos_preferred_name", data.preferred_name || "");
      localStorage.setItem("kairos_name", data.name || "");
      localStorage.setItem("kairos_plan", data.plan || "free");
      localStorage.setItem("kairos_onboarded", "1");
    } catch (e) {
      console.warn(
        "Onboarding.js: could not reach backend, using cached profile.",
        e,
      );
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
