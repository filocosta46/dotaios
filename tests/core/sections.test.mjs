import test from "node:test";
import assert from "node:assert/strict";
import { readBullet, readSection, replaceBullet, replaceSection } from "../../packages/core/src/sections.mjs";

test("readBullet extracts value after label", () => {
  const content = "## Basics\n\n- Name: Avery\n- Role: builder\n";
  assert.equal(readBullet(content, "Name"), "Avery");
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

test("readBullet returns empty string for an empty bullet", () => {
  const content = "## Basics\n\n- Name: \n- Role: \n\n## Background\n";
  assert.equal(readBullet(content, "Name"), "");
  assert.equal(readBullet(content, "Role"), "");
});

test("readBullet returns empty string for a whitespace-only bullet", () => {
  assert.equal(readBullet("- Name:   \t\n- Role: builder\n", "Name"), "");
});

test("readBullet stops at end of line when bullet is followed by a heading", () => {
  assert.equal(readBullet("- Role: \n## Background\n", "Role"), "");
  assert.equal(readBullet("- Role: \n\n## Background\n", "Role"), "");
});

test("readBullet reads a bullet at end of file without a trailing newline", () => {
  assert.equal(readBullet("## Basics\n\n- Name: Avery", "Name"), "Avery");
  assert.equal(readBullet("## Basics\n\n- Name:", "Name"), "");
});

test("replaceBullet fills an empty bullet without touching the next line", () => {
  const before = "## Basics\n\n- Name: \n- Role: \n\n## Background\n\nkeep\n";
  const after = replaceBullet(before, "Role", "consultant");
  assert.equal(after, "## Basics\n\n- Name: \n- Role: consultant\n\n## Background\n\nkeep\n");
});

test("replaceBullet fills a whitespace-only bullet with a single separator space", () => {
  assert.equal(replaceBullet("- Name:   \t\n", "Name", "Avery"), "- Name: Avery\n");
  assert.equal(replaceBullet("- Name:\n", "Name", "Avery"), "- Name: Avery\n");
});

test("replaceBullet preserves a heading that immediately follows an empty bullet", () => {
  assert.equal(replaceBullet("- Role: \n## Background\n", "Role", "builder"), "- Role: builder\n## Background\n");
  assert.equal(replaceBullet("- Role: \n\n## Background\n", "Role", "builder"), "- Role: builder\n\n## Background\n");
});

test("replaceBullet fills a bullet at end of file without a trailing newline", () => {
  assert.equal(replaceBullet("## Basics\n\n- Name:", "Name", "Avery"), "## Basics\n\n- Name: Avery");
});

test("replaceBullet leaves the rest of the document untouched for a non-empty bullet", () => {
  const before = "# Identity\n\n## Basics\n\n- Name: A\n- Role: B\n\n## Background\n\nsome background\n";
  const after = replaceBullet(before, "Role", "C");
  assert.equal(after, "# Identity\n\n## Basics\n\n- Name: A\n- Role: C\n\n## Background\n\nsome background\n");
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

test("replaceBullet writes a value containing $ patterns literally", () => {
  const before = "- Name: Avery\n- Role: old\n";
  assert.equal(replaceBullet(before, "Role", "R$&D lead"), "- Name: Avery\n- Role: R$&D lead\n");
  assert.equal(replaceBullet(before, "Role", "co$1st"), "- Name: Avery\n- Role: co$1st\n");
  assert.equal(replaceBullet(before, "Role", "a $` b $' c"), "- Name: Avery\n- Role: a $` b $' c\n");
});
