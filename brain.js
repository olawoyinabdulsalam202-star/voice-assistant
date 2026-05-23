// ════════════════════════════════════════
//  brain.js  —  KAIROS AI ENGINE  v12
// ════════════════════════════════════════

const BASE_URL = "http://127.0.0.1:5000";

const BACKEND_URL = `${BASE_URL}/ask`;
const BACKEND_VISION_URL = `${BASE_URL}/vision`;
const BACKEND_SCREEN_URL = `${BASE_URL}/screen`;
let conversationHistory = [];

// ── TEXT CHAT ──
window.askKairos = async function (userMessage) {
  conversationHistory.push({ role: "user", content: userMessage });
  if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);

  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: userMessage,
        history: conversationHistory.slice(0, -1)
      })
    });

    if (!res.ok) {
      const err = await res.json();
      return err.error || "Something went wrong. Please try again.";
    }

    const data = await res.json();
    const reply = data.reply;
    conversationHistory.push({ role: "assistant", content: reply });
    return reply;

  } catch (err) {
    console.error("brain.js error:", err);
    return "I'm having trouble connecting to my neural core. Make sure backend.py is running.";
  }
};

// ── CAMERA VISION ──
window.askKairosVision = async function (imageB64, question) {
  try {
    const res = await fetch(BACKEND_VISION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageB64, question })
    });

    if (!res.ok) {
      const err = await res.json();
      return err.error || "Vision analysis failed.";
    }

    const data = await res.json();
    const reply = data.reply;
    conversationHistory.push({ role: "user", content: `[Camera]: ${question}` });
    conversationHistory.push({ role: "assistant", content: reply });
    return reply;

  } catch (err) {
    console.error("brain.js vision error:", err);
    return "I couldn't analyse the camera feed. Make sure backend.py is running.";
  }
};

// ── SCREEN SHARE ANALYSIS ──
window.askKairosScreen = async function (imageB64, question) {
  try {
    const res = await fetch(BACKEND_SCREEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageB64, question })
    });

    if (!res.ok) {
      const err = await res.json();
      return err.error || "Screen analysis failed.";
    }

    const data = await res.json();
    const reply = data.reply;
    conversationHistory.push({ role: "user", content: `[Screen]: ${question}` });
    conversationHistory.push({ role: "assistant", content: reply });
    return reply;

  } catch (err) {
    console.error("brain.js screen error:", err);
    return "I couldn't analyse your screen. Make sure backend.py is running.";
  }
};