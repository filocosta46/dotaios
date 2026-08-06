import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const run = promisify(execFile);

async function npmPackDryRun() {
  const { stdout } = await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  const pack = Array.isArray(result) ? result[0] : Object.values(result)[0];
  return pack.files.map((file) => file.path);
}

test("commercial website source stays outside the public repository", async () => {
  const { stdout } = await run("git", ["-C", repoRoot, "ls-files", "--", "website"]);
  assert.equal(stdout.trim(), "");
});

test("public claims stay inside the verified product boundary", async () => {
  const relativeFiles = [
    "README.md",
    "docs/adapters.md",
    "docs/client-support.md",
    "docs/getting-started.md",
    "packages/cli/src/commands/activate.mjs",
  ];
  const contents = await Promise.all(
    relativeFiles.map((relativePath) => fs.readFile(path.join(repoRoot, relativePath), "utf8"))
  );
  const corpus = contents.join("\n");

  assert.doesNotMatch(corpus, /gumroad\.com|lemonsqueezy\.com|updated weekly|refreshed every week/i);
  assert.doesNotMatch(corpus, /every AI reads|no cloud memory|native in every tool/i);
});

test("first-time onboarding stays human-run, pinned, and free of install lifecycle scripts", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    assert.equal(pkg.scripts?.[lifecycle], undefined, `${lifecycle} must remain absent`);
  }

  const relativeFiles = ["README.md", "INSTALL.md", "docs/friend-setup.md", "docs/getting-started.md"];
  const documents = Object.fromEntries(await Promise.all(
    relativeFiles.map(async (relativePath) => [
      relativePath,
      await fs.readFile(path.join(repoRoot, relativePath), "utf8")
    ])
  ));
  const contents = relativeFiles.map((relativePath) => documents[relativePath]);
  const corpus = contents.join("\n");
  const pinned = `dotaios@${pkg.version} setup`;
  const pinnedPattern = pinned.replaceAll(".", "\\.");

  for (const relativePath of relativeFiles) {
    assert.match(documents[relativePath], new RegExp(`${pinnedPattern} --dry-run`), `${relativePath} must pin the preview`);
    assert.match(documents[relativePath], new RegExp(`^npx ${pinnedPattern}$`, "m"), `${relativePath} must pin human-run setup`);
  }
  assert.doesNotMatch(corpus, /Please set up DotAIOS for me|agent-led setup|you are on the agent path/i);
  assert.doesNotMatch(corpus, /\bpreview makes no changes\b/i);
  assert.match(corpus, /npm may download and cache the named package/i);
  assert.doesNotMatch(documents["docs/friend-setup.md"], /dotaios@latest (?:init|activate|setup)/, "friend setup must not switch first-time commands back to @latest");
  assert.doesNotMatch(documents["docs/getting-started.md"], /Setup and upgrade commands use .*@latest/i, "getting started must distinguish pinned setup from later updates");
  assert.match(documents["INSTALL.md"], /shared\s+`~\/\.agents\/skills` directory/i, "INSTALL must disclose the shared global skill surface");
  assert.match(documents["INSTALL.md"], /each attached checkout listed in `~\/\.dotaios\/projects\.json`/i, "INSTALL must cover project-local removal");
  assert.doesNotMatch(documents["INSTALL.md"], /use `\/memory-maintenance`/, "INSTALL must use cross-client skill invocation language");
  assert.doesNotMatch(documents["INSTALL.md"], /npx(?: -y)? dotaios@latest/i, "INSTALL must inspect latest metadata before running one exact release");
  assert.match(documents["INSTALL.md"], /pins DotAIOS itself, not its complete dependency graph/i, "INSTALL must bound the reproducibility claim");
  assert.match(documents["INSTALL.md"], /`~\/aios\/memory\/sessions`.*private GitHub mirror/is, "INSTALL must disclose capture and sync composition");
  assert.match(documents["INSTALL.md"], /GitHub\s+repository remains.*revoke the token/is, "INSTALL must disclose remote and credential cleanup");
  assert.match(documents["INSTALL.md"], /bundled with the reviewed release.*does not install third-party plugins/is, "INSTALL must bound the shared skill surface");
  assert.match(documents["INSTALL.md"], /\[would preserve collision\].*\[would stop\]/is, "INSTALL must turn preview output into a proceed-or-stop gate");
  assert.match(documents["INSTALL.md"], /^npx dotaios@[^\s]+ skills doctor$/m, "INSTALL must lead with human-readable skill verification");
  assert.match(documents["INSTALL.md"], /Do not use this for your personal installation/i, "INSTALL must separate test automation from personal setup");
  assert.match(documents["INSTALL.md"], /github\.com\/filocosta46\/dotaios\/issues/, "INSTALL must provide a support handoff");
  assert.match(documents["INSTALL.md"], /1\.28\.2 removal contract/i, "INSTALL must scope removal instructions to the installed release");
  assert.match(documents["INSTALL.md"], /doctor --path <aios-path>/i, "INSTALL must make custom-path removal inspectable");
  assert.match(documents["INSTALL.md"], /retired `~\/\.cursor\/skills`.*`~\/\.gemini\/skills`.*`~\/\.gemini\/config\/skills`/is, "INSTALL must cover retired global skill targets");
  assert.match(documents["INSTALL.md"], /\.cursor\/rules\/dotaios\.mdc.*remove only that block/is, "INSTALL must cover the retired project Cursor bridge");

  for (const retiredLauncher of [
    ".github/workflows/release-installers.yml",
    "installers/windows/setup.bat",
    "installers/windows/dotaios.wxs"
  ]) {
    await assert.rejects(
      fs.access(path.join(repoRoot, retiredLauncher)),
      (error) => error.code === "ENOENT",
      `${retiredLauncher} must not bypass the pinned preview-first install path`
    );
  }

  const pluginDevelopment = await fs.readFile(path.join(repoRoot, "docs/plugin-development.md"), "utf8");
  const securityGuide = await fs.readFile(path.join(repoRoot, "docs/security.md"), "utf8");
  const skillSurfaces = await Promise.all([
    "packages/cli/src/commands/skill.mjs",
    "packages/cli/src/commands/skills.mjs",
    "packages/core/src/skills.mjs"
  ].map((relativePath) => fs.readFile(path.join(repoRoot, relativePath), "utf8")));
  const pluginContract = `${corpus}\n${pluginDevelopment}\n${securityGuide}\n${skillSurfaces.join("\n")}`;
  assert.doesNotMatch(
    pluginContract,
    /dotaios@(?:latest|[0-9.]+) install (?:https?:\/\/|git@)/i,
    "public guides must not advertise mutable remote plugin execution"
  );
  assert.doesNotMatch(
    pluginContract,
    /url-or-path|git\/https URL|trusted git URLs|Git URL installs are supported/i,
    "all public plugin surfaces must advertise reviewed local folders only"
  );
  assert.match(
    securityGuide,
    /remote\s+URL inputs are refused/i,
    "the security guide must state the executable remote-source boundary"
  );
});

test("commercial delivery and internal launch gates stay outside the public core", async () => {
  const forbiddenPaths = [
    "docs/beta-testing.md",
    "docs/marketplace.md",
    "docs/pilot/README.md",
    "docs/pilot/pilot-sheet-template.md",
    "docs/pilot/scoring-rubric.md",
    "packages/cli/src/adapters/gumroad-license.mjs",
    "packages/cli/src/commands/license.mjs",
    "packages/cli/src/commands/market.mjs",
    "packages/cli/src/commands/pilot-report.mjs",
    "packages/cli/src/commands/pilot-score.mjs",
    "packages/cli/src/lib/pilot-rollup.mjs",
    "packages/core/src/licenses.mjs",
    "packages/core/src/market-registry.mjs",
    "scripts/pilot-rollup.mjs",
  ];
  for (const relativePath of forbiddenPaths) {
    await assert.rejects(
      fs.access(path.join(repoRoot, relativePath)),
      (error) => error.code === "ENOENT",
      `${relativePath} is private launch or delivery machinery`
    );
  }

  let handoffFiles = [];
  try {
    handoffFiles = await fs.readdir(path.join(repoRoot, "docs", "handoff"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert.deepEqual(handoffFiles, [], "internal handoff documents stay outside the public repository");

  const packedFiles = await npmPackDryRun();
  assert.equal(packedFiles.includes("packages/cli/src/lib/pilot-metrics.mjs"), false);

  const textExtensions = new Set([".hbs", ".json", ".md", ".mjs", ".txt", ".yaml", ".yml"]);
  const textFiles = packedFiles.filter((relativePath) => textExtensions.has(path.extname(relativePath)));
  const contents = await Promise.all(textFiles.map((relativePath) =>
    fs.readFile(path.join(repoRoot, relativePath), "utf8")
  ));
  const corpus = contents.join("\n");
  const corpusWithoutLegacyRecoveryFilename = corpus.replaceAll("pilot.jsonl", "legacy-metrics.jsonl");

  assert.doesNotMatch(corpus, /gumroad|lemonsqueezy|checkout_url|product_id|paid packages?|paid plugins?/i);
  assert.doesNotMatch(corpus, /pilot-(?:score|report)|ship_pilot|go_public/i);
  assert.doesNotMatch(corpusWithoutLegacyRecoveryFilename, /\bpilot\b|Pilot health/i);
});

test("public context guidance documents only the current MCP tools and one memory projection", async () => {
  const relativeFiles = [
    "docs/mcp.md",
    "docs/adapters.md",
    "docs/sessions.md",
    "docs/architecture.md",
    "templates/AGENTS.md.hbs",
    "packages/core/src/bridges.mjs",
  ];
  const contents = await Promise.all(
    relativeFiles.map((relativePath) => fs.readFile(path.join(repoRoot, relativePath), "utf8"))
  );
  const [mcpDocumentation, , , , agentsTemplate] = contents;
  const toolsSection = mcpDocumentation.split("## Tools")[1].split(/\n## /)[0];
  const documentedTools = [...toolsSection.matchAll(/^- `([a-z_]+)`:/gm)]
    .map((match) => match[1]);
  const corpus = contents.join("\n");
  const retiredToolNames = [
    ["read", "session", "digest"], ["read", "context"], ["list", "skills"],
    ["search", "memory"], ["search", "vault"], ["list", "projects"],
    ["log", "event"], ["google", "status"], ["google", "gmail", "search"],
    ["google", "calendar", "agenda"], ["google", "drive", "search"],
  ].map((parts) => parts.join("_"));

  assert.deepEqual(documentedTools, ["read_working_context", "search_aios", "resolve_skill"]);
  assert.equal(retiredToolNames.some((name) => corpus.includes(name)), false);
  assert.match(
    agentsTemplate,
    /Do not preload `memory\/events\.jsonl`, `memory\/signals\/`, or `memory\/sessions\/`/,
    "the lean router must still enforce the single bounded memory projection"
  );
  assert.doesNotMatch(agentsTemplate, /load the last 50|load the single most recent file/i);
});

test("shipped skills route working-memory reads through the bounded projection", async () => {
  const skillsRoot = path.join(repoRoot, "skills");
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  const skillFiles = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const file = path.join(skillsRoot, entry.name, "SKILL.md");
      try {
        return { file, content: await fs.readFile(file, "utf8") };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }));
  const directRead = /(?:read|load|scan|review|inspect)[^\n`]*(?:memory\/(?:events\.jsonl|signals|sessions))/i;
  for (const skill of skillFiles.filter(Boolean)) {
    for (const line of skill.content.split(/\r?\n/)) {
      assert.doesNotMatch(line, directRead, `${skill.file} directly reads working memory: ${line}`);
    }
  }
});
