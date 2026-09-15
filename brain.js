// ════════════════════════════════════════
//  brain.js  —  KAIROS AI ENGINE  v13
//
//  FIXED IN v13
//  ------------
//  F1  Removed the hardcoded BASE_URL = "http://127.0.0.1:5000".
//      That single line meant chat was dead on any machine that was
//      not the dev laptop, and was blocked as mixed content the
//      moment the site was served over HTTPS. Now same-origin.
//
//  A7  conversationHistory used to store the AUGMENTED message —
//      the one with the document, memory block and language header
//      already prepended by the Filereader/Memory/Multilang patches.
//      So on turn 2 the document was prepended AGAIN to a history
//      that already contained it, and by turn 4 the same document
//      was in the payload four times. Growth was quadratic.
//      Now: the RAW user text goes into history, context is rebuilt
//      fresh each turn.
//
//  A3  Streaming. The old code awaited the entire completion before
//      showing anything, which is most of why replies felt like they
//      took 30 seconds. Now tokens render as they arrive and
//      time-to-first-word is about a second.
//
//  F6  window.askKairos is defined HERE and only here. ai.js used to
//      look like it defined it too, so load order decided which one
//      you got.
// ════════════════════════════════════════

// Same-origin. Works on localhost, on a LAN IP, and in production
// with no code change. Override only if the API is on another host.
const BASE_URL = window.KAIROS_API_BASE || "";

const BACKEND_URL        = `${BASE_URL}/ask`;
const BACKEND_STREAM_URL = `${BASE_URL}/ask/stream`;
const BACKEND_VISION_URL = `${BASE_URL}/vision`;
const BACKEND_SCREEN_URL = `${BASE_URL}/screen`;

// Raw turns only — never the augmented payload. See A7 above.
let conversationHistory = [];

const MAX_HISTORY_TURNS = 20;

function authHeaders(extra) {
  const token = localStorage.getItem("kairos_token") || "";
  return Object.assign(
    { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    extra || {}
  );
}

function pushHistory(role, content) {
  conversationHistory.push({ role, content });
  if (conversationHistory.length > MAX_HISTORY_TURNS) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY_TURNS);
  }
}

// Session dropped or token expired — bounce to login rather than
// leaving the user talking to a dead app.
function handleAuthFailure() {
  try {
    localStorage.removeItem("kairos_token");
  } catch (e) { /* private mode */ }
  if (!window.location.pathname.includes("auth")) {
    window.location.href = "/login";
  }
}

// The context patches (Memory.js, Filereader.js, Multilang.js) wrap
// askKairos and prepend their blocks. They pass the combined string as
// `augmented`, but we only ever STORE `raw`.
window.askKairos = async function (userMessage, opts) {
  const options   = opts || {};
  const augmented = options.augmented || userMessage;
  const raw       = options.raw || userMessage;

  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        message: augmented,
        history: conversationHistory.slice(),
      }),
    });

    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON error page */ }

    if (res.status === 401) { handleAuthFailure(); return data.error || "Please log in again."; }
    if (!res.ok) return data.error || "Something went wrong. Please try again.";

    const reply = data.reply || "";
    pushHistory("user", raw);
    pushHistory("assistant", reply);

    // Surfaced so the UI can show which model answered — this is what
    // makes the smart router visible instead of invisible.
    window.KAIROS_LAST_ROUTE = data.route || null;
    return reply;

  } catch (err) {
    console.error("brain.js error:", err);
    return "I'm having trouble reaching my neural core. Please check your connection.";
  }
};

// ── STREAMING (A3) ──
// onDelta(textChunk) fires per token; resolves with the full reply.
// Falls back to the non-streaming path automatically, so a proxy that
// buffers SSE degrades instead of breaking.
window.askKairosStream = async function (userMessage, onDelta, opts) {
  const options   = opts || {};
  const augmented = options.augmented || userMessage;
  const raw       = options.raw || userMessage;

  let res;
  try {
    res = await fetch(BACKEND_STREAM_URL, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        message: augmented,
        history: conversationHistory.slice(),
      }),
    });
  } catch (err) {
    console.warn("brain.js: stream unreachable, falling back:", err);
    return window.askKairos(userMessage, opts);
  }

  if (res.status === 401) { handleAuthFailure(); return "Please log in again."; }

  if (!res.ok || !res.body) {
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (data.error) return data.error;
    return window.askKairos(userMessage, opts);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full   = "";
  let route  = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";   // keep the partial line

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let evt;
        try { evt = JSON.parse(payload); } catch (e) { continue; }

        if (evt.error) {
          if (full) break;              // partial answer is better than none
          return evt.error;
        }
        if (evt.route)  route = evt.route;
        if (evt.delta) {
          full += evt.delta;
          if (typeof onDelta === "function") onDelta(evt.delta, full);
        }
      }
    }
  } catch (err) {
    console.error("brain.js stream error:", err);
    if (!full) return "The connection dropped mid-reply. Please try again.";
  }

  if (full) {
    pushHistory("user", raw);
    pushHistory("assistant", full);
  }
  window.KAIROS_LAST_ROUTE = route;
  return full || "I didn't get a reply. Please try again.";
};

// ── CAMERA VISION ──
window.askKairosVision = async function (imageB64, question) {
  try {
    const res = await fetch(BACKEND_VISION_URL, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ image: imageB64, question }),
    });

    let data = {};
    try { data = await res.json(); } catch (e) {}

    if (res.status === 401) { handleAuthFailure(); return "Please log in again."; }
    if (!res.ok) return data.error || "Vision analysis failed.";

    const reply = data.reply || "";
    pushHistory("user", `[Camera] ${question}`);
    pushHistory("assistant", reply);
    return reply;

  } catch (err) {
    console.error("brain.js vision error:", err);
    return "I couldn't analyse the camera feed. Please check your connection.";
  }
};

// ── SCREEN SHARE ──
window.askKairosScreen = async function (imageB64, question) {
  try {
    const res = await fetch(BACKEND_SCREEN_URL, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ image: imageB64, question }),
    });

    let data = {};
    try { data = await res.json(); } catch (e) {}

    if (res.status === 401) { handleAuthFailure(); return "Please log in again."; }
    if (!res.ok) return data.error || "Screen analysis failed.";

    const reply = data.reply || "";
    pushHistory("user", `[Screen] ${question}`);
    pushHistory("assistant", reply);
    return reply;

  } catch (err) {
    console.error("brain.js screen error:", err);
    return "I couldn't analyse your screen. Please check your connection.";
  }
};

// Used by "new chat" so a fresh conversation does not inherit context.
window.resetKairosHistory = function () {
  conversationHistory = [];
};

window.setKairosHistory = function (messages) {
  conversationHistory = (messages || []).map(item => ({
    role: item.role === 'kairos' ? 'assistant' : item.role,
    content: item.content || item.text || ''
  })).filter(item => ['user', 'assistant'].includes(item.role) && item.content)
    .slice(-MAX_HISTORY_TURNS);
};
