# ════════════════════════════════════════════════════════════
#  router.py — smart intent router  (A5, A6)
#
#  THE PROBLEM
#  -----------
#  Every question hit one model with max_tokens=300:
#      "what's 2+2"              -> llama-3.1-8b, 300 tokens
#      "explain SQL injection"   -> llama-3.1-8b, 300 tokens
#      "write me a React hook"   -> llama-3.1-8b, 300 tokens  (truncates
#                                   mid-function; users think it's broken)
#  And free and Pro users got the identical model, so the Pro tier gated
#  features (camera/screen/memory) but not intelligence — the core value
#  proposition of paying did not exist.
#
#  THE APPROACH
#  ------------
#  Classify intent, then pick a model chain by (intent x tier).
#
#  Keyword-first, deliberately. A regex/substring pass costs 0ms and 0
#  tokens and correctly routes the large majority of real traffic.
#  Spending an LLM call to decide which LLM to call would add latency to
#  every single message — exactly what we are trying to remove. An
#  optional cheap classifier handles genuinely ambiguous input, and is
#  off by default.
#
#  Everything here is driven by config (routing.intents in persona.json
#  / the config table), so intents, keywords, models, max_tokens and
#  temperature are all editable from the admin panel without a deploy.
# ════════════════════════════════════════════════════════════

import re

# Word-boundary matching so "code" does not fire on "encoded" and
# "api" does not fire on "capital".
_WORD_CACHE = {}


def _compile_keyword(keyword):
    kw = keyword.strip().lower()
    if not kw:
        return None
    if kw in _WORD_CACHE:
        return _WORD_CACHE[kw]
    # Multi-word phrases ("sql injection", "stack trace") match as a
    # phrase; single words get \b boundaries.
    pattern = re.compile(r"(?<!\w)" + re.escape(kw) + r"(?!\w)", re.IGNORECASE)
    _WORD_CACHE[kw] = pattern
    return pattern


def _score_intent(text, keywords):
    """Number of distinct keywords present. Distinct rather than total
    occurrences, so repeating one word does not outrank genuine signal."""
    hits = 0
    for kw in keywords or []:
        pattern = _compile_keyword(kw)
        if pattern and pattern.search(text):
            hits += 1
    return hits


def classify(text, routing_config, forced_intent=None):
    """Return (intent_name, intent_config).

    forced_intent is used for vision/screen, where the caller already
    knows the modality and no guessing is needed.
    """
    intents = (routing_config or {}).get("intents", {}) or {}
    default_name = (routing_config or {}).get("default_intent", "general")

    if forced_intent and forced_intent in intents:
        return forced_intent, intents[forced_intent]

    text = (text or "").strip()
    if not text:
        return default_name, intents.get(default_name, {})

    best_name, best_score = None, 0
    for name, cfg in intents.items():
        # Vision/screen are modality-driven, never keyword-matched.
        if name in ("vision", "screen"):
            continue
        score = _score_intent(text, cfg.get("keywords"))
        if score > best_score:
            best_name, best_score = name, score

    # Require at least one solid keyword hit. Without this, short
    # ambiguous messages would drift into whichever intent has the
    # longest keyword list.
    if best_name and best_score >= 1:
        return best_name, intents[best_name]

    return default_name, intents.get(default_name, {})


def resolve(text, routing_config, is_pro, forced_intent=None):
    """Full routing decision for one request.

    Returns a dict:
        intent              — chosen intent name
        label               — human label, for the UI badge
        chain               — ordered model list to try
        max_tokens          — per-route, not a global constant
        temperature         — per-route
        system_prompt_key   — which persona prompt to use
        tier                — "pro" | "free"
        downgraded          — True if a Pro-only route fell back to free
    """
    intent_name, cfg = classify(text, routing_config, forced_intent)
    tier = "pro" if is_pro else "free"

    chain = list(cfg.get(tier) or [])
    downgraded = False

    # If a tier has no chain configured, borrow the other one rather
    # than failing outright. Pro borrowing free is a graceful downgrade;
    # free borrowing pro should not happen (vision/screen are gated
    # upstream) but is handled so a config typo cannot 500 the endpoint.
    if not chain:
        fallback = list(cfg.get("free" if tier == "pro" else "pro") or [])
        if fallback:
            chain = fallback
            downgraded = tier == "pro"

    return {
        "intent":            intent_name,
        "label":             cfg.get("label", intent_name.title()),
        "chain":             chain,
        "max_tokens":        int(cfg.get("max_tokens", 400)),
        "temperature":       float(cfg.get("temperature", 0.7)),
        "system_prompt_key": cfg.get("system_prompt_key", "system_prompt"),
        "tier":              tier,
        "downgraded":        downgraded,
    }


def explain(text, routing_config, is_pro):
    """Debug helper — per-intent scores plus the decision. Wired to an
    admin-only endpoint so routing can be tuned without guesswork."""
    intents = (routing_config or {}).get("intents", {}) or {}
    scores = {
        name: _score_intent(text or "", cfg.get("keywords"))
        for name, cfg in intents.items()
        if name not in ("vision", "screen")
    }
    decision = resolve(text, routing_config, is_pro)
    return {"scores": scores, "decision": decision}
