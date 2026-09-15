# ════════════════════════════════════════════════════════════
#  providers.py — multi-provider AI layer  (A1, A2, A3, A4, A12)
#
#  THE PROBLEM THIS SOLVES
#  -----------------------
#  Every AI call used to be:
#      POST openrouter.ai  model="meta-llama/llama-3.1-8b-instruct"
#  with a Retry(total=3) wrapper. So:
#    • OpenRouter down            -> the whole product is down
#    • credit exhausted           -> the whole product is down
#    • model deprecated           -> silent 400 on every message
#    • one abuser rate-limits key -> everyone is down
#  And the retry hit the SAME dead model 3x with backoff, adding
#  ~5s of waiting before returning the error it was always going
#  to return. Retrying is not failover.
#
#  WHAT THIS DOES
#  --------------
#  • Providers are pluggable (Groq, OpenRouter, direct OpenAI/Anthropic).
#  • A model string like "groq/llama-3.1-8b-instant" is resolved to a
#    provider + upstream model id, so routing config stays readable.
#  • Chains are ordered: try model 1, on failure try model 2, etc.
#  • A circuit breaker benches a provider after N consecutive failures
#    so a dead provider costs ~0ms instead of a full timeout.
#  • Streaming is first-class — that is what turns a 30s wait into
#    roughly 1s to first word.
#  • Retries are 1 per model, because the fallback chain IS the retry.
# ════════════════════════════════════════════════════════════

import json
import os
import threading
import time

try:
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

import requests
from requests.adapters import HTTPAdapter

# ─────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
GROQ_API_KEY       = os.getenv("GROQ_API_KEY", "").strip()
OPENAI_API_KEY     = os.getenv("OPENAI_API_KEY", "").strip()
ANTHROPIC_API_KEY  = os.getenv("ANTHROPIC_API_KEY", "").strip()

OPENROUTER_REFERER = os.getenv("OPENROUTER_REFERER", "http://127.0.0.1:5000").strip()
OPENROUTER_TITLE   = os.getenv("OPENROUTER_TITLE", "KAIROS Voice Assistant").strip()

FAILURE_THRESHOLD  = int(os.getenv("PROVIDER_FAILURE_THRESHOLD", "5"))
COOLDOWN_SECONDS   = int(os.getenv("PROVIDER_COOLDOWN_SECONDS", "60"))
TIMEOUT_CHAT       = int(os.getenv("AI_TIMEOUT_CHAT", "30"))
TIMEOUT_VISION     = int(os.getenv("AI_TIMEOUT_VISION", "45"))
CONNECT_TIMEOUT    = int(os.getenv("AI_CONNECT_TIMEOUT", "5"))


def _timeout(value):
    """Fail over quickly on connection problems while allowing generation time."""
    return (min(CONNECT_TIMEOUT, value), value)


class ProviderError(Exception):
    """Upstream call failed. Carries whether trying another model may help."""

    def __init__(self, message, status=None, retryable=True):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class AllProvidersFailed(Exception):
    """Every model in the chain failed. Carries the per-model errors."""

    def __init__(self, attempts):
        self.attempts = attempts
        detail = "; ".join(f"{m}: {e}" for m, e in attempts) or "no models configured"
        super().__init__(f"All providers failed — {detail}")


# ─────────────────────────────────────────
#  CIRCUIT BREAKER
#
#  Per-process, which is correct here: each gunicorn worker learns
#  independently which providers are sick. Sharing this via Redis
#  would be marginally better but adds a hard dependency to the
#  hot path for little gain.
# ─────────────────────────────────────────
class _CircuitBreaker:
    def __init__(self, threshold, cooldown):
        self.threshold = threshold
        self.cooldown = cooldown
        self._fails = {}
        self._open_until = {}
        self._lock = threading.Lock()

    def is_open(self, key):
        with self._lock:
            until = self._open_until.get(key, 0)
            if until and time.time() < until:
                return True
            if until:
                # Cooldown elapsed — half-open: allow one probe through.
                self._open_until.pop(key, None)
                self._fails[key] = self.threshold - 1
            return False

    def record_success(self, key):
        with self._lock:
            self._fails.pop(key, None)
            self._open_until.pop(key, None)

    def record_failure(self, key):
        with self._lock:
            count = self._fails.get(key, 0) + 1
            self._fails[key] = count
            if count >= self.threshold:
                self._open_until[key] = time.time() + self.cooldown
                print(f"⚡ Circuit OPEN for '{key}' — benched {self.cooldown}s "
                      f"after {count} consecutive failures")

    def snapshot(self):
        with self._lock:
            now = time.time()
            return {
                key: {
                    "failures": self._fails.get(key, 0),
                    "open": bool(until and now < until),
                    "reopens_in": max(0, int(until - now)) if until else 0,
                }
                for key, until in {
                    **{k: self._open_until.get(k, 0) for k in self._fails},
                    **self._open_until,
                }.items()
            }


breaker = _CircuitBreaker(FAILURE_THRESHOLD, COOLDOWN_SECONDS)


def _session():
    """One pooled session per provider. max_retries=0 on purpose —
    the fallback chain is the retry strategy."""
    s = requests.Session()
    s.mount("https://", HTTPAdapter(max_retries=0, pool_maxsize=20))
    return s


# ─────────────────────────────────────────
#  PROVIDER BASE
# ─────────────────────────────────────────
class _OpenAICompatProvider:
    """Groq, OpenRouter and OpenAI all speak the same /chat/completions
    dialect, so one implementation covers all three."""

    name = "base"
    base_url = ""

    def __init__(self, api_key):
        self.api_key = api_key
        self.session = _session()

    @property
    def available(self):
        return bool(self.api_key)

    def _headers(self):
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _payload(self, model, messages, max_tokens, temperature, stream):
        return {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": stream,
        }

    # ── non-streaming ──
    def complete(self, model, messages, max_tokens, temperature, timeout):
        for attempt in range(2):
            try:
                r = self.session.post(
                    self.base_url,
                    headers=self._headers(),
                    json=self._payload(model, messages, max_tokens, temperature, False),
                    timeout=_timeout(timeout),
                )
                break
            except requests.exceptions.SSLError as e:
                if attempt == 0:
                    self.session.close()
                    self.session = _session()
                    continue
                raise ProviderError(f"network: SSLError: {str(e)[:180]}", retryable=True)
            except requests.exceptions.Timeout:
                raise ProviderError("timeout", retryable=True)
            except requests.exceptions.RequestException as e:
                raise ProviderError(
                    f"network: {type(e).__name__}: {str(e)[:180]}", retryable=True
                )

        if r.status_code != 200:
            # 400/404 usually mean a bad or retired model id. Still worth
            # falling through to the next model, but log loudly — this is
            # how a silently deprecated model gets noticed.
            snippet = (r.text or "")[:200]
            retryable = r.status_code not in (401, 403)
            if r.status_code in (400, 404):
                print(f"⚠️  {self.name}: model '{model}' rejected "
                      f"({r.status_code}) — {snippet}")
            raise ProviderError(f"http {r.status_code}: {snippet}",
                                status=r.status_code, retryable=retryable)

        try:
            data = r.json()
        except ValueError:
            raise ProviderError("invalid json from provider", retryable=True)

        choices = data.get("choices") or []
        if not choices:
            raise ProviderError(f"no choices: {str(data)[:200]}", retryable=True)

        text = (choices[0].get("message", {}).get("content") or "").strip()
        if not text:
            raise ProviderError("empty completion", retryable=True)

        usage = data.get("usage") or {}
        return {
            "text": text,
            "model": model,
            "provider": self.name,
            "usage": {
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
            },
        }

    # ── streaming ──
    def stream(self, model, messages, max_tokens, temperature, timeout):
        """Yield text deltas as they arrive. Raises ProviderError before
        the first delta if the upstream call fails, so the caller can
        still fall through to the next model. Once the first token is
        out we are committed to this model."""
        for attempt in range(2):
            try:
                r = self.session.post(
                    self.base_url,
                    headers=self._headers(),
                    json=self._payload(model, messages, max_tokens, temperature, True),
                    timeout=_timeout(timeout),
                    stream=True,
                )
                break
            except requests.exceptions.SSLError as e:
                if attempt == 0:
                    self.session.close()
                    self.session = _session()
                    continue
                raise ProviderError(f"network: SSLError: {str(e)[:180]}", retryable=True)
            except requests.exceptions.Timeout:
                raise ProviderError("timeout", retryable=True)
            except requests.exceptions.RequestException as e:
                raise ProviderError(
                    f"network: {type(e).__name__}: {str(e)[:180]}", retryable=True
                )

        if r.status_code != 200:
            snippet = ""
            try:
                snippet = (r.text or "")[:200]
            except Exception:
                pass
            r.close()
            retryable = r.status_code not in (401, 403)
            raise ProviderError(f"http {r.status_code}: {snippet}",
                                status=r.status_code, retryable=retryable)

        def _iter():
            try:
                for raw in r.iter_lines(decode_unicode=True):
                    if not raw or not raw.startswith("data:"):
                        continue
                    chunk = raw[5:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        parsed = json.loads(chunk)
                    except ValueError:
                        continue
                    for choice in parsed.get("choices") or []:
                        delta = (choice.get("delta") or {}).get("content")
                        if delta:
                            yield delta
            finally:
                r.close()

        return _iter()


class GroqProvider(_OpenAICompatProvider):
    """Free tier, and genuinely fast — sub-second first token. This is
    what makes the free plan viable and fixes the 30s reply problem.
    Note: rate-limited per-minute and per-day, so the 429 is expected
    and the chain must have somewhere to fall through to."""
    name = "groq"
    base_url = "https://api.groq.com/openai/v1/chat/completions"


class OpenRouterProvider(_OpenAICompatProvider):
    name = "openrouter"
    base_url = "https://openrouter.ai/api/v1/chat/completions"

    def _headers(self):
        h = super()._headers()
        h["HTTP-Referer"] = OPENROUTER_REFERER
        h["X-Title"] = OPENROUTER_TITLE
        return h


class OpenAIProvider(_OpenAICompatProvider):
    name = "openai"
    base_url = "https://api.openai.com/v1/chat/completions"


PROVIDERS = {
    "groq":       GroqProvider(GROQ_API_KEY),
    "openrouter": OpenRouterProvider(OPENROUTER_API_KEY),
    "openai":     OpenAIProvider(OPENAI_API_KEY),
}


# ─────────────────────────────────────────
#  MODEL RESOLUTION
#
#  "groq/llama-3.1-8b-instant"  -> groq,       llama-3.1-8b-instant
#  "openai/gpt-4o-mini"         -> openai if keyed, else via OpenRouter
#  "anthropic/claude-sonnet-4.5"-> openrouter, anthropic/claude-sonnet-4.5
#  "gpt-4o-mini"                -> openrouter, openai/gpt-4o-mini
#
#  That last case is a real bug fix: the old code sent the bare slug
#  "gpt-4o-mini" to OpenRouter, which expects a vendor prefix, so the
#  vision and screen endpoints may have been failing silently.
# ─────────────────────────────────────────
_DIRECT_PREFIXES = {"groq": "groq", "openai": "openai"}

_BARE_SLUG_VENDORS = {
    "gpt-": "openai",
    "o1-": "openai",
    "o3-": "openai",
    "claude-": "anthropic",
    "gemini-": "google",
    "llama-": "meta-llama",
}


def resolve_model(spec):
    """Return (provider_name, upstream_model_id)."""
    spec = (spec or "").strip()
    if not spec:
        raise ProviderError("empty model spec", retryable=False)

    # Groq retired/degraded this older general-chat model. Config is stored
    # in the database, so translate legacy saved routes at runtime as well as
    # updating the seed configuration.
    if spec == "groq/llama-3.1-8b-instant":
        spec = "groq/llama-3.3-70b-versatile"

    if "/" in spec:
        vendor, rest = spec.split("/", 1)
        vendor_l = vendor.lower()

        # Direct provider routing when we hold that provider's own key.
        if vendor_l in _DIRECT_PREFIXES:
            provider = _DIRECT_PREFIXES[vendor_l]
            if PROVIDERS[provider].available:
                return provider, rest
            # No direct key — fall back to OpenRouter with a valid slug.
            if vendor_l == "openai":
                return "openrouter", f"openai/{rest}"
            return "openrouter", spec

        # anthropic/, google/, meta-llama/, qwen/ ... go via OpenRouter,
        # unless a direct Anthropic key exists (handled by caller config).
        return "openrouter", spec

    # Bare slug — infer the vendor so OpenRouter accepts it.
    lowered = spec.lower()
    for prefix, vendor in _BARE_SLUG_VENDORS.items():
        if lowered.startswith(prefix):
            if vendor == "openai" and PROVIDERS["openai"].available:
                return "openai", spec
            return "openrouter", f"{vendor}/{spec}"

    return "openrouter", spec


def _circuit_key(provider_name, model_id):
    # Bench per provider+model: one retired model should not bench a
    # provider whose other models are healthy.
    return f"{provider_name}:{model_id}"


def _prepare(chain):
    """Resolve a chain into usable (provider, model, key) triples,
    dropping models whose provider has no API key."""
    prepared, skipped = [], []
    for spec in chain or []:
        try:
            provider_name, model_id = resolve_model(spec)
        except ProviderError:
            skipped.append((spec, "unresolvable"))
            continue
        provider = PROVIDERS.get(provider_name)
        if not provider or not provider.available:
            skipped.append((spec, f"{provider_name} has no API key"))
            continue
        prepared.append((provider, model_id, _circuit_key(provider_name, model_id)))
    return prepared, skipped


# ─────────────────────────────────────────
#  PUBLIC API
# ─────────────────────────────────────────
def complete(chain, messages, max_tokens=400, temperature=0.7, timeout=None):
    """Walk the chain until one model answers. Raises AllProvidersFailed."""
    timeout = timeout or TIMEOUT_CHAT
    prepared, attempts = _prepare(chain)

    for provider, model_id, key in prepared:
        if breaker.is_open(key):
            attempts.append((f"{provider.name}/{model_id}", "circuit open"))
            continue
        try:
            result = provider.complete(model_id, messages, max_tokens,
                                       temperature, timeout)
            breaker.record_success(key)
            return result
        except ProviderError as e:
            breaker.record_failure(key)
            attempts.append((f"{provider.name}/{model_id}", str(e)))
            if not e.retryable:
                # Auth failure — the next model on the same provider will
                # fail identically, but a different provider may work.
                continue

    raise AllProvidersFailed(attempts)


def stream(chain, messages, max_tokens=400, temperature=0.7, timeout=None):
    """Return (generator_of_text_deltas, meta). Falls through the chain
    only until the first successful connection — once tokens flow we are
    committed. Raises AllProvidersFailed if nothing connects."""
    timeout = timeout or TIMEOUT_CHAT
    prepared, attempts = _prepare(chain)

    for provider, model_id, key in prepared:
        if breaker.is_open(key):
            attempts.append((f"{provider.name}/{model_id}", "circuit open"))
            continue
        try:
            gen = provider.stream(model_id, messages, max_tokens,
                                  temperature, timeout)
            breaker.record_success(key)
            return gen, {"model": model_id, "provider": provider.name}
        except ProviderError as e:
            breaker.record_failure(key)
            attempts.append((f"{provider.name}/{model_id}", str(e)))
            continue

    raise AllProvidersFailed(attempts)


def health():
    """For /health — which providers are keyed, and circuit state."""
    return {
        "providers": {
            name: {"configured": p.available}
            for name, p in PROVIDERS.items()
        },
        "circuits": breaker.snapshot(),
    }
