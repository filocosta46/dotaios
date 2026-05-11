import test from "node:test";
import assert from "node:assert/strict";
import { readBullet, readSection, replaceBullet, replaceSection } from "../../packages/core/src/sections.mjs";

test("readBullet extracts value after label", () => {
  const content = "## Basics\n\n- Name: Filippo\n- Role: builder\n";
  assert.equal(readBullet(content, "Name"), "Filippo");
  assert.equal(readBullet(content, "Role"), "builder");
});

test("readBullet is case-insensitive", () => {
  assert.equal(readBullet("- name: Foo\n", "Name"), "Foo");
});

test("readBullet returns empty string when label missing", () => {
  assert.equal(readBullet("- Other: x\n", "Name"), "");
});

test("replaceBullet updates value in place", () => {
  const before = "## Basics\n\n- Name: A\n- Role: B\n\n## More\n";
  const after = replaceBullet(before, "Role", "C");
  assert.equal(after, "## Basics\n\n- Name: A\n- Role: C\n\n## More\n");
});

test("replaceBullet returns null when bullet missing", () => {
  assert.equal(replaceBullet("- Name: A\n", "Role", "B"), null);
});

test("readSection returns body between heading and next ##", () => {
  const content = "# Title\n\n## A\n\nfoo\nbar\n\n## B\n\nbaz\n";
  assert.equal(readSection(content, "A"), "foo\nbar");
  assert.equal(readSection(content, "B"), "baz");
});

test("readSection returns empty when heading missing", () => {
  assert.equal(readSection("## Other\n\nx\n", "Missing"), "");
});

test("replaceSection swaps body while preserving structure", () => {
  const before = "# Title\n\n## Work\n\nold body\n\n## Next\n\nkeep\n";
  const after = replaceSection(before, "Work", "new body line 1\nnew body line 2");
  assert.match(after, /## Work\n\nnew body line 1\nnew body line 2\n\n## Next/);
  assert.ok(after.endsWith("keep\n"));
});

test("replaceSection handles end-of-file heading", () => {
  const before = "## Only\n\nold\n";
  const after = replaceSection(before, "Only", "new");
  assert.equal(after, "## Only\n\nnew\n");
});

test("replaceSection returns null when heading missing", () => {
  assert.equal(replaceSection("## A\nfoo\n", "B", "x"), null);
});
