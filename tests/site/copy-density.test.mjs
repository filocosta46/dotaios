import assert from "node:assert/strict";
import test from "node:test";
import {dictionary} from "../../website/src/content.js";

function words(value) {
  return String(value).trim().split(/\s+/).filter(Boolean).length;
}

function collectVisibleCopy(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectVisibleCopy(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectVisibleCopy(item, output));
  return output;
}

test("English page copy stays sparse and Italian keeps comparable density", () => {
  const enHome = words(collectVisibleCopy(dictionary.en.home).join(" "));
  const visiblePackCopy = (copy) => ({
    hero: copy.hero,
    price: copy.price,
    ownership: copy.ownership,
    optionalUpdates: copy.optionalUpdates,
    outcomes: copy.outcomes,
    proof: copy.proof,
    included: copy.included,
    install: copy.install,
    specification: copy.specification,
    evidence: copy.evidence,
    readiness: {label: copy.readiness.label, detail: copy.readiness.detail},
    action: copy.action,
    freeAction: copy.freeAction,
  });
  const enPack = words(collectVisibleCopy(visiblePackCopy(dictionary.en.consultantPack)).join(" "));
  const itHome = words(collectVisibleCopy(dictionary.it.home).join(" "));
  const itPack = words(collectVisibleCopy(visiblePackCopy(dictionary.it.consultantPack)).join(" "));

  assert.ok(enHome <= 150, `English homepage has ${enHome} words`);
  assert.ok(enPack <= 220, `English Pack page has ${enPack} words`);
  assert.ok(enHome + enPack <= 350, `English public path has ${enHome + enPack} words`);
  assert.ok(itHome + itPack <= 390, `Italian public path has ${itHome + itPack} words`);
});

test("headlines and supporting copy obey the sparse copy contract", () => {
  for (const [lang, copy] of Object.entries(dictionary)) {
    const headings = [
      copy.home.hero.title,
      copy.home.foundation.title,
      copy.home.pack.title,
      copy.consultantPack.hero.title,
      copy.consultantPack.proof.title,
      copy.consultantPack.included.title,
      copy.consultantPack.install.title,
    ];
    const paragraphs = [
      copy.home.hero.intro,
      copy.home.foundation.intro,
      copy.home.pack.intro,
      copy.consultantPack.hero.intro,
      copy.consultantPack.proof.intro,
      copy.consultantPack.install.intro,
    ];

    assert.ok(words(copy.home.hero.intro) <= 20, `${lang} home hero support is too long`);
    assert.ok(words(copy.consultantPack.hero.intro) <= 20, `${lang} Pack hero support is too long`);
    headings.forEach((heading) => assert.ok(words(heading) <= 8, `${lang} heading is too long: ${heading}`));
    paragraphs.forEach((paragraph) => assert.ok(words(paragraph) <= 25, `${lang} paragraph is too long: ${paragraph}`));
    assert.doesNotMatch(collectVisibleCopy(copy).join(" "), /[\u2013\u2014]/);
  }
});
