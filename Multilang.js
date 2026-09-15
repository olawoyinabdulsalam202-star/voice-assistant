// ════════════════════════════════════════
//  multilang.js  —  KAIROS MULTI-LANGUAGE
//  v1
//
//  AUTO-DETECTS the language of every user
//  message and tells the backend to reply in
//  the same language.
//
//  HOW IT WORKS:
//  1. Detects language client-side (fast,
//     no API call) using character patterns
//     and common word lists.
//  2. Injects a short instruction into the
//     system context sent to the backend.
//  3. Kairos replies in the detected language.
//  4. Falls back to English if uncertain.
//
//  SUPPORTED (client detect + auto-reply):
//  Arabic, French, Spanish, German,
//  Portuguese, Yoruba, Hausa, Igbo,
//  Swahili, Chinese, Japanese, Korean,
//  Russian, Italian, Dutch, Turkish,
//  Hindi, Bengali, Polish + more via AI
//
//  NO CONFIG NEEDED — just include this
//  script before ai.js in your HTML.
// ════════════════════════════════════════

(function () {

  // ── LANGUAGE DETECTION RULES ──
  // Each rule: { name, script?, words?, test? }
  const LANG_RULES = [
    // Script-based (reliable, no word list needed)
    { code: 'ar', name: 'Arabic',     test: t => /[\u0600-\u06FF]/.test(t) },
    // CJK: test the scripts EXCLUSIVE to one language before shared Han. Japanese
    // kana (U+3040..U+30FF) is used only by Japanese and Korean Hangul only by
    // Korean, while Han / kanji (U+4E00..U+9FFF) is shared by Chinese AND Japanese.
    // Testing Chinese first mis-flagged any kanji-bearing Japanese text as Chinese
    // (the reported bug), so Japanese and Korean are checked first and Chinese
    // (Han with no kana / Hangul present) is the remaining case.
    { code: 'ja', name: 'Japanese',   test: t => /[\u3040-\u30FF]/.test(t) },
    { code: 'ko', name: 'Korean',     test: t => /[\uAC00-\uD7AF\u1100-\u11FF]/.test(t) },
    { code: 'zh', name: 'Chinese',    test: t => /[\u4E00-\u9FFF]/.test(t) },
    { code: 'ru', name: 'Russian',    test: t => /[\u0400-\u04FF]/.test(t) },
    { code: 'hi', name: 'Hindi',      test: t => /[\u0900-\u097F]/.test(t) },
    { code: 'bn', name: 'Bengali',    test: t => /[\u0980-\u09FF]/.test(t) },

    // Latin-script languages — word pattern based
    {
      code: 'fr', name: 'French',
      words: ['je','tu','il','elle','nous','vous','ils','est','les','des','du','une','pour','dans','avec','sur','qui','que','pas','mais','tout','comme','bien','plus','très','aussi','avoir','être','faire'],
    },
    {
      code: 'es', name: 'Spanish',
      words: ['yo','tú','él','ella','nosotros','ellos','qué','cómo','dónde','cuándo','porque','pero','para','con','por','una','del','hay','está','son','tiene','como','más','también','muy','todo','bien','puede'],
    },
    {
      code: 'de', name: 'German',
      words: ['ich','du','er','sie','wir','ihr','ist','bin','hat','und','die','der','das','ein','eine','nicht','auch','mit','für','von','auf','an','sich','bei','nach','werden','haben','sein','können'],
    },
    {
      code: 'pt', name: 'Portuguese',
      words: ['eu','você','ele','ela','nós','são','está','para','com','que','uma','não','por','mas','como','mais','muito','bem','também','porque','quando','onde','todo','pode','fazer','ter'],
    },
    {
      code: 'it', name: 'Italian',
      words: ['io','tu','lui','lei','noi','voi','loro','sono','è','una','del','non','per','con','che','più','come','anche','però','molto','bene','tutto','fare','avere','essere','può','questo','questa'],
    },
    {
      code: 'nl', name: 'Dutch',
      words: ['ik','jij','hij','zij','wij','jullie','het','een','niet','voor','met','zijn','van','op','aan','dit','dat','maar','ook','nog','wel','kan','hebben','worden','als','door'],
    },
    {
      code: 'tr', name: 'Turkish',
      words: ['ben','sen','o','biz','siz','onlar','bir','bu','ve','ile','için','olan','var','ne','nasıl','nerede','evet','hayır','çok','çok','daha','iyi','ama','gibi','kadar','olur'],
    },
    {
      code: 'pl', name: 'Polish',
      words: ['ja','ty','on','ona','my','wy','oni','jest','są','nie','tak','co','jak','gdzie','czy','ale','dla','przy','przez','jestem','być','mieć','móc','tego','tej'],
    },
    // African languages
    {
      code: 'yo', name: 'Yoruba',
      words: ['mo','o','a','wọn','ni','ti','fun','jẹ','ati','naa','sọ','wa','lọ','bi','kii','bẹẹ','rẹ','mi','wọ','ṣe','kan','yoo','ibo','bawo'],
    },
    {
      code: 'ha', name: 'Hausa',
      words: ['ni','kai','ita','mu','ku','su','da','na','ta','ba','ya','ce','sai','ko','don','mai','cikin','kuma','amma','wanda','daga','akan','tare','yana','tana','muna'],
    },
    {
      code: 'ig', name: 'Igbo',
      words: ['m','i','ya','anyị','unu','ha','na','nke','ọ','bụ','dị','maka','ma','ọ','ka','n\'oge','nwere','enwe','were','mere','gwara'],
    },
    {
      code: 'sw', name: 'Swahili',
      words: ['mimi','wewe','yeye','sisi','ninyi','wao','ni','na','ya','wa','kwa','hii','hiyo','pia','bali','lakini','kwamba','zaidi','sana','vizuri','ndiyo','hapana','kabla','baada'],
    },
    {
      code: 'pid', name: 'Nigerian Pidgin',
      words: ['i','e','dem','una','wetin','wahala','dey','abi','sabi','nah','wey','no','make','come','go','dat','dis','na','oga','bro','abeg','sha','sef'],
    },
  ];

  // ── DETECTION ──
  function detectLanguage(text) {
    if (!text || text.trim().length < 3) return null;
    const clean = text.trim();
    const lower = clean.toLowerCase();

    // 1. Script-based rules first (most reliable — no false positives possible)
    for (const rule of LANG_RULES) {
      if (rule.test && rule.test(clean)) {
        return { code: rule.code, name: rule.name };
      }
    }

    // 2. Word-based — count matches.
    // Tokens of length < 3 are excluded: single/double-letter "words" in the
    // African-language lists (e.g. Igbo 'i', 'm', 'ka', 'na') collide with
    // extremely common English tokens ("I", "a", "am", "is", "in"...) and
    // cause false-positive language switches on plain English sentences.
    const tokens = lower.split(/\s+/).filter(t => t.length >= 3);

    // Too few substantial tokens to make a confident call — assume English.
    if (tokens.length < 4) return null;

    let bestScore = 0;
    let bestHits  = 0;
    let bestLang  = null;

    for (const rule of LANG_RULES) {
      if (!rule.words) continue;
      const ruleWords = rule.words.filter(w => w.length >= 3);
      const hits = tokens.filter(t => ruleWords.includes(t)).length;
      const score = hits / tokens.length;
      // Require BOTH a meaningful hit count and a high match ratio —
      // a single coincidental match should never be enough to switch languages.
      if (hits >= 3 && score > bestScore && score >= 0.35) {
        bestScore = score;
        bestHits  = hits;
        bestLang  = { code: rule.code, name: rule.name };
      }
    }

    return bestLang; // null means English (default)
  }

  // ── INSTRUCTION INJECTION ──
  // Returns a short language instruction to prepend
  // to the system context or user message
  function buildLangInstruction(langCode, langName) {
    if (!langCode || langCode === 'en') return '';
    return `[LANGUAGE INSTRUCTION: The user is writing in ${langName}. You MUST reply entirely in ${langName}. Do not switch to English unless explicitly asked.]`;
  }

  // ════════════════════════════════════════
  //  PUBLIC API
  // ════════════════════════════════════════

  // detectLanguage(text) → { code, name } | null
  // buildLangInstruction(code, name) → string
  // getInstruction(text) → string (combines both)

  function getInstruction(text) {
    const lang = detectLanguage(text);
    if (!lang) {
      return '[LANGUAGE INSTRUCTION: Reply in English.]';
    }
    return buildLangInstruction(lang.code, lang.name);
  }

  window.kairosLang = { detectLanguage, getInstruction };

  // ════════════════════════════════════════
  //  AUTO-PATCH askKairos
  //
  //  Wraps window.askKairos (defined in
  //  brain.js or ai.js) so every call
  //  automatically gets the language hint.
  //
  //  This runs after DOMContentLoaded so
  //  brain.js / ai.js are already loaded.
  // ════════════════════════════════════════
  //  A7 FIX: this used to call original(augmented) — collapsing the raw
  //  message into the augmented one, so brain.js stored the language
  //  header in history and re-sent it every turn. Now raw and augmented
  //  travel separately: the model sees the instruction, history keeps
  //  the clean text. Both askKairos and askKairosStream are wrapped.
  function wrap(fnName) {
    const original = window[fnName];
    if (!original || original._langPatched) return false;

    if (fnName === 'askKairosStream') {
      window[fnName] = async function (userMessage, onDelta, opts) {
        const options = opts || {};
        const raw     = options.raw || userMessage;
        const base    = options.augmented || userMessage;
        const instr   = window.kairosLang.getInstruction(raw);
        return original(userMessage, onDelta, {
          ...options,
          raw,
          augmented: instr ? `${instr}\n\n${base}` : base,
        });
      };
    } else {
      window[fnName] = async function (userMessage, opts) {
        const options = opts || {};
        const raw     = options.raw || userMessage;
        const base    = options.augmented || userMessage;
        const instr   = window.kairosLang.getInstruction(raw);
        return original(userMessage, {
          ...options,
          raw,
          augmented: instr ? `${instr}\n\n${base}` : base,
        });
      };
    }

    window[fnName]._langPatched = true;
    return true;
  }

  function patchAskKairos() {
    const done = wrap('askKairos');
    wrap('askKairosStream');
    // retry in case of a load-order race with brain.js
    if (!done && !(window.askKairos && window.askKairos._langPatched)) {
      setTimeout(patchAskKairos, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchAskKairos);
  } else {
    patchAskKairos();
  }

})();