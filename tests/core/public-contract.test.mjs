import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { ADMISSION_NPM_VERSION } from "../../scripts/onboarding-release-acceptance.mjs";

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
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const { stdout } = await run(npx, [
    "--yes", "--package", `npm@${ADMISSION_NPM_VERSION}`,
    "npm", "pack", "--dry-run", "--json", "--ignore-scripts",
  ], {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  const pack = Array.isArray(result) ? result[0] : Object.values(result)[0];
  return pack.files.map((file) => file.path);
}

const PRIVATE_IDENTIFIER_MARKERS = [
  { label: "maintainer name", value: ["fi", "lippo"].join("") },
  { label: "private family name", value: ["mo", "rena"].join("") },
  { label: "private family surname", value: ["dal", "monte"].join("") },
  { label: "machine-local home", value: ["/Users/", "fi", "lo"].join("") },
  { label: "private device hostname", value: ["iMac-di-", "Mo", "rena"].join("") },
  { label: "private family context", value: ["mother", "'s business context"].join("") },
];

async function trackedPublicEntries(root) {
  const { stdout } = await run("git", ["-C", root, "ls-files", "-z"]);
  const entries = [];
  for (const relative of stdout.split("\0").filter(Boolean)) {
    let content;
    try {
      content = await fs.readFile(path.join(root, relative));
    } catch (error) {
      if (error?.code === "ENOENT") {
        entries.push({ relative, content: Buffer.alloc(0) });
        continue;
      }
      throw error;
    }
    entries.push({ relative, content });
  }
  return entries;
}

function findPrivateIdentifierOffenders(entries) {
  const offenders = [];
  for (const { relative, content } of entries) {
    for (const marker of PRIVATE_IDENTIFIER_MARKERS) {
      if (relative.toLowerCase().includes(marker.value.toLowerCase())) {
        offenders.push(`${relative}:path: ${marker.label}`);
      }
    }
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    for (const [index, line] of text.split("\n").entries()) {
      for (const marker of PRIVATE_IDENTIFIER_MARKERS) {
        if (!line.toLowerCase().includes(marker.value.toLowerCase())) continue;
        const intentionalAuthor =
          relative === "package.json" &&
          marker.label === "maintainer name" &&
          line.trim().replace(/,$/, "").toLowerCase() ===
            `"author": "${marker.value} costa"`;
        if (!intentionalAuthor) offenders.push(`${relative}:${index + 1}: ${marker.label}`);
      }
    }
  }
  return offenders;
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

test("optional Lightpanda download discloses its separate AGPL license before consent", async () => {
  const files = [
    "docs/getting-started.md",
    "docs/security.md",
    "packages/cli/src/commands/setup.mjs"
  ];
  for (const relative of files) {
    const content = await fs.readFile(path.join(repoRoot, relative), "utf8");
    assert.match(content, /Lightpanda[\s\S]{0,500}AGPL-3\.0/i, relative);
    assert.match(content, /github\.com\/lightpanda-io\/browser/i, relative);
  }
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
  assert.match(readme, /install[\s\S]{0,500}connect[\s\S]{0,500}understand[\s\S]{0,500}propose[\s\S]{0,500}approv/i);
  const memoryChoices = readme.slice(choices, afterward);
  assert.match(memoryChoices, /Codex and Claude Code[\s\S]{0,240}forward[\s\S]{0,120}Off/i);
  assert.match(memoryChoices, /instructions or context.*may already have loaded/i);
  assert.match(memoryChoices, /Off.*cannot (?:undo|erase)/i);
  assert.match(memoryChoices, /AI app may still keep its own chat history/i);
});

test("public induction is one approved existing-folder task, not an instruction-file design exercise", async () => {
  const relativeFiles = [
    "README.md",
    "docs/getting-started.md",
    "docs/projects.md",
    "docs/architecture.md"
  ];
  const documents = Object.fromEntries(await Promise.all(relativeFiles.map(async (relativePath) => [
    relativePath,
    await fs.readFile(path.join(repoRoot, relativePath), "utf8")
  ])));
  const prompt = "Help me with one useful task in an existing work folder. Ask what I want to accomplish. If the folder is not connected, ask only for its location; do not require a description. Explain what you understand, propose exactly one action, and wait for my explicit approval before acting.";

  assert.match(documents["README.md"], new RegExp(`> ${prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(documents["docs/getting-started.md"], new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(documents["docs/projects.md"], /preview[\s\S]*fresh direct confirmation[\s\S]*resolve[\s\S]*one exact proposed action/is);
  assert.match(documents["docs/architecture.md"], /understand[\s\S]*recommend[\s\S]*fresh direct approval[\s\S]*act/is);
  assert.match(documents["README.md"], /browser-only chat cannot access a local work folder[\s\S]*supported local agent/i);
  assert.match(documents["README.md"], /ask only for its location[\s\S]*do not require a description/i);
  assert.doesNotMatch(documents["README.md"], /asks? for (?:the folder|its location),? (?:its )?purpose/i);
  assert.doesNotMatch(documents["README.md"], /design|edit|write[\s-]+(?:an? )?(?:AGENTS|CLAUDE)\.md/i);
});

test("project-native routing teaches keep-it-there connection and generic fresh-context entry", async () => {
  const projects = await fs.readFile(path.join(repoRoot, "docs/projects.md"), "utf8");
  assert.match(projects, /keep the repository wherever it already is and connect its folder once/i);
  assert.match(
    projects,
    /project add <folder> --json[\s\S]*operation-id[\s\S]*plan-fingerprint[\s\S]*--apply/i
  );
  assert.match(projects, /description[\s\S]{0,80}optional/i);
  assert.match(projects, /match[\s\S]*not an AIOS recommendation/i);
  assert.match(
    projects,
    /no match[\s\S]*connect the existing folder[\s\S]*apply receipt selects that exact new registration[\s\S]*unchanged[\s\S]*task/i
  );
  assert.match(projects, /do not need to repeat the folder name[\s\S]*invent a description/i);
  assert.match(
    projects,
    /I found the `<slug>` folder you connected[\s\S]*one action: `<concrete action>`/i
  );
  assert.match(projects, /registration metadata matched[\s>]*this action/i);
  assert.doesNotMatch(projects, /matched from the purpose you registered/i);
  assert.doesNotMatch(projects, /--supports-conventions|--approval-binding|\bapproval[_ -]binding\b/i);
  assert.doesNotMatch(projects, /`(?:agents-md|claude-md|repository-skill)`/);
  assert.match(
    projects,
    /after direct approval[\s\S]*host adapter[\s\S]*native support internally[\s\S]*exact-resolves[\s\S]*fresh context/i
  );
  assert.match(projects, /customer does not[\s\S]*convention identifiers[\s\S]*handoff protocol/i);
  assert.match(projects, /changing the[\s\S]{0,20}directory[\s\S]*insufficient/i);
  assert.match(projects, /unsupported_by_host[\s\S]*manual-open recovery[\s\S]*no route/i);
  assert.doesNotMatch(projects, /download (?:the|this|a) (?:career|agent|recommended|particular) repository/i);
});

test("project-native probe documentation is reproducible and stays inside observed evidence", async () => {
  const support = await fs.readFile(path.join(repoRoot, "docs/client-support.md"), "utf8");
  assert.match(
    support,
    /dotaios skills probe --client codex --project-native-route --run --json --path \/path\/to\/aios --receipt \/path\/to\/receipt\.json/i
  );
  assert.match(support, /exact disposable project root[\s\S]*repository skill/i);
  assert.doesNotMatch(support, /marker from `?AGENTS\.md`? and a repository skill/i);
});

test("universal project routing ships without deferred design and output-pointer artifacts", async () => {
  const absentPaths = [
    "docs/external-project-routing/reviews.md",
    "docs/external-project-routing/spec.md",
    "docs/external-project-routing/tickets/01-generic-project-native-routing.md",
    "docs/external-project-routing/tickets/02-authoritative-output-pointer-store.md",
    "docs/external-project-routing/tickets/03-output-pointer-cli-return-path.md"
  ];
  for (const relativePath of absentPaths) {
    await assert.rejects(
      fs.access(path.join(repoRoot, relativePath)),
      { code: "ENOENT" },
      relativePath + " must remain in prior Git history, not the launch product"
    );
  }

  const context = await fs.readFile(path.join(repoRoot, "CONTEXT.md"), "utf8");
  const priorDesign = await fs.readFile(
    path.join(repoRoot, "docs", "external-capability-routing", "design.md"),
    "utf8"
  );
  assert.doesNotMatch(context, /output pointer/i);
  assert.match(priorDesign, /> \*\*Status:\*\* Proposed for review/);
  assert.doesNotMatch(priorDesign, /superseded by.*external project routing/i);
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
  const publishedVersion = "2.0.15";
  assert.equal(pkg.version, publishedVersion, "the package and public install contract must identify the release candidate");
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

  for (const relativePath of relativeFiles) {
    assert.match(
      documents[relativePath],
      /npx dotaios@2\.0\.15 setup --dry-run/,
      `${relativePath} must preview the currently published release`
    );
    assert.match(
      documents[relativePath],
      /^npx dotaios@2\.0\.15 setup$/m,
      `${relativePath} must retain an exact-version manual recovery path`
    );
    assert.doesNotMatch(
      documents[relativePath],
      /blob\/v\d+\.\d+\.\d+\//,
      `${relativePath} must not pin INSTALL to a version tag`
    );
  }
  assert.match(documents["README.md"], /open .*assistant.*paste/is, "README must lead with one assistant request");
  assert.match(
    documents["README.md"],
    /Please set up DotAIOS on my computer: https:\/\/github\.com\/filocosta46\/dotaios/,
    "README must keep the unversioned paste line"
  );
  assert.deepEqual(
    documents["README.md"].split(/(?<=\n)/).filter((line) => line.startsWith("> Please set up DotAIOS")),
    ["> Please set up DotAIOS on my computer: https://github.com/filocosta46/dotaios\n"],
    "the README hero prompt must remain byte-identical"
  );
  assert.deepEqual(
    extractAssistantInstallRefs([
      "https://github.com/filocosta46/dotaios/blob/v2.0.8/INSTALL.md",
      "https://github.com/filocosta46/dotaios/blob/feature/privacy/INSTALL.md"
    ].join("\n")),
    ["v2.0.8", "feature/privacy"],
    "assistant handoff extraction must still parse slash-containing refs"
  );
  for (const relativePath of ["README.md", "docs/friend-setup.md"]) {
    assert.equal(
      extractAssistantInstallRefs(documents[relativePath]).length,
      0,
      `${relativePath} must send the assistant to INSTALL.md on the current page, not a version tag`
    );
  }
  const technicalReference = documents["README.md"].split("## Technical reference")[1] || "";
  assert.match(technicalReference, /\[INSTALL\.md\]\(INSTALL\.md\)/, "README must point technical commands to INSTALL");
  assert.doesNotMatch(technicalReference, /```|\bnpx\b|\bnpm (?:view|pack)\b/, "README must not duplicate INSTALL commands");
  assert.match(documents["INSTALL.md"], /_npmUser\.name/, "INSTALL provenance must request the publisher it claims to display");
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
  assert.match(documents["docs/friend-setup.md"], /dotaios@2\.0\.15 setup/, "friend setup must use the currently published release");
  assert.match(documents["INSTALL.md"], /shared\s+`~\/\.agents\/skills` directory/i, "INSTALL must disclose the shared global skill surface");
  assert.match(documents["INSTALL.md"], /each attached checkout listed in `~\/\.dotaios\/projects\.json`/i, "INSTALL must cover project-local removal");
  assert.doesNotMatch(documents["INSTALL.md"], /use `\/memory-maintenance`/, "INSTALL must use cross-client skill invocation language");
  assert.match(documents["INSTALL.md"], /npx dotaios@2\.0\.15 setup/i, "INSTALL must run the currently published release");
  assert.match(documents["INSTALL.md"], /package version pinned in this guide/i, "INSTALL must explain its frozen release pin");
  assert.match(documents["INSTALL.md"], /`~\/aios\/memory\/sessions`.*private GitHub mirror/is, "INSTALL must disclose capture and sync composition");
  assert.match(documents["INSTALL.md"], /GitHub\s+repository remains.*revoke the token/is, "INSTALL must disclose remote and credential cleanup");
  assert.match(documents["INSTALL.md"], /bundled with the current package[\s\S]{0,40}does not install[\s\S]{0,10}third-party plugins/i, "INSTALL must bound the shared skill surface");
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
  // Two halves, because the first version of this guard pinned one exact
  // sentence and broke the moment that sentence was legitimately reworded.
  // What must hold is the claim, not the phrasing: the README says the
  // assistant installs Node, and never reinstates the gate #76 removed and
  // #81 accidentally restored.
  assert.match(
    unwrapped["README.md"],
    /installs it for you/i,
    "README must describe the same Node bootstrap INSTALL performs, not an older consent gate"
  );
  assert.doesNotMatch(
    unwrapped["README.md"],
    /asks? before using a supported host installation path/i,
    "README must not reinstate the ask-before-Node gate that #76 deliberately removed"
  );
  assert.match(unwrapped["INSTALL.md"], /does not use the macOS Keychain or another operating-system credential store/i, "INSTALL must not imply an OS credential store it does not use");
  assert.doesNotMatch(corpus.replace(/\s+/g, " "), /[Cc]redentials stay in the machine credential store/, "no public page may claim an OS credential store");
  assert.match(documents["INSTALL.md"], /current removal contract/i, "INSTALL must keep a removal contract without pinning a release number");
  assert.match(documents["INSTALL.md"], /doctor --path <aios-path>/i, "INSTALL must make custom-path removal inspectable");
  assert.match(documents["INSTALL.md"], /retired `~\/\.cursor\/skills`.*`~\/\.gemini\/skills`.*`~\/\.gemini\/config\/skills`/is, "INSTALL must cover retired global skill targets");
  assert.match(documents["INSTALL.md"], /\.cursor\/rules\/dotaios\.mdc.*remove only that block/is, "INSTALL must cover the retired project Cursor bridge");

  const pinnedCommandFiles = [
    "README.md",
    "INSTALL.md",
    "docs/adapters.md",
    "docs/advanced-memory.md",
    "docs/context-import.md",
    "docs/friend-setup.md",
    "docs/getting-started.md",
    "docs/google-workspace.md",
    "docs/mcp.md",
    "docs/plugin-development.md",
    "docs/schedules.md",
  ];
  for (const relativePath of pinnedCommandFiles) {
    const markdown = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(markdown, /npx -y\b/, `${relativePath} must retain npm's confirmation`);
    assert.doesNotMatch(
      markdown,
      /\bnpx\s+dotaios@latest\b/,
      `${relativePath} must not execute mutable @latest`
    );
    const commandVersions = Array.from(
      markdown.matchAll(/\bnpx\s+dotaios@([^\s`]+)/g),
      (match) => match[1]
    );
    assert.ok(commandVersions.length > 0, `${relativePath} must contain at least one pinned command`);
    assert.equal(
      commandVersions.every((version) => version === publishedVersion || version === "<version>"),
      true,
      `${relativePath} commands must name ${publishedVersion} (or the reviewed update placeholder)`
    );
  }

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
  const documents = {
    "INSTALL.md": await fs.readFile(path.join(repoRoot, "INSTALL.md"), "utf8")
  };
  const updateSections = {
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

test("macOS Node bootstrap is immutable, verified, fresh-shell safe, and approval-gated", async (t) => {
  const install = await fs.readFile(path.join(repoRoot, "INSTALL.md"), "utf8");
  const macBootstrap = install.split("   - **macOS**")[1]?.split("   - **Windows**")[0] || "";
  const unwrapped = macBootstrap.replace(/\s+/g, " ");

  assert.notEqual(macBootstrap, "", "INSTALL must keep a dedicated assistant macOS Node path");
  for (const archive of [
    "https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz",
    "https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-x64.tar.gz",
  ]) {
    assert.match(macBootstrap, new RegExp(archive.replaceAll(".", "\\.")), `${archive} must be literal`);
  }
  assert.match(
    macBootstrap,
    /https:\/\/nodejs\.org\/dist\/v24\.19\.0\/SHASUMS256\.txt/,
    "the archive must be checked against the matching official manifest"
  );
  assert.doesNotMatch(macBootstrap, /latest-v24|\$ARCH/, "fresh shells must not depend on a rolling URL or ARCH state");
  assert.match(
    macBootstrap,
    /mktemp -d "\$HOME\/\.local\/dotaios-node-download\.XXXXXXXX"/,
    "downloads must use a fresh, unpredictable, user-owned temporary root"
  );
  assert.match(
    macBootstrap,
    /mktemp -d "\$HOME\/\.local\/dotaios-node\.XXXXXXXX"/,
    "the install root must be fresh, unpredictable, and owned by the user"
  );

  const failFast = macBootstrap.indexOf("set -eu");
  const download = macBootstrap.indexOf('curl -fsSLo "$NODE_TMP/$NODE_ARCHIVE"');
  const checksum = macBootstrap.indexOf("shasum -a 256 -c -");
  const installRoot = macBootstrap.indexOf('NODE_ROOT="$(mktemp -d');
  const extraction = macBootstrap.indexOf("tar -xzf");
  assert.ok(failFast >= 0 && failFast < download, "fail-fast shell handling must be active before download");
  assert.ok(checksum >= 0, "the documented bootstrap must verify the selected archive checksum");
  assert.ok(installRoot > checksum, "checksum failure must stop before an install root is created");
  assert.ok(extraction > installRoot, "extraction must happen only after the verified install root is created");
  assert.match(macBootstrap, /tar -xzf .* -C "\$NODE_ROOT"/, "extraction must target only the fresh install root");
  assert.match(macBootstrap, /printf 'NODE_BIN=%s\/bin\\n'/, "the bootstrap must print the exact Node bin directory");
  assert.match(
    macBootstrap,
    /PATH="<exact NODE_BIN value printed above>:\$PATH" npx dotaios@2\.0\.15 setup --dry-run/,
    "later fresh-shell commands must carry the exact printed Node bin directory inline"
  );
  assert.match(unwrapped, /show .*exact .*profile.*line.*before .*chang/i, "profile persistence must be previewed");
  assert.match(unwrapped, /explicit approval/i, "profile persistence must require the person's approval");
  assert.match(unwrapped, /needs no password/i, "the bootstrap must preserve the no-password boundary");
  assert.match(unwrapped, /inside their home.*no admin writes/i, "the bootstrap must avoid administrator-owned paths");
  assert.match(unwrapped, /Do not use Homebrew/i, "the bootstrap must preserve the no-Homebrew boundary");
  assert.doesNotMatch(macBootstrap, /\bsudo\b|\bnvm install\b/i, "the bootstrap must not require admin access or nvm");

  if (process.platform !== "win32") {
    const shellBlock = macBootstrap.match(/```sh\n([\s\S]*?)\n\s*```/)?.[1] || "";
    assert.notEqual(shellBlock, "", "the documented bootstrap must remain one executable shell block");
    const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-node-mismatch-"));
    t.after(() => fs.rm(testHome, { recursive: true, force: true }));
    const controlledFailure = [
      "curl() { printf 'controlled mismatch\\n' > \"$2\"; }",
      "shasum() { return 1; }",
      shellBlock,
    ].join("\n");

    await assert.rejects(
      run("sh", ["-c", controlledFailure], {
        env: { ...process.env, HOME: testHome },
        maxBuffer: 1024 * 1024,
      }),
      "a checksum mismatch must make the documented block exit nonzero"
    );
    const localEntries = await fs.readdir(path.join(testHome, ".local"));
    assert.deepEqual(
      localEntries.filter((entry) => entry.startsWith("dotaios-node.")),
      [],
      "a checksum mismatch must not create an install root"
    );
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
  assert.doesNotMatch(
    [mcpDocumentation, adaptersDocumentation, architectureDocumentation].join("\n"),
    /MCP[\s\S]{0,100}(?:open|read|write|retrieve)[\s\S]{0,100}(?:external|existing|local) (?:folder|path)/i,
    "MCP must not imply direct access to external work-folder paths"
  );
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

// Public source may credit its author, but it must not publish private family,
// device, or machine-local identifiers from the maintainer's environment.
test("private identifier controls match the exact forbidden values", () => {
  const controls = [
    {
      label: "machine-local home",
      value: ["/Users/", "fi", "lo", "/aios/skills"].join(""),
    },
    {
      label: "private device hostname",
      value: ["iMac-di-", "Mo", "rena"].join(""),
    },
  ];

  for (const control of controls) {
    const offenders = findPrivateIdentifierOffenders([
      { relative: "control.txt", content: Buffer.from(control.value) },
    ]);
    assert.ok(
      offenders.some((offender) => offender.endsWith(`: ${control.label}`)),
      `${control.label} must match its independently assembled positive control`
    );
  }
});

test("private identifier scan covers every tracked text path", () => {
  const offenders = findPrivateIdentifierOffenders([
    {
      relative: "public/index.html",
      content: Buffer.from(["<p>", "Fi", "lippo", "</p>"].join("")),
    },
    {
      relative: "scripts/hooks/pre-push",
      content: Buffer.from(["cd /Users/", "fi", "lo"].join("")),
    },
    {
      relative: ["docs/iMac-di-", "Mo", "rena", ".md"].join(""),
      content: Buffer.alloc(0),
    },
    {
      relative: "assets/photo.bin",
      content: Buffer.from([0, ...Buffer.from(["Fi", "lippo"].join(""))]),
    },
  ]);

  assert.ok(offenders.includes("public/index.html:1: maintainer name"));
  assert.ok(offenders.includes("scripts/hooks/pre-push:1: machine-local home"));
  assert.ok(offenders.some((offender) => offender.endsWith(":path: private device hostname")));
  assert.equal(offenders.some((offender) => offender.startsWith("assets/photo.bin:")), false);
});

test("tracked public inventory fails closed outside a Git checkout", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-public-inventory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(trackedPublicEntries(root));
});

test("tracked path names stay visible when the worktree file is absent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-public-path-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await run("git", ["-C", root, "init", "--quiet"]);
  const relative = ["docs/iMac-di-", "Mo", "rena", ".md"].join("");
  const absolute = path.join(root, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, "public fixture\n");
  await run("git", ["-C", root, "add", "--", relative]);
  await fs.rm(absolute);

  const offenders = findPrivateIdentifierOffenders(await trackedPublicEntries(root));
  assert.ok(offenders.some((offender) => offender.endsWith(":path: private device hostname")));
});

test("package author exception covers only the exact author field", () => {
  const name = ["Fi", "lippo"].join("");
  const exactAuthor = findPrivateIdentifierOffenders([
    { relative: "package.json", content: Buffer.from(`  "author": "${name} Costa",`) },
  ]);
  const authorPlusLeak = findPrivateIdentifierOffenders([
    {
      relative: "package.json",
      content: Buffer.from(`  "author": "${name} Costa", "note": "${name}"`),
    },
  ]);

  assert.deepEqual(exactAuthor, []);
  assert.deepEqual(authorPlusLeak, ["package.json:1: maintainer name"]);
});

test("tracked public files contain no private maintainer identifiers", async () => {
  const offenders = findPrivateIdentifierOffenders(await trackedPublicEntries(repoRoot));
  assert.deepEqual(offenders, [], `private identifiers in tracked files:\n${offenders.join("\n")}`);
});

// Assembled from leaves so this file does not match its own stale-path scan,
// the same way the private-identifier markers above avoid matching themselves.
const INTERNAL_PROGRAMME_LEAVES = Object.freeze([
  "foundation-program",
  "plans",
  "probes",
  "benchmarks",
  "managed-skill-store-design.md",
  "managed-skill-store-architecture-review.md",
]);
const INTERNAL_PROGRAMME_DOCS = Object.freeze(
  INTERNAL_PROGRAMME_LEAVES.map((leaf) => ["docs", leaf].join("/"))
);

function readmeDocLinks(markdown) {
  return Array.from(
    markdown.matchAll(/\[[^\]]+\]\((docs\/[^)\s]*|INSTALL\.md)\)/g),
    (match) => match[1]
  );
}

test("the README guides section sends readers to user guides, not the internal programme", async () => {
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
  const links = readmeDocLinks(readme);

  assert.ok(links.length > 0, "README must link at least one guide");
  assert.ok(
    !links.includes("docs/"),
    "README must not dump readers into the docs/ directory listing"
  );
  for (const link of links) {
    assert.ok(
      !INTERNAL_PROGRAMME_DOCS.some((internal) => link === internal || link.startsWith(`${internal}/`)),
      `README links to internal programme material: ${link}`
    );
  }
  for (const guide of [
    "docs/architecture.md",
    "docs/projects.md",
    "docs/client-support.md",
    "docs/security.md",
    "docs/getting-started.md",
    "INSTALL.md",
  ]) {
    assert.ok(links.includes(guide), `README must link the ${guide} user guide`);
  }
});

test("every README documentation link resolves to a real file", async () => {
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
  for (const link of readmeDocLinks(readme)) {
    await fs.access(path.join(repoRoot, link));
  }
});

test("internal programme material is off the public guides path", async () => {
  for (const internal of INTERNAL_PROGRAMME_DOCS) {
    await assert.rejects(
      fs.access(path.join(repoRoot, internal)),
      `${internal} must move under docs/internal/`
    );
    await fs.access(path.join(repoRoot, internal.replace("docs/", "docs/internal/")));
  }
});

test("nothing still points at the old public location of the internal programme", async () => {
  const { stdout } = await run("git", ["-C", repoRoot, "ls-files", "-z"]);
  const offenders = [];
  for (const relative of stdout.split("\0").filter(Boolean)) {
    // The moved documents keep their own prose, including their own old paths.
    if (relative.startsWith("docs/internal/")) continue;
    let content;
    try {
      content = await fs.readFile(path.join(repoRoot, relative), "utf8");
    } catch {
      continue;
    }
    for (const internal of INTERNAL_PROGRAMME_DOCS) {
      const leaf = internal.slice("docs/".length);
      const literal = new RegExp(`(?<!internal/)docs/${leaf.replace(/[.]/g, "\\.")}`);
      const joined = new RegExp(`"docs"\\s*,\\s*"${leaf.replace(/[.]/g, "\\.")}"`);
      if (literal.test(content) || joined.test(content)) {
        offenders.push(`${relative} -> ${internal}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `stale internal-programme paths:\n${offenders.join("\n")}`);
});
