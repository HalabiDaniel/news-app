// ---------------------------------------------------------------------------
// What counts as a word worth learning.
//
// The old prompt said "highlight generously", which is how "KI", "Apple" and
// "DAX" ended up as vocabulary. Those are names and acronyms: knowing them
// teaches you nothing about German. What's actually wanted is everyday nouns and
// verbs (including separable ones) plus the genuinely hard words a real news
// text forces on you.
//
// The prompt in lib/openai.ts is the primary defence — this module is the net
// underneath it, because a model told "no proper nouns" will still occasionally
// produce one. It runs over both the footnotes shown to you and the words saved
// into the vocabulary table.
//
// The core trick is German capitalisation. Common nouns are capitalised, so
// "starts with a capital" tells us nothing on its own — but the prompt requires
// every noun to be given WITH its article ("die Auswirkung"). That turns the
// article into a signal: a bare capitalised token with no article is almost
// always a name. And it's a rule worth enforcing anyway, since you want to learn
// the gender along with the noun.
// ---------------------------------------------------------------------------

// Articles a noun entry may legitimately start with. Plural/case forms are
// included because the model sometimes gives a phrase in an oblique case.
const ARTICLE_RE = /^(?:der|die|das|den|dem|des)\s+/i;

// Common-noun endings. A capitalised word with one of these is a real noun even
// if the model forgot its article, so we keep it rather than lose a good word.
// (No name ends in -ung or -keit; this costs us almost no precision.)
const NOUN_SUFFIX_RE =
  /(?:ung|heit|keit|schaft|tion|sion|ität|ismus|anz|enz|nis|tum|ling|chen|lein|ei|ung?en)$/i;

// Institutions, places and other proper nouns that DO take an article and would
// otherwise slip through the checks above. Not exhaustive by design — the prompt
// does the heavy lifting; this catches the handful that recur in German news.
const PROPER_NOUN_BLOCKLIST = new Set(
  [
    'bundestag', 'bundesrat', 'bundeswehr', 'bundesbank', 'bundesliga', 'bundesregierung',
    'europäische union', 'vereinten nationen', 'nato', 'uno', 'weltbank',
    'deutschland', 'österreich', 'schweiz', 'europa', 'berlin', 'bayern', 'brüssel',
    'ukraine', 'russland', 'china', 'usa', 'frankreich', 'israel', 'gaza',
    'bundeskanzler', 'bundespräsident',
    'dax', 'ezb', 'ki', 'eu', 'us', 'uk', 'bip', 'gdp',
    'apple', 'google', 'microsoft', 'amazon', 'meta', 'tesla', 'openai', 'nvidia', 'samsung',
    'sony', 'nintendo', 'microsoft xbox', 'playstation', 'xbox', 'steam', 'twitch',
    'cdu', 'csu', 'spd', 'fdp', 'afd', 'linke', 'grünen',
  ].map((s) => s.toLowerCase()),
);

export type RejectReason =
  | 'empty'
  | 'acronym'
  | 'proper-noun'
  | 'bare-capitalised'
  | 'too-long'
  | 'english';

export interface VocabVerdict {
  ok: boolean;
  reason?: RejectReason;
}

/** The noun stripped of its leading article, for the checks below. */
function stripArticle(word: string): { core: string; hadArticle: boolean } {
  const trimmed = word.trim();
  const stripped = trimmed.replace(ARTICLE_RE, '');
  return { core: stripped.trim(), hadArticle: stripped !== trimmed };
}

// "KI", "DAX", "EU", "BIP" — no lowercase letter anywhere in the core.
// Guarded on length so a genuinely shouted single word isn't misread, and so a
// multi-word phrase in caps still trips it.
function isAcronym(core: string): boolean {
  const letters = core.replace(/[^\p{L}]/gu, '');
  if (!letters) return false;
  return letters === letters.toUpperCase() && letters.length <= 6;
}

// An English word or phrase that snuck into a German glossary. Cheap heuristic:
// the explanation is required to be German, but the *word* occasionally comes
// back as English when the source used an anglicism as a proper noun.
const ENGLISH_HINT_RE = /^(?:the|a|an|to)\s/i;

/**
 * Should this word be highlighted and saved as vocabulary?
 *
 * Accepts: nouns given with their article ("die Auswirkung"), nouns with an
 * unambiguous common-noun ending, and anything starting lowercase — which in
 * German means a verb, adjective, adverb, or a phrase like "im Hinblick auf".
 *
 * Rejects: acronyms, blocklisted names, and bare capitalised tokens with neither
 * an article nor a noun ending (i.e. almost certainly a name).
 */
export function checkVocabWord(word: unknown): VocabVerdict {
  if (typeof word !== 'string') return { ok: false, reason: 'empty' };
  const trimmed = word.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  // A footnote should be a word or short phrase, not a clause.
  if (trimmed.length > 60 || trimmed.split(/\s+/).length > 5) {
    return { ok: false, reason: 'too-long' };
  }
  if (ENGLISH_HINT_RE.test(trimmed)) return { ok: false, reason: 'english' };

  const { core, hadArticle } = stripArticle(trimmed);
  if (!core) return { ok: false, reason: 'empty' };

  if (isAcronym(core)) return { ok: false, reason: 'acronym' };
  if (PROPER_NOUN_BLOCKLIST.has(core.toLowerCase())) return { ok: false, reason: 'proper-noun' };

  const firstLetter = core.match(/\p{L}/u)?.[0] ?? '';
  const startsUpper = firstLetter !== '' && firstLetter === firstLetter.toUpperCase();

  // Lowercase start → verb / adjective / adverb / phrase. Always fine.
  if (!startsUpper) return { ok: true };
  // Capitalised WITH an article → a noun taught the way you want it. Fine.
  if (hadArticle) return { ok: true };
  // Capitalised, no article, but an unmistakable common-noun ending → keep it.
  if (NOUN_SUFFIX_RE.test(core.split(/\s+/)[0])) return { ok: true };

  return { ok: false, reason: 'bare-capitalised' };
}

export function isLearnableVocab(word: unknown): boolean {
  return checkVocabWord(word).ok;
}
