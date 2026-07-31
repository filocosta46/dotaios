import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { COPY } from "../../website/src/content.js";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

test("the copied setup promise matches the installer approval boundary", async () => {
  const install = await fs.readFile(path.join(repoRoot, "INSTALL.md"), "utf8");

  assert.match(COPY.installPrompt.en, /ask before running commands that change my files/i);
  assert.match(COPY.installPrompt.it, /chiedimi conferma prima di eseguire comandi che modificano i miei file/i);
  assert.match(install, /ask once for approval\s+to update them/i);
  assert.doesNotMatch(install, /Do not ask permission to write/i);
});
