import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const siteRoot = "https://dotaios.vercel.app/";
const homeLocaleUrls = {
  en: `${siteRoot}?lang=en`,
  it: `${siteRoot}?lang=it`
};
const packRoot = `${siteRoot}consultant-pack/`;
const packLocaleUrls = {
  en: `${packRoot}?lang=en`,
  it: `${packRoot}?lang=it`
};

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test("static metadata exposes reciprocal English, Italian, and default locale links", async () => {
  const html = await fs.readFile(path.join(repoRoot, "website", "index.html"), "utf8");

  assert.equal(countMatches(html, /<link rel="canonical"/g), 1);
  assert.ok(html.includes(`<link rel="canonical" href="${siteRoot}"`));
  assert.ok(html.includes(`<link rel="alternate" hreflang="en" href="${homeLocaleUrls.en}"`));
  assert.ok(html.includes(`<link rel="alternate" hreflang="it" href="${homeLocaleUrls.it}"`));
  assert.ok(html.includes(`<link rel="alternate" hreflang="x-default" href="${siteRoot}"`));
});

test("sitemap lists each locale URL with reciprocal xhtml alternates", async () => {
  const xml = await fs.readFile(path.join(repoRoot, "website", "public", "sitemap.xml"), "utf8");
  const urlBlocks = [...xml.matchAll(/<url>\s*([\s\S]*?)\s*<\/url>/g)].map((match) => match[1]);
  const expectedPages = [
    {root: siteRoot, locales: homeLocaleUrls},
    {root: packRoot, locales: packLocaleUrls},
  ];
  const expectedLocations = expectedPages.flatMap(({root, locales}) => [root, locales.en, locales.it]);

  assert.match(xml, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  assert.equal(urlBlocks.length, expectedLocations.length);

  for (const [index, block] of urlBlocks.entries()) {
    const page = expectedPages[Math.floor(index / 3)];
    const decodedBlock = block.replaceAll("&amp;", "&");
    assert.ok(decodedBlock.includes(`<loc>${expectedLocations[index]}</loc>`));
    assert.ok(decodedBlock.includes(`hreflang="en" href="${page.locales.en}"`));
    assert.ok(decodedBlock.includes(`hreflang="it" href="${page.locales.it}"`));
    assert.ok(decodedBlock.includes(`hreflang="x-default" href="${page.root}"`));
  }
});

test("the runtime metadata updater resolves canonicals from the active page", async () => {
  const app = await fs.readFile(path.join(repoRoot, "website/src/App.jsx"), "utf8");

  assert.match(app, /localeUrlsFor\(page\.id\)/);
  assert.match(app, /canonical\?\.setAttribute\('href', urls\[lang\] \|\| urls\.canonical\)/);
});
