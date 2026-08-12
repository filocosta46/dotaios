// Inflection folding for search, so a question asked in one tense finds a note
// written in another: "what meetings did I have" has to reach "meeting with
// Racing Bulls", and "fatture emesse" has to reach "fattura emessa".
//
// This is deliberately not a linguistics project. It is suffix stripping for
// the regular English and Italian endings that show up in a notes folder, with
// three rules that keep it from doing damage:
//
//   1. It only ever runs after an exact match has already failed, and it
//      returns the lowest-ranked match kind, so precision is untouched.
//   2. It folds the query, never the document. The stem becomes a word-prefix
//      test, which costs one regex over text we were scanning anyway -- no
//      tokenising, no per-line allocation, no index.
//   3. Short words are left alone. Folding "case" or "sono" produces collisions
//      that are worse than the miss they would fix.
//
// Irregular forms (went/gone, fatto/fare) are out of scope: covering them needs
// a dictionary, which is a dependency, which the project does not take.

const MIN_TERM_LENGTH = 5;
const MIN_STEM_LENGTH = 4;

// Grouped by language for reading, then sorted by length so the longest ending
// always wins: -azioni has to beat -i, -arono has to beat -ando. Sorting here
// rather than by hand means a suffix added in the wrong place cannot quietly
// change what every other one matches.
const SUFFIXES = [
  // Italian
  "azioni", "azione", "amento", "amenti",
  "erebbe", "eranno", "eremo",
  "arono", "erono", "irono",
  "endo", "ando", "iamo", "iate",
  "arsi", "ersi", "irsi",
  "ata", "ate", "ati", "ato",
  "uta", "ute", "uti", "uto",
  "ita", "ite", "iti", "ito",
  "are", "ere", "ire",
  // English
  "ization", "isation", "ations", "ation", "ings", "ing", "edly", "ed", "es", "s",
  // Shared plural and gender endings, the most destructive and so the last resort
  "i", "e", "o", "a"
].sort((left, right) => right.length - left.length);

/**
 * Fold one token to a comparable stem, or return null when folding it would do
 * more harm than good.
 */
export function foldTerm(term) {
  const token = String(term || "").toLowerCase();
  if (token.length < MIN_TERM_LENGTH) return null;
  if (!/^[\p{Letter}]+$/u.test(token)) return null;

  for (const suffix of SUFFIXES) {
    if (!token.endsWith(suffix)) continue;
    const stem = token.slice(0, -suffix.length);
    if (stem.length < MIN_STEM_LENGTH) continue;
    return collapseDoubledEnding(stem);
  }
  return null;
}

// "running" -> "runn" -> "run". Italian doubles too ("emessa" -> "emess"), and
// collapsing there is harmless because the fold is a prefix test either way.
function collapseDoubledEnding(stem) {
  if (stem.length > MIN_STEM_LENGTH && stem.at(-1) === stem.at(-2)) return stem.slice(0, -1);
  return stem;
}

/**
 * True when `haystack` contains a word that begins with the folded form of
 * `term`. The haystack is expected to be lowercase already.
 */
export function haystackHasInflectionOf(haystack, term) {
  const stem = foldTerm(term);
  if (!stem) return false;
  return wordPrefixPattern(stem).test(haystack);
}

// Patterns are reused across every line of every file in a search, so they are
// built once per stem rather than once per call.
const patternCache = new Map();
const PATTERN_CACHE_LIMIT = 512;

function wordPrefixPattern(stem) {
  const cached = patternCache.get(stem);
  if (cached) return cached;
  const pattern = new RegExp(`(?<![\\p{Letter}\\p{Number}])${escapeRegExp(stem)}[\\p{Letter}]*`, "u");
  if (patternCache.size >= PATTERN_CACHE_LIMIT) patternCache.clear();
  patternCache.set(stem, pattern);
  return pattern;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
