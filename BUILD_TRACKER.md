# KAIROS Build Tracker

Start date: 2026-08-14
Target: controlled web beta by 2026-08-30

## Phase 0 - Foundation and tracking

- [x] Audit current feature gates and admin coverage.
- [x] Define limited free access for high-value features.
- [x] Add repository-level progress tracking.
- [x] Verify Python syntax and quota wiring.
- [ ] Verify the migration and endpoints against the live database.

## Phase 1 - Limited free access

- [x] Camera vision: 3 free analyses per day.
- [x] Screen analysis: 2 free analyses per day.
- [x] Memory: 5 saved memories for free accounts.
- [x] Reminders: 3 active reminders for free accounts.
- [x] Return usage and limits from the profile/config APIs.
- [x] Add admin-editable quota controls with live runtime enforcement.
- [x] Display remaining usage clearly in Settings and feature-limit notices.

## Phase 2 - Admin operations

- [x] Build the user detail drawer.
- [x] Add suspend, plan, reset, payment, and usage controls.
- [x] Add audit-log and configuration views.
- [x] Make notification dismissal immediate and persist read state in the background.
- [x] Add admin audiences for inactive, near-limit Free, and expiring Pro users.
- [x] Support in-app, email, or combined delivery from the admin message page.
- [x] Verify active database limits at 100 messages/day and 3 uploads for Free users.

## Phase 3 - Security and trust

- [x] Harden authentication and logout with database-backed token revocation.
- [x] Make Paystack verification atomic and idempotent under concurrent requests.
- [x] Add a bounded database connection timeout for portable startup failures.
- [x] Correct privacy and terms content for the hosted service architecture.

## Phase 4 - Core experience

- [x] Stream generated replies into the main voice surface before speech playback.
- [x] Prevent microphone self-hearing by stopping recognition during playback and filtering echoed text.
- [x] Add interruption/barge-in controls with orb, Escape, and a shared voice API.
- [x] Prepare shared `window.kairosVoice` interfaces for Android and desktop wrappers.

## Phase 5 - Beta verification

- [x] Add automated contract tests for auth, payments, quotas, plan expiry, and admin actions.
- [ ] Run full desktop and mobile browser checks against the deployed backend.
- [x] Capture desktop (1440px) and mobile (390px) viewport smoke screenshots locally;
      authenticated/API rendering still requires the deployed HTTPS environment.
- [x] Document Android and desktop packaging.
- [x] Admin limits write through the database, including configurable new-user-only Pro trial days.
- [x] Removed bulk Free-user trial grant; signup applies the configured trial only to newly created accounts.
- [x] Admin manual notifications with audience targeting and dismissible unread user notices.
- [x] Referral threshold/reward configuration, verified-referral counters, explicit claim endpoint, and user progress UI.
- [x] Settings back button skips the entrance video when returning to the dashboard.
- [x] Vision/screen routing appends OpenRouter-compatible fallbacks when legacy DB routing is OpenAI-only.
- [x] Text chat appends configured OpenAI as a last-resort fallback when Groq/OpenRouter fail.
- [x] Investor audit: repair landing Contact and Terms home links plus legacy URL aliases.
- [x] Investor audit: make Flask debug/reloader explicit opt-in for stable single-process demos.
- [x] Investor audit: verify every public/app/admin page route returns HTTP 200 locally.
- [x] Navigation: authenticated landing redirects to one-time `/app/new`; refresh preserves the active conversation.
- [x] Navigation: public-page Home links skip the cinematic intro, including Manual.
- [x] Groq chat routing set to llama-3.3-70b-versatile with legacy model translation.
- [x] Added Vercel Flask build/routing configuration and excluded local secrets/logs.
- [x] Removed legacy mini settings panel; moved orb state colors to the full Settings page.
