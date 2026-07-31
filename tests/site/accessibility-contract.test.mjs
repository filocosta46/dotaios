import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

test("both page compositions keep semantic landmarks and a keyboard skip path", async () => {
  const [app, header, footer, pack] = await Promise.all([
    "website/src/App.jsx",
    "website/src/components/Header.jsx",
    "website/src/components/Footer.jsx",
    "website/src/components/ConsultantPack.jsx",
  ].map((file) => fs.readFile(path.join(repoRoot, file), "utf8")));

  assert.match(app, /className="skip-link"/);
  assert.match(app, /<main className="site-main">/);
  assert.match(header, /<header/);
  assert.match(footer, /<footer/);
  assert.match(pack, /<details/);
  assert.match(pack, /<summary/);
  assert.match(pack, /href="#proof"/);
  assert.doesNotMatch(pack, /type="button" disabled/);
});

test("the shared stylesheet preserves focus, touch, contrast, and motion accommodations", async () => {
  const css = await fs.readFile(path.join(repoRoot, "website/src/styles.css"), "utf8");

  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(css, /@media \(prefers-contrast: more\)/);
});
