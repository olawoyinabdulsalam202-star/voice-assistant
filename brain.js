// Section.

// Same-origin. Works on localhost, on a LAN IP, and in production with no code change. Override only if the API is on another host.
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

function fetchWithTimeout(url, options, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, Object.assign({}, options || {}, { signal: controller.signal }))
    .finally(() => clearTimeout(timer));
}

function readWithTimeout(reader, timeoutMs = 30000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("stream read timeout")), timeoutMs);
  });
  return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
}

function pushHistory(role, content) {
  conversationHistory.push({ role, content });
  if (conversationHistory.length > MAX_HISTORY_TURNS) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY_TURNS);
  }
}

// Session dropped or token expired — bounce to login rather than leaving the user talking to a dead app.
function handleAuthFailure() {
  try {
    localStorage.removeItem("kairos_token");
  } catch (e) { /* private mode */ }
  if (!window.location.pathname.includes("auth")) {
    window.location.href = "/login";
  }
}

// The context patches (Memory.js, Filereader.js, Multilang.js) wrap askKairos and prepend their blocks...
window.askKairos = async function (userMessage, opts) {
  const options   = opts || {};
  const augmented = options.augmented || userMessage;
  const raw       = options.raw || userMessage;

  try {
    const res = await fetchWithTimeout(BACKEND_URL, {
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

    // Surfaced so the UI can show which model answered — this is what makes the smart router visible instead of invisible.
    window.KAIROS_LAST_ROUTE = data.route || null;
    return reply;

  } catch (err) {
    console.error("brain.js error:", err);
    return "I'm having trouble reaching my neural core. Please check your connection.";
  }
};

// Section.
window.askKairosStream = async function (userMessage, onDelta, opts) {
  const options   = opts || {};
  const augmented = options.augmented || userMessage;
  const raw       = options.raw || userMessage;

  let res;
  try {
    res = await fetchWithTimeout(BACKEND_STREAM_URL, {
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
      const { done, value } = await readWithTimeout(reader);
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
          return window.askKairos(userMessage, opts);
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
    try { await reader.cancel(); } catch (e) { /* already closed */ }
    if (!full) return window.askKairos(userMessage, opts);
  }

  if (full) {
    pushHistory("user", raw);
    pushHistory("assistant", full);
  }
  window.KAIROS_LAST_ROUTE = route;
  return full || "I didn't get a reply. Please try again.";
};

// Section.
window.askKairosVision = async function (imageB64, question) {
  try {
    const res = await fetchWithTimeout(BACKEND_VISION_URL, {
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

// Section.
window.askKairosScreen = async function (imageB64, question) {
  try {
    const res = await fetchWithTimeout(BACKEND_SCREEN_URL, {
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
