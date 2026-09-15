# KAIROS Android and Desktop Packaging

KAIROS remains a web beta until the browser workflow is stable. The existing
PWA manifest and service worker are the shared application layer; the wrapper
must load the hosted HTTPS application instead of bundling API keys or a copy
of the database configuration.

## Before packaging

- Deploy behind HTTPS with `PUBLIC_BASE_URL` set to the public origin.
- Set `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` to that same origin.
- Configure Android network security and desktop CSP to allow the hosted API,
  Paystack, Google sign-in, AI providers, and required font/CDN origins.
- Keep `window.kairosVoice` as the wrapper-facing interface for speak, stop,
  and interrupt. Do not call browser recognition internals from native code.

## Android

Use Capacitor after the web beta. It preserves the web code and provides
native microphone, camera, share-sheet, notification, and foreground-service
capabilities. Android does not permit a Siri-style always-visible overlay from
a normal web page; any overlay needs a separate native permissioned feature.

Required native permissions: microphone, camera, notifications, and media
projection only when the user starts screen sharing. Request each at the point
of use. Do not request overlay permission during onboarding.

## Desktop

Use Tauri for the desktop shell. It is smaller than Electron and can expose
tray controls, global shortcuts, native notifications, and a compact assistant
window while reusing the hosted web UI. Package only after updating the CSP and
allowlist to the deployed API origin.

## Release checks

- Verify login, logout, password reset, payment confirmation, free quotas,
  voice interruption, camera, screen sharing, and notifications on a real
  Android device and Windows desktop.
- Confirm the app works after a service-worker update and after an expired
  session.
- Never put `SECRET_KEY`, Paystack secret keys, database credentials, or AI
  provider keys in an Android APK or desktop bundle.
