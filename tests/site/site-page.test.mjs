import assert from "node:assert/strict";
import test from "node:test";
import {
  PAGE_IDS,
  localeUrlsFor,
  resolveSitePage,
  siteHref,
} from "../../website/src/site-page.js";

test("the site resolves exactly two public page compositions", () => {
  assert.deepEqual(PAGE_IDS, ["home", "consultantPack"]);
  assert.equal(resolveSitePage("/").id, "home");
  assert.equal(resolveSitePage("/consultant-pack").id, "consultantPack");
  assert.equal(resolveSitePage("/consultant-pack/").id, "consultantPack");
  assert.equal(resolveSitePage("/unknown").id, "home");
});

test("site links and locale canonicals preserve the page boundary", () => {
  assert.equal(siteHref("home"), "/");
  assert.equal(siteHref("consultantPack"), "/consultant-pack/");
  assert.equal(siteHref("home", "it"), "/?lang=it");
  assert.equal(siteHref("consultantPack", "en"), "/consultant-pack/?lang=en");
  assert.deepEqual(localeUrlsFor("consultantPack"), {
    canonical: "https://dotaios.vercel.app/consultant-pack/",
    en: "https://dotaios.vercel.app/consultant-pack/?lang=en",
    it: "https://dotaios.vercel.app/consultant-pack/?lang=it",
  });
});
