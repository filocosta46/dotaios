import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { marketCommand } from "../../packages/cli/src/commands/market.mjs";
import { validateManifest } from "../../packages/core/src/manifest.mjs";
import { validateMarketRegistry } from "../../packages/core/src/market-registry.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const packRoot = path.join(repoRoot, "packs", "independent-consultant");

const skillNames = [
  "consultant-bounded-research-memo",
  "consultant-notes-to-follow-up-draft",
  "consultant-prepare-client-call",
  "consultant-proposal-scope-draft",
  "consultant-start-client-project",
  "consultant-weekly-client-review"
];

const expectedFiles = [
  "LICENSE.md",
  "PROVENANCE.md",
  "README.md",
  "catalog-entry.json",
  "fixtures/client-project/README.md",
  "manifest.json",
  ...skillNames.map((name) => `skills/${name}/SKILL.md`)
].sort();

const requiredSafetyLines = [
  "Work inside one named client project only. If the client scope is missing or ambiguous, stop and ask.",
  "Label every material input and claim as `[Client-provided]`, `[Internal note]`, `[Public source]`, or `[Assumption]`. Include a local path or citation and access date when available.",
  "Do not send, publish, upload, or message any output. Produce a local draft only.",
  "Do not recommend, set, change, or approve pricing. Leave pricing and commercial terms to the human.",
  "Do not read, request, store, or expose credentials or secrets. Stop and redact if one appears.",
  "Do not create, configure, schedule, or run automation, hooks, jobs, or background loops.",
  "Do not delete or overwrite source material or an existing deliverable. Propose a new draft path.",
  "Require explicit human review before any durable write or external action. A draft is never approval."
];

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(packRoot, relativePath), "utf8"));
}

function parseFrontmatter(content, source) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${source} must start with YAML frontmatter`);
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
  assert.deepEqual(document.errors, [], `${source} has invalid frontmatter`);
  const value = document.toJS();
  assert.equal(typeof value, "object", `${source} frontmatter must be a mapping`);
  return value;
}

async function collectFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    const stat = await fs.lstat(absolutePath);
    assert.equal(stat.isSymbolicLink(), false, `${relativePath} must not be a symlink`);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath, relativePath));
    } else {
      assert.equal(entry.isFile(), true, `${relativePath} must be a regular file`);
      files.push(relativePath);
    }
  }
  return files;
}

test("candidate contains only the approved static artifact shape", async () => {
  assert.deepEqual((await collectFiles(packRoot)).sort(), expectedFiles);
});

test("manifest is valid and has one identity with six review-gated skills", async () => {
  const manifest = await readJson("manifest.json");
  const validation = validateManifest(manifest);

  assert.equal(validation.valid, true, validation.errors.join("; "));
  assert.equal(manifest.name, "independent-consultant");
  assert.equal(manifest.product_id, manifest.name);
  assert.equal(manifest.vendor, "dotaios");
  assert.equal(manifest.paid, true);
  assert.deepEqual([...manifest.provides.skills].sort(), skillNames);
  assert.deepEqual(manifest.provides.memory_writers, []);
  assert.deepEqual(manifest.provides.scheduled_tasks, []);
  assert.deepEqual(manifest.requires.connections, []);
  assert.deepEqual(manifest.permissions.connections, []);
  assert.deepEqual(manifest.permissions.write, []);
  assert.deepEqual(manifest.permissions.write_with_approval, ["projects/*"]);
});

test("catalog identity is private, draft, and has no purchase or delivery surface", async () => {
  const manifest = await readJson("manifest.json");
  const catalogEntry = await readJson("catalog-entry.json");
  const registry = validateMarketRegistry({ entries: [catalogEntry] }, { source: "private candidate" });

  assert.equal(registry.entries.length, 1);
  assert.equal(catalogEntry.id, manifest.name);
  assert.equal(catalogEntry.product_id, manifest.product_id);
  assert.equal(catalogEntry.vendor, manifest.vendor);
  assert.equal(catalogEntry.status, "draft");
  assert.equal(catalogEntry.visibility, "private");
  assert.equal(catalogEntry.paid, true);
  assert.equal(catalogEntry.price_eur, "35.00");
  for (const forbiddenKey of ["checkout_url", "gumroad_url", "install_url", "git_url", "subdir"]) {
    assert.equal(Object.hasOwn(catalogEntry, forbiddenKey), false, `${forbiddenKey} must be absent`);
  }
});

test("the marketplace refuses the private draft before package resolution", async () => {
  const catalogEntry = await readJson("catalog-entry.json");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-private-pack-"));
  const registryPath = path.join(directory, "registry.json");
  await fs.writeFile(registryPath, `${JSON.stringify({ entries: [catalogEntry] }, null, 2)}\n`);

  try {
    await assert.rejects(
      marketCommand([
        "install",
        catalogEntry.id,
        "--registry",
        pathToFileURL(registryPath).href
      ]),
      /still in preparation.*no checkout or install/i
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the published npm package allowlist excludes private pack candidates", async () => {
  const packageManifest = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.ok(Array.isArray(packageManifest.files));
  assert.equal(
    packageManifest.files.some((entry) => entry === "packs" || entry.startsWith("packs/")),
    false,
    "the npm package must not expose packs/"
  );
});

test("every skill has valid identity frontmatter and the full safety boundary", async () => {
  for (const skillName of skillNames) {
    const relativePath = `skills/${skillName}/SKILL.md`;
    const content = await fs.readFile(path.join(packRoot, relativePath), "utf8");
    const frontmatter = parseFrontmatter(content, relativePath);

    assert.equal(frontmatter.name, skillName);
    assert.equal(typeof frontmatter.description, "string");
    assert.ok(frontmatter.description.length >= 40);
    assert.ok(Array.isArray(frontmatter.triggers));
    assert.equal(frontmatter.triggers.length, 3);
    assert.equal(new Set(frontmatter.triggers).size, 3);
    for (const section of ["## Purpose", "## Inputs", "## Steps", "## Output", "## Safety boundary"]) {
      assert.ok(content.includes(section), `${relativePath} is missing ${section}`);
    }
    for (const safetyLine of requiredSafetyLines) {
      assert.ok(content.includes(safetyLine), `${relativePath} is missing safety gate: ${safetyLine}`);
    }
  }
});

test("workflow-specific controls remain narrow and evidence based", async () => {
  const contents = Object.fromEntries(await Promise.all(skillNames.map(async (skillName) => [
    skillName,
    await fs.readFile(path.join(packRoot, "skills", skillName, "SKILL.md"), "utf8")
  ])));

  assert.match(contents["consultant-start-client-project"], /show the proposed path and full draft/i);
  assert.match(contents["consultant-prepare-client-call"], /do not create invitations or contact participants/i);
  assert.match(contents["consultant-notes-to-follow-up-draft"], /evidence table linking every decision and action/i);
  assert.match(contents["consultant-bounded-research-memo"], /three to six non-overlapping subquestions/i);
  assert.match(contents["consultant-bounded-research-memo"], /stop when the agreed subquestions are answered once/i);
  assert.match(contents["consultant-proposal-scope-draft"], /\[HUMAN PRICING DECISION REQUIRED\]/);
  assert.match(contents["consultant-weekly-client-review"], /apply no update without explicit human approval/i);
});

test("client-project fixture is scoped, provenance labelled, and review gated", async () => {
  const relativePath = "fixtures/client-project/README.md";
  const content = await fs.readFile(path.join(packRoot, relativePath), "utf8");
  const frontmatter = parseFrontmatter(content, relativePath);

  assert.equal(frontmatter.status, "draft");
  assert.equal(frontmatter.client_scope, "one-named-client-only");
  assert.equal(frontmatter.template_state, "unreviewed");
  for (const label of ["[Client-provided]", "[Internal note]", "[Public source]", "[Assumption]"]) {
    assert.ok(content.includes(label), `template is missing ${label}`);
  }
  assert.match(content, /do not infer/i);
  assert.match(content, /do not store credentials or secrets/i);
  assert.match(content, /do not configure automation/i);
  assert.match(content, /do not delete or overwrite source material/i);
  assert.match(content, /wait for explicit human approval/i);
});

test("documentation states unresolved licensing, provenance, and paid lifecycle gaps", async () => {
  const [readme, license, provenance] = await Promise.all([
    fs.readFile(path.join(packRoot, "README.md"), "utf8"),
    fs.readFile(path.join(packRoot, "LICENSE.md"), "utf8"),
    fs.readFile(path.join(packRoot, "PROVENANCE.md"), "utf8")
  ]);

  assert.match(readme, /private, non-purchasable candidate/i);
  assert.match(readme, /authenticated delivery and entitlement checks/i);
  assert.match(readme, /tested removal, rollback, and recovery/i);
  assert.match(readme, /instruction boundary rather than a sandbox/i);
  assert.match(license, /licensing for this candidate is unresolved/i);
  assert.match(license, /not an offer for sale/i);
  assert.match(provenance, /no third-party repository code/i);
  assert.match(provenance, /unknown provenance blocks publication/i);
});

test("publishable pack copy uses plain ASCII dashes", async () => {
  for (const relativePath of expectedFiles) {
    const content = await fs.readFile(path.join(packRoot, relativePath), "utf8");
    assert.doesNotMatch(content, /[\u2013\u2014]/u, `${relativePath} contains an en dash or em dash`);
  }
});
