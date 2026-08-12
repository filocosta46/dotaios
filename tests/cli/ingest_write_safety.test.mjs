import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { placeMarkdown } from "../../packages/cli/src/ingest/placement.mjs";

// Every other durable write in the product goes through writeFileSafe, which
// refuses a symlinked destination. Ingest was the one writer that did not: a
// bare fs.writeFile follows a leaf symlink, so a link left in the vault
// redirected the bytes to a file the user never asked DotAIOS to touch, while
// the command reported the in-vault path back to them.
const OUTSIDE_MARKER = "a file outside the vault that DotAIOS was never asked to touch";
const SOURCE = "https://example.com/acme";

// The raw shelf picks its filename by reading the destination's frontmatter and
// comparing `source`: an unrelated file makes it choose a different name, so the
// case that actually reaches the writer is re-ingesting the same URL. Give the
// outside file that frontmatter, or the raw tests prove nothing.
function outsideContent() {
  return `---\nsource: ${SOURCE}\n---\n\n${OUTSIDE_MARKER}\n`;
}

function sandbox(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dotaios-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside", "notes.md");
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, outsideContent());
  return {
    root,
    outside,
    vaultRoot: path.join(root, "vault"),
    rawDir: path.join(root, "vault", "raw"),
    signalsDir: path.join(root, "memory", "signals"),
    eventsPath: path.join(root, "memory", "events.jsonl")
  };
}

function place(box, overrides) {
  return placeMarkdown({
    vaultRoot: box.vaultRoot,
    rawDir: box.rawDir,
    signalsDir: box.signalsDir,
    eventsPath: box.eventsPath,
    baseSlug: "acme",
    source: SOURCE,
    title: "Acme",
    body: "# Acme\ningested body\n",
    kind: "web",
    parser: "test",
    apply: true,
    ...overrides
  });
}

// Link the destination the shelf is about to write, pointing out of the vault.
function linkOutOfVault(box, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(box.outside, destination);
}

const durableShelves = [
  { shelf: "wiki", name: "acme", relative: ["wiki", "acme", "_index.md"] },
  { shelf: "company", name: "Acme", relative: ["org", "companies", "acme.md"] },
  { shelf: "person", name: "Ada Lovelace", relative: ["org", "people", "ada-lovelace.md"] }
];

for (const { shelf, name, relative } of durableShelves) {
  test(`ingest --to ${shelf} refuses a destination that is a symlink out of the vault`, async (t) => {
    const box = sandbox(t, `ingest-${shelf}`);
    const destination = path.join(box.vaultRoot, ...relative);
    linkOutOfVault(box, destination);

    await assert.rejects(() => place(box, { shelf, name }), /unsafe file destination/i);

    // The bytes are what matter: the file outside the vault must be untouched.
    assert.equal(fs.readFileSync(box.outside, "utf8"), outsideContent());
  });
}

test("ingest to the raw shelf refuses a destination that is a symlink out of the vault", async (t) => {
  const box = sandbox(t, "ingest-raw");
  linkOutOfVault(box, path.join(box.rawDir, "acme.md"));

  await assert.rejects(() => place(box, { shelf: "raw", overwrite: true }), /unsafe file destination/i);

  assert.equal(fs.readFileSync(box.outside, "utf8"), outsideContent());
});

// A long signal preserves the parsed markdown in vault/raw and links to it, so
// it reaches the same writer by a different route.
test("a long signal refuses a raw destination that is a symlink out of the vault", async (t) => {
  const box = sandbox(t, "ingest-signal");
  linkOutOfVault(box, path.join(box.rawDir, "acme.md"));

  await assert.rejects(
    () => place(box, { shelf: "signal", body: `# Acme\n${"long body ".repeat(200)}\n`, overwrite: true }),
    /unsafe file destination/i
  );

  assert.equal(fs.readFileSync(box.outside, "utf8"), outsideContent());
});

// Guarding only the leaf file is not enough: `vault/wiki/<slug>/_index.md` has
// an intermediate directory, and `mkdir -p` happily traverses a symlinked one.
// The leaf it then creates is a perfectly ordinary file, so a leaf-only check
// sees nothing wrong while the bytes land outside the vault.
test("ingest refuses a shelf directory that is a symlink out of the vault", async (t) => {
  const box = sandbox(t, "ingest-parent-link");
  const outsideDir = path.join(box.root, "outside", "acme");
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(path.join(box.vaultRoot, "wiki"), { recursive: true });
  fs.symlinkSync(outsideDir, path.join(box.vaultRoot, "wiki", "acme"));

  await assert.rejects(() => place(box, { shelf: "wiki", name: "acme" }), /unsafe managed (directory|root)|outside the managed file boundary/i);

  assert.equal(fs.existsSync(path.join(outsideDir, "_index.md")), false, "nothing may be created outside the vault");
});

test("ingest refuses a raw directory that is a symlink out of the vault", async (t) => {
  const box = sandbox(t, "ingest-rawdir-link");
  const outsideDir = path.join(box.root, "outside", "raw");
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(box.vaultRoot, { recursive: true });
  fs.symlinkSync(outsideDir, box.rawDir);

  await assert.rejects(() => place(box, { shelf: "raw" }), /unsafe managed (directory|root)|outside the managed file boundary/i);

  assert.deepEqual(fs.readdirSync(outsideDir), [], "nothing may be created outside the vault");
});

// Refusing the symlink must not cost the ordinary path anything: these shelves
// are the product's durable knowledge surface and have to keep working.
test("an ordinary durable write still lands inside the vault", async (t) => {
  const box = sandbox(t, "ingest-ok");

  const first = await place(box, { shelf: "wiki", name: "acme" });
  assert.equal(first.action, "written");
  assert.equal(first.destination, path.join(box.vaultRoot, "wiki", "acme", "_index.md"));
  assert.match(fs.readFileSync(first.destination, "utf8"), /ingested body/);

  // Ingesting the same page again appends below a dated heading rather than
  // replacing what is already there.
  const second = await place(box, { shelf: "wiki", name: "acme", body: "# Acme\nsecond pass\n" });
  assert.equal(second.action, "appended");
  const merged = fs.readFileSync(first.destination, "utf8");
  assert.match(merged, /ingested body/);
  assert.match(merged, /second pass/);
});
