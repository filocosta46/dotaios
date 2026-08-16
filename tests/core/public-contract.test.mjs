import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const run = promisify(execFile);

function extractAssistantInstallRefs(markdown) {
  return Array.from(
    markdown.matchAll(
      /https:\/\/github\.com\/filocosta46\/dotaios\/blob\/((?:[^/\s]+\/)*[^/\s]+)\/INSTALL\.md/g
    ),
    (match) => match[1]
  );
}

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
  try {
    await fs.access(path.join(repoRoot, ".git"));
  } catch {
    return;
  }
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

test("README leads with the nondeveloper continuity outcome before technical reference", async () => {
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
  const opening = readme.slice(0, 1200);
  const who = readme.indexOf("## Who this is for");
  const install = readme.indexOf("## Install with one request");
  const choices = readme.indexOf("## Choose what your AI can remember");
  const afterward = readme.indexOf("## What you have afterward");
  const technical = readme.indexOf("## Technical reference");

  assert.match(opening, /stop (?:repeating|retelling)|start(?:ing)? from zero/i);
  assert.match(opening, /one (?:readable |local )?folder/i);
  assert.doesNotMatch(opening, /\bMCP\b|package manager|npm provenance|adapter configuration/i);
  assert.ok(who > 0, "README must name the first customer explicitly");
  assert.match(
    readme.slice(who, install),
    /independent consultant|freelancer/i,
    "README must identify the first buyer before installation"
  );
  assert.ok(install > who, "customer fit must come before installation");
  assert.ok(choices > install, "privacy choices must follow the primary activation path");
  assert.ok(afterward > choices, "the memory-choice section must end before the product outcome resumes");
  assert.ok(technical > afterward, "operator material must stay behind a technical-reference boundary");
  assert.match(readme, /install[\s\S]{0,300}personalize[\s\S]{0,300}save[\s\S]{0,300}switch[\s\S]{0,300}privacy/i);
  const memoryChoices = readme.slice(choices, afterward);
  assert.match(memoryChoices, /Codex and Claude Code[\s\S]{0,240}forward[\s\S]{0,120}Off/i);
  assert.match(memoryChoices, /instructions or context.*may already have loaded/i);
  assert.match(memoryChoices, /Off.*cannot (?:undo|erase)/i);
  assert.match(memoryChoices, /AI app may still keep its own chat history/i);
});

test("Hermes claims a global adapter without inventing a project-local selector", async () => {
  const relativeFiles = [
    "docs/adapters.md",
    "docs/architecture.md",
    "docs/client-support.md",
    "docs/compatibility-acceptance.md",
    "docs/getting-started.md"
  ];
  const documents = Object.fromEntries(await Promise.all(
    relativeFiles.map(async (relativePath) => [
      relativePath,
      await fs.readFile(path.join(repoRoot, relativePath), "utf8")
    ])
  ));
  const registry = JSON.parse(
    await fs.readFile(path.join(repoRoot, "packages/core/src/agents.json"), "utf8")
  );
  const hermes = registry.agents.find((agent) => agent.name === "Hermes");
  const corpus = Object.values(documents).join("\n");

  assert.equal(hermes.skills.project, undefined);
  assert.match(documents["docs/adapters.md"], /does not configure a project-local Hermes file/i);
  assert.match(documents["docs/client-support.md"], /no project-local adapter/i);
  assert.match(documents["docs/compatibility-acceptance.md"], /no bundled project target/i);
  assert.doesNotMatch(corpus, /plus Hermes|<project>\/\.hermes\/config\.yaml.*for Hermes/is);

  const install = await fs.readFile(path.join(repoRoot, "INSTALL.md"), "utf8");
  const changelog = await fs.readFile(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  // Cerca in tutto il CHANGELOG. Questa e' una proprieta' permanente del
  // prodotto, documentata una volta nella release che l'ha cambiata: una
  // finestra sulle ultime due sezioni la perde al primo rilascio successivo,
  // che e' esattamente come "legarla alla sola Unreleased" bloccava ogni
  // rilascio prima di essere allargata.
  const documentato = changelog;
  // The removal-contract version is asserted from package.json in the
  // onboarding test below. A second, hardcoded copy here would pin one release
  // forever and fail every bump after it.
  assert.match(install, /\.hermes\/config\.yaml.*remove only that exact entry/is);
  assert.doesNotMatch(install, /Current DotAIOS does not configure project-local Hermes/i);
  assert.match(documentato, /Project attachment no longer writes `<project>\/\.hermes\/config\.yaml`/i);
});

test("first-time onboarding stays assistant-guided, consent-first, pinned, and free of install lifecycle scripts", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.version, "2.0.7", "the public onboarding contract must target the release candidate");
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
    assert.match(documents[relativePath], new RegExp(`^npx ${pinnedPattern}$`, "m"), `${relativePath} must retain a pinned manual recovery path`);
  }
  assert.match(documents["README.md"], /open .*assistant.*paste/is, "README must lead with one assistant request");
  assert.deepEqual(
    extractAssistantInstallRefs([
      `https://github.com/filocosta46/dotaios/blob/v${pkg.version}/INSTALL.md`,
      "https://github.com/filocosta46/dotaios/blob/feature/privacy/INSTALL.md"
    ].join("\n")),
    [`v${pkg.version}`, "feature/privacy"],
    "assistant handoff extraction must include slash-containing mutable refs"
  );
  for (const relativePath of ["README.md", "docs/friend-setup.md"]) {
    const handoffRefs = extractAssistantInstallRefs(documents[relativePath]);
    assert.deepEqual(
      handoffRefs,
      [`v${pkg.version}`],
      `${relativePath} must use exactly one release-pinned assistant handoff`
    );
  }
  assert.match(documents["README.md"], /_npmUser\.name/, "README provenance must request the publisher it claims to display");
  assert.match(documents["INSTALL.md"], /If an AI assistant is helping you/i, "INSTALL must carry the assistant through setup");
  assert.match(documents["docs/friend-setup.md"], /recommended path is to ask a local AI agent/i, "friend setup must recommend the nontechnical path");
  const projectVerificationContract = /explicitly registered project(?=[\s\S]{0,100}\bslug\b)(?=[\s\S]{0,100}\bstable ID\b)[\s\S]{0,200}> Only this project\./i;
  for (const incompletePrerequisite of [
    "registered project with a slug or stable ID\n\n> Only this project.",
    "explicitly registered project\n\n> Only this project."
  ]) {
    assert.doesNotMatch(
      incompletePrerequisite,
      projectVerificationContract,
      "project verification must require explicit registration plus a slug or stable ID"
    );
  }
  assert.match(documents["docs/friend-setup.md"], projectVerificationContract, "friend setup must verify project mode with a project first message");
  assert.match(documents["docs/friend-setup.md"], /otherwise[\s\S]{0,200}> Use my memory\./i, "friend setup must verify Shared with a Shared first message");
  assert.match(documents["docs/friend-setup.md"], /verify Off[\s\S]{0,200}> Private chat\./i, "friend setup must retain a separate Off verification message");
  assert.match(documents["docs/getting-started.md"], /You do not need to understand[\s>]*Node, npm, Git, or MCP/i, "getting started must not assume developer knowledge");
  assert.match(corpus, /preview every change|previewing every change/i, "assistant-led setup must remain preview-first");
  assert.match(corpus, /meaningful choices|choices I can evaluate/i, "assistant-led setup must leave consent with the person");
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
  // INSTALL claimed the sync token lived in "the machine credential store".
  // Nothing in the product has ever used the Keychain or any OS credential
  // store: it is a plaintext field in ~/.dotaios/sync.json at mode 0600. A
  // reader deciding whether to trust sync with a GitHub token is exactly the
  // reader that claim misleads, so name the real file and rule the store out.
  // Assert against unwrapped prose: these are sentences, and a reflow must not
  // be able to silently drop a disclosure the reader is owed.
  const unwrapped = Object.fromEntries(
    relativeFiles.map((relativePath) => [relativePath, documents[relativePath].replace(/\s+/g, " ")])
  );
  assert.match(unwrapped["INSTALL.md"], /plaintext in `~\/\.dotaios\/sync\.json`/, "INSTALL must disclose that the sync token is stored in plaintext, and where");

  // The Node bootstrap has now regressed twice without a test noticing: #76
  // removed the ask-before-Node gate and #81 restored it, and the brew/nvm
  // route outlived both. Assert the shape of the bootstrap against unwrapped
  // prose, so a reflow cannot drop it and an unrelated docs edit cannot revert
  // it while CI stays green.
  assert.doesNotMatch(
    unwrapped["INSTALL.md"],
    /normal route: `brew install node`/i,
    "INSTALL must not send macOS to the unpinned brew formula: it tracks the current release, which CI does not cover"
  );
  assert.match(
    unwrapped["INSTALL.md"],
    /nodejs\.org/i,
    "INSTALL must name the official installer, the only route that works on a Mac with no package manager"
  );
  assert.match(
    unwrapped["INSTALL.md"],
    /`nvm`/,
    "INSTALL must rule out nvm: it is a shell function, so its Node is absent from the assistant's next command"
  );
  assert.match(
    unwrapped["INSTALL.md"],
    /confirm it prints 20 or newer/i,
    "INSTALL must re-check the version after installing, since engines is not enforced at runtime"
  );
  assert.match(
    unwrapped["README.md"],
    /installs it for you where it can/i,
    "README must describe the same Node bootstrap INSTALL performs, not an older consent gate"
  );
  assert.match(unwrapped["INSTALL.md"], /does not use the macOS Keychain or another operating-system credential store/i, "INSTALL must not imply an OS credential store it does not use");
  assert.doesNotMatch(corpus.replace(/\s+/g, " "), /[Cc]redentials stay in the machine credential store/, "no public page may claim an OS credential store");
  assert.match(documents["INSTALL.md"], new RegExp(`${pkg.version.replaceAll(".", "\\.")} removal contract`, "i"), "INSTALL must scope removal instructions to the installed release");
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

test("public update guidance reviews metadata before one exact-version upgrade", async () => {
  const documents = Object.fromEntries(await Promise.all(
    ["README.md", "INSTALL.md"].map(async (relativePath) => [
      relativePath,
      await fs.readFile(path.join(repoRoot, relativePath), "utf8")
    ])
  ));
  const updateSections = {
    "README.md": documents["README.md"].split("## Updating")[1]?.split(/\n## /)[0] || "",
    "INSTALL.md": documents["INSTALL.md"].split("## Update")[1]?.split(/\n## /)[0] || ""
  };

  for (const [relativePath, section] of Object.entries(updateSections)) {
    assert.match(
      section,
      /npm view dotaios@latest version dist\.integrity dist\.tarball gitHead scripts dependencies/,
      `${relativePath} must inspect registry metadata before executing a release`
    );
    assert.doesNotMatch(section, /npx(?: -y)? dotaios@latest/, `${relativePath} must never execute mutable @latest during an upgrade`);
    assert.doesNotMatch(section, /npx -y/, `${relativePath} must retain npm's confirmation in the trust-critical upgrade flow`);
    for (const command of [
      "--version",
      "doctor",
      "migrate",
      "migrate --apply <plan-id>",
      "activate",
      "skills doctor",
      "capture enable claude-code",
      "mcp config --agent <agent>"
    ]) {
      assert.match(
        section,
        new RegExp(`^npx dotaios@<version> ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
        `${relativePath} must document exact-version ${command}`
      );
    }
    assert.match(section, /MCP.*does not.*edit.*client config/is, `${relativePath} must require the printed MCP fragment to be reapplied manually`);
  }
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
  const [mcpDocumentation, adaptersDocumentation, sessionsDocumentation, architectureDocumentation, agentsTemplate] = contents;
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
    mcpDocumentation,
    /`current`, `schema_outdated`, `transaction_present`, or\s+`inspection_failed`/,
    "the public MCP contract must freeze the four migration states"
  );
  assert.match(
    mcpDocumentation,
    /`path_scope: "configured_aios"`/,
    "operational actions must target the same configured AIOS without leaking its path"
  );
  assert.match(
    mcpDocumentation,
    /1,024-character allowance[\s\S]*non-`markdown` metadata[\s\S]*JSON escaping and protocol framing are representation/i,
    "the public budget contract must separate operational metadata from JSON representation cost"
  );
  assert.doesNotMatch(
    [mcpDocumentation, adaptersDocumentation, sessionsDocumentation, architectureDocumentation].join("\n"),
    /canonical (?:memory )?digest|startup digest|digest budget/i,
    "public guidance must use the canonical working-context projection vocabulary"
  );
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

// The assistant is told to follow INSTALL.md at a blob URL, so what it reads is
// the RAW markdown -- list indentation and all. A heredoc only closes on an
// unindented delimiter, so a `JSON` terminator carrying the three spaces of its
// surrounding list item never ends the document: setup receives the terminator
// and everything after it as part of the payload, reports invalid JSON, and
// creates nothing. That shipped in 2.0.4 and 2.0.5 -- the block rendered fine on
// github.com, where the indentation is stripped, and failed for every agent that
// read the source. Assert the property the shell actually enforces.
test("every heredoc in the docs closes on an unindented delimiter", async () => {
  const relativeFiles = ["INSTALL.md", "README.md", "docs/friend-setup.md", "docs/getting-started.md"];

  for (const relative of relativeFiles) {
    let source;
    try {
      source = await fs.readFile(path.join(repoRoot, relative), "utf8");
    } catch {
      continue;
    }

    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const opener = lines[index].match(/<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?/);
      if (!opener) continue;
      const delimiter = opener[1];
      const dash = /<<-/.test(lines[index]);

      const closing = lines.findIndex(
        (line, at) => at > index && line.trimEnd().trim() === delimiter
      );
      assert.notEqual(closing, -1, `${relative}:${index + 1} opens <<${delimiter} with no closing delimiter`);

      const raw = lines[closing];
      const leading = raw.slice(0, raw.length - raw.trimStart().length);
      // `<<-` strips leading TABS only, never spaces, so it does not rescue an
      // indented terminator inside a markdown list.
      const allowed = dash ? /^\t*$/ : /^$/;
      assert.match(
        leading,
        allowed,
        `${relative}:${closing + 1} closes <<${delimiter} with ${JSON.stringify(leading)} before it, ` +
        "so the heredoc never terminates when the raw markdown is run"
      );
    }
  }
});
