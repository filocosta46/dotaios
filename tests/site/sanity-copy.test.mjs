import test from "node:test";
import assert from "node:assert/strict";
import { CURRENT_COPY_RELEASE, dictionary } from "../../website/src/content.js";
import { buildRemoteDictionary } from "../../website/src/sanity.js";

const hostileLanguage = {
  folder: {
    views: {
      context: {
        lead: "Remote folder lead"
      }
    }
  },
  footer: {
    tagline: "Remote footer"
  },
  consultantPack: {
    price: "€1",
    readiness: { label: "Available now" },
    evidence: { state: "Approved" },
    action: { label: "Buy now", href: "https://checkout.example" }
  },
  hero: { titleLine1: "Hostile hero" },
  nav: { cta: "Buy" },
  price: "€1",
  readiness: { label: "Available now" },
  evidence: { state: "Approved" },
  action: { label: "Buy now", href: "https://checkout.example" }
};

test("matching Sanity copy release hydrates only folder and footer copy", () => {
  const hydrated = buildRemoteDictionary(dictionary, {
    copyRelease: CURRENT_COPY_RELEASE,
    i18n: {
      en: hostileLanguage,
      it: hostileLanguage
    }
  });

  for (const lang of ["en", "it"]) {
    assert.equal(hydrated[lang].folder.views.context.lead, "Remote folder lead");
    assert.equal(hydrated[lang].footer.tagline, "Remote footer");
    assert.deepEqual(hydrated[lang].consultantPack, dictionary[lang].consultantPack);
    assert.deepEqual(hydrated[lang].hero, dictionary[lang].hero);
    assert.deepEqual(hydrated[lang].nav, dictionary[lang].nav);
    assert.equal(Object.hasOwn(hydrated[lang], "price"), false);
    assert.equal(Object.hasOwn(hydrated[lang], "readiness"), false);
    assert.equal(Object.hasOwn(hydrated[lang], "evidence"), false);
    assert.equal(Object.hasOwn(hydrated[lang], "action"), false);
  }
});

test("stale Sanity copy is rejected outside preview", () => {
  assert.equal(buildRemoteDictionary(dictionary, {
    copyRelease: "stale-release",
    i18n: { en: hostileLanguage, it: hostileLanguage }
  }), null);
});

test("preview retains its release bypass but still enforces the editorial allowlist", () => {
  const hydrated = buildRemoteDictionary(dictionary, {
    copyRelease: "stale-release",
    i18n: { en: hostileLanguage, it: hostileLanguage }
  }, { preview: true });

  assert.equal(hydrated.en.footer.tagline, "Remote footer");
  assert.deepEqual(hydrated.en.consultantPack, dictionary.en.consultantPack);
});

test("legacy Sanity fields hydrate only footer copy", () => {
  const hydrated = buildRemoteDictionary(dictionary, {
    copyRelease: CURRENT_COPY_RELEASE,
    footerTagline: { en: "Legacy EN", it: "Legacy IT" },
    footerDocs: { en: "Documentation", it: "Documentazione" },
    explorerTitle: { en: "Obsolete", it: "Obsoleto" },
    explorerDesc: { en: "Obsolete", it: "Obsoleto" }
  });

  assert.equal(hydrated.en.footer.tagline, "Legacy EN");
  assert.equal(hydrated.it.footer.docs, "Documentazione");
  assert.deepEqual(hydrated.en.folder, dictionary.en.folder);
  assert.deepEqual(hydrated.it.folder, dictionary.it.folder);
});
