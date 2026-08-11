import assert from "node:assert/strict";
import test from "node:test";

import { foldTerm, haystackHasInflectionOf } from "../../packages/core/src/search-inflections.mjs";
import { matchQuery, rankSearchHit } from "../../packages/core/src/search.mjs";

test("a question in one tense reaches a note written in another", () => {
  // The case this exists for: the note is filed, the question is rephrased,
  // and today the search returns nothing.
  assert.equal(matchQuery("Meeting with Racing Bulls about the chairs", "meetings").matched, true);
  assert.equal(matchQuery("Ho emesso la fattura per Fiocchi", "fatture").matched, true);
  assert.equal(matchQuery("Sto preparando il preventivo", "preventivi").matched, true);
  assert.equal(matchQuery("Consegna programmata con Michele", "programmare").matched, true);
});

test("an inflected hit is reported as its own kind, never as a literal one", () => {
  assert.equal(matchQuery("Meeting with Racing Bulls", "meetings").kind, "inflected");
  assert.equal(matchQuery("Meeting with Racing Bulls", "meeting").kind, "phrase");
});

test("an inflected hit always ranks below a literal one", () => {
  const corpus = null;
  const literal = rankSearchHit({ kind: "partial", matchedTerms: ["meeting"], corpus, ageMs: 0 });
  const folded = rankSearchHit({ kind: "inflected", matchedTerms: ["meeting"], corpus, ageMs: 0 });
  assert.ok(folded < literal, `inflected ${folded} must rank below partial ${literal}`);
  assert.ok(folded > 0, "an inflected hit must still be rankable");
});

test("folding never invents a match out of unrelated words", () => {
  assert.equal(matchQuery("The invoice is paid", "helicopter").matched, false);
  assert.equal(matchQuery("Consegna a Bologna", "fatture").matched, false);
  assert.equal(matchQuery("nothing to see", "meetings").matched, false);
});

test("short words are left alone, because folding them collides", () => {
  // "case" folded to "cas" would reach "caso", "casa", "cassa".
  assert.equal(foldTerm("case"), null);
  assert.equal(foldTerm("sono"), null);
  assert.equal(foldTerm("the"), null);
  assert.equal(matchQuery("La casa e pronta", "case").matched, false);
});

test("folding leaves non-words alone", () => {
  assert.equal(foldTerm("EPIPE-4712"), null);
  assert.equal(foldTerm("2026-08-11"), null);
  assert.equal(foldTerm(""), null);
});

test("a multi-word query only folds when every word is accounted for", () => {
  // One folded word plus one missing word is still a miss.
  assert.equal(matchQuery("Meeting with Racing Bulls", "meetings helicopter").matched, false);
  assert.equal(matchQuery("Meetings about invoices", "meeting invoice").matched, true);
});

test("the prefix test respects word boundaries", () => {
  assert.equal(haystackHasInflectionOf("subprogramme notes", "programmare"), false);
  assert.equal(haystackHasInflectionOf("programma di consegna", "programmare"), true);
});
