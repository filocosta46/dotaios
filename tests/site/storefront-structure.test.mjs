import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

test("the Consultant Pack page is a separate commerce surface without Finder chrome", async () => {
  const source = await fs.readFile(path.join(repoRoot, "website/src/components/ConsultantPack.jsx"), "utf8");

  assert.match(source, /export default function ConsultantPackPage/);
  assert.doesNotMatch(source, /Finder|MacWindow|folder-preview|finder-/i);
  assert.match(source, /<h1/);
  assert.match(source, /<details/);
  assert.match(source, /PUBLIC_OFFER/);
  assert.match(source, /href="#proof"/);
  assert.doesNotMatch(source, /type="button" disabled/);
});

test("the app keeps the Finder artifact on the homepage only", async () => {
  const app = await fs.readFile(path.join(repoRoot, "website/src/App.jsx"), "utf8");
  const foundation = await fs.readFile(path.join(repoRoot, "website/src/components/Foundation.jsx"), "utf8");

  assert.match(app, /page\.id === 'consultantPack'/);
  assert.match(foundation, /FinderPreview/);
});
