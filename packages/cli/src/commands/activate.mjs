import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describeFileError, pathExists, replaceFileIfUnchanged, writeFileSafe } from "../../../core/src/files.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome, isPathWithinLexically } from "../../../core/src/paths.mjs";
import {
  MANAGED_END,
  MANAGED_START,
  bridgeContent,
  bridgePath,
  findManagedBlock,
  isAgentInstalled,
  loadAgentRegistry
} from "../../../core/src/bridges.mjs";
import {
  collectSkills,
  renderResolver,
  renderSkillsIndex
} from "../../../core/src/skills.mjs";
import { readAiosConfig, updateAiosConfig } from "../../../core/src/config.mjs";
import { registerProject, resolveProjectContext } from "../../../core/src/projects.mjs";
import {
  symlinkTargets,
  retiredSymlinkTargets,
  projectSymlinkTargets
} from "../../../core/src/skill-targets.mjs";
import {
  installSymlinkSkills,
  cleanupStaleLinks,
  removeManagedSkillLinks,
  removeManagedSkillAliases,
  validateProjectPath,
  validateProjectSourcePath
} from "../../../core/src/skills-install.mjs";
import { discoverHermesConfigTargets, ensureExternalSkillsDir } from "../../../core/src/hermes-config.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { createManagedSkillStore } from "../../../core/src/managed-skill-store.mjs";

const managedStart = MANAGED_START;
const managedEnd = MANAGED_END;

// One authored remedy for a preserved bridge collision, because `setup` reports
// the same state and must not invent a second, different instruction for it.
// Without this line the only documented way forward was --overwrite, which
// replaces the file and silently stops the user's own instructions applying.
export const BRIDGE_COLLISION_REMEDY =
  "Those files already existed and were left untouched. To keep what they say and add DotAIOS below it, run `dotaios activate --merge`.";

// A blocked bridge has two very different causes and they need different
// answers. `--merge` keeps what a file already says and adds DotAIOS below it;
// it cannot help a directory that refuses to be written at all. Both activate
// and setup read this one function so a single run cannot be described two ways.
export function bridgeAttentionLines(blockedBridges) {
  const failed = blockedBridges.filter((entry) => entry.action === "failed");
  const collisions = blockedBridges.filter((entry) => entry.action !== "failed");
  const lines = [];
  if (collisions.length > 0) {
    lines.push(`Activation needs attention: ${collisions.length} client bridge collision(s).`);
    lines.push(BRIDGE_COLLISION_REMEDY);
  }
  if (failed.length > 0) {
    lines.push(`Activation needs attention: ${failed.length} client bridge(s) could not be written.`);
    for (const entry of failed) lines.push(`  ${entry.note || entry.path}`);
    lines.push("Every other client was still connected. Fix the folders above, then run `dotaios activate` again.");
  }
  return lines;
}

export async function activateCommand(args, { lifecycle = {} } = {}) {
  if (hasHelpFlag(args)) {
    printActivateHelp();
    return;
  }

  const options = parseOptions(args);
  if (options.pruneAliases && !options.dryRun && !options.project) {
    throw new Error(
      "Global skill alias deletion requires a ManagedSkillStore removal proof. "
      + "Use --dry-run to inspect candidates; project-local aliases remain a separate attach scope."
    );
  }
  const aiosPath = resolvePath(options.path || defaultAiosPath());
  const homePath = resolvePath(options.home || os.homedir());
  const [realHomePath, realUserHomePath] = await Promise.all([
    realpathThroughExistingAncestor(homePath),
    realpathThroughExistingAncestor(os.homedir())
  ]);
  if (realHomePath === realUserHomePath && await isTemporaryAiosPath(aiosPath)) {
    throw new Error("Refusing to connect a temporary AIOS path to the real home; use a permanent AIOS folder.");
  }
  await ensureAiosFolder(aiosPath);
  if (!options.dryRun) {
    await fs.mkdir(homePath, { recursive: true });
  }

  const config = await readAiosConfig(aiosPath);
  const skillsFirst = options.skillsFirst ?? Boolean(config.skills_first);
  const configPatch = activationConfigPatch(options);

  // A real activation persists an explicit preference. Dry-run uses the
  // requested value for its preview without changing aios.json.
  if (configPatch) {
    await updateAiosConfig(aiosPath, configPatch);
    await lifecycle.afterConfigPersisted?.({ aiosPath, configPatch });
  }

  // Detection must be observed before reconciliation creates native projection
  // directories. A projected path is evidence of projection only; it must never
  // bootstrap itself into a claim that the corresponding client is installed.
  const detectedAgentNames = await detectInstalledAgentNames(aiosPath, homePath, options);

  // Refresh before writing bridges. Dry-run renders the same catalog in memory
  // so its bridge preview is current without touching INDEX.md or RESOLVER.md.
  // Skill projection runs before any bridge is written, so an unwritable
  // projection target used to strand every client — including the ones whose
  // own directories were perfectly fine. The catalog it produces is computable
  // in memory, so fall back to that and let the bridges through.
  let skillsIndex;
  let skillsCatalog;
  let skillStoreFailure = null;
  try {
    ({ skillsIndex, skillsCatalog } = options.dryRun
      ? await previewSkillsIndex(aiosPath)
      : await reconcileGlobalSkillStore(aiosPath, homePath));
  } catch (error) {
    skillStoreFailure = error;
    ({ skillsIndex, skillsCatalog } = await previewSkillsIndex(aiosPath));
  }

  // Setup uses preserve mode as a compare-and-publish boundary. If another
  // writer won either catalog path with different bytes, stop before writing
  // any client bridge (especially a --skills-first bridge that would inline
  // untrusted collision bytes).
  if (!options.dryRun && skillsIndex.conflicts.length > 0) {
    const results = skillsIndex.results;
    printResults("DotAIOS activation stopped", results);
    console.error(
      `Activation needs attention: preserved ${skillsIndex.conflicts.length} skill catalog collision(s); no client bridges were changed.`
    );
    process.exitCode = 1;
    return {
      detectedClientCount: 0,
      configuredContextCount: 0,
      blockedContextCount: 0,
      blockedCatalogCount: skillsIndex.conflicts.length,
      results
    };
  }

  const global = await createGlobalBridges(
    aiosPath,
    homePath,
    options,
    skillsFirst,
    skillsCatalog,
    lifecycle,
    detectedAgentNames
  );
  const results = [...global.results];
  const projectBlockedBridges = [];

  if (options.project) {
    const projectResults = await createProjectBridges(
      aiosPath,
      resolvePath(options.project),
      options,
      lifecycle
    );
    results.push(...projectResults);
    if (!isConfiguredBridgeAction(projectResults[0]?.action)) {
      projectBlockedBridges.push(projectResults[0] ?? { action: "failed", path: options.project });
    }
  }

  printResults("DotAIOS activated", results);
  const refreshAction = options.dryRun ? "would refresh" : "refreshed";
  console.log(`[${refreshAction}] ${skillsIndex.path} and ${skillsIndex.resolverPath} (${skillsIndex.count} workflow(s) indexed)`);
  if (skillsIndex.unresolvedProjections?.length > 0) {
    console.warn(
      `[skills] preserved ${skillsIndex.unresolvedProjections.length} unmanaged native projection collision(s); run \`dotaios skills inventory\` to review adoption candidates.`
    );
  }
  if (skillsFirst) {
    const verb = options.dryRun ? "would inline" : "inline";
    console.log(`[skills-first] bridge files ${verb} the current skill catalog.`);
  }

  if (global.installedCount === 0) {
    console.log("\nNo known AI tools were detected on this machine.");
    console.log("DotAIOS connects a tool automatically once it is installed — re-run `dotaios activate` then.");
    console.log("To connect every known tool anyway, run `dotaios activate --all`.");
  }

  console.log("\nUsing another local AI tool that can read files? Paste this line into it:");
  console.log(`  Read ${path.join(aiosPath, "AGENTS.md")} first and follow it.`);
  console.log("Browser chats cannot open that path. Attach AGENTS.md or paste a reviewed `dotaios brief --compact` instead.");

  if (!options.project) {
    console.log("\nFor Cursor project rules, run `dotaios attach <project-dir>` inside a project.");
  }

  const blockedBridges = [...global.blockedBridges, ...projectBlockedBridges];
  const blockedContextCount = blockedBridges.length;
  const blockedHermesCount = results.filter((entry) => entry.action === "hermes:conflict").length;
  if (blockedContextCount > 0) {
    process.exitCode = 1;
    for (const line of bridgeAttentionLines(blockedBridges)) console.error(line);
  }
  if (skillStoreFailure) {
    process.exitCode = 1;
    console.error(
      `Activation needs attention: managed skill links could not be published. ${describeFileError(skillStoreFailure)}`
    );
    console.error("The client bridges above were still written. Fix that folder, then run `dotaios activate` again.");
  }
  if (blockedHermesCount > 0) {
    process.exitCode = 1;
    console.error(
      `Activation needs attention: preserved ${blockedHermesCount} concurrent Hermes config edit(s). Re-run activation after reviewing the file.`
    );
  }

  return {
    detectedClientCount: global.installedCount,
    configuredContextCount: global.configuredContextCount,
    blockedContextCount,
    blockedHermesCount,
    blockedCatalogCount: 0,
    results
  };
}

async function reconcileGlobalSkillStore(aiosPath, homePath) {
  const store = createManagedSkillStore({ aiosPath, homePath });
  const proof = await store.reconcile();
  const applied = await store.reconcile({
    apply: true,
    operationId: proof.operation_id,
    planFingerprint: proof.plan_fingerprint
  });
  return {
    skillsIndex: {
      path: path.join(aiosPath, "skills", "INDEX.md"),
      resolverPath: path.join(aiosPath, "skills", "RESOLVER.md"),
      count: applied.skill_count,
      conflicts: [],
      unresolvedProjections: proof.unresolved,
      results: applied.repairs.map((repair) => ({
        action: repair.kind === "projection" ? "linked" : "updated",
        path: repair.relative_path || repair.name
      }))
    },
    skillsCatalog: {
      indexText: applied.catalog.index_text,
      resolverText: applied.catalog.resolver_text
    }
  };
}

export async function attachCommand(args) {
  if (hasHelpFlag(args)) {
    printAttachHelp();
    return;
  }

  const options = parseOptions(args);
  const [projectArg] = options.positionals;
  const aiosPath = resolvePath(options.path || defaultAiosPath());
  const projectPath = resolvePath(options.project || projectArg || process.cwd());
  await ensureAiosFolder(aiosPath);

  const results = await createProjectBridges(aiosPath, projectPath, options);
  printResults("DotAIOS attached", results);
  if (!isConfiguredBridgeAction(results[0]?.action)) {
    process.exitCode = 1;
    console.error("Attach needs attention: the project bridge was preserved because it could not be safely configured.");
  }
}

function parseOptions(args = []) {
  const options = {
    all: false,
    dryRun: false,
    home: null,
    merge: false,
    overwrite: false,
    pruneAliases: false,
    path: null,
    positionals: [],
    project: null,
    skillsFirst: undefined
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all") {
      options.all = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--merge") {
      options.merge = true;
    } else if (arg === "--overwrite") {
      options.overwrite = true;
    } else if (arg === "--prune-aliases") {
      options.pruneAliases = true;
    } else if (arg === "--skills-first") {
      options.skillsFirst = true;
    } else if (arg === "--no-skills-first") {
      options.skillsFirst = false;
    } else if (arg === "--home") {
      options.home = readOptionValue(args, index, "--home");
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--project") {
      options.project = readOptionValue(args, index, "--project");
      index += 1;
    } else {
      options.positionals.push(arg);
    }
  }

  return options;
}

export function plannedActivationConfigPatch(args = []) {
  return activationConfigPatch(parseOptions(args));
}

function activationConfigPatch(options) {
  if (options.dryRun || options.skillsFirst === undefined) return null;
  return { skills_first: options.skillsFirst };
}

function printActivateHelp() {
  console.log(`Usage:
  dotaios activate [options]

Options:
  --path <dir>          Use an AIOS folder other than ~/aios
  --home <dir>          Write global agent bridges somewhere other than your home
  --project <dir>       Also attach DotAIOS to a project folder
  --all                 Connect every known AI tool, even ones not detected yet
  --dry-run             Show what would be written without changing files
  --merge               Keep an existing bridge file and add DotAIOS below it
  --overwrite           Replace existing unmanaged bridge files
  --prune-aliases       Preview exact global aliases; real global prune refuses without a store proof
  --skills-first        Inline the skill catalog (INDEX+RESOLVER) into every bridge
                        file so agents that don't follow file refs still see it.
                        Persists into aios.json; re-run activate without the flag
                        to keep it. Use --no-skills-first to switch back.
`);
}

function printAttachHelp() {
  console.log(`Usage:
  dotaios attach [project-dir] [options]

Options:
  --path <dir>     Use an AIOS folder other than ~/aios
  --project <dir>  Attach this project directory explicitly
  --dry-run        Show what would be written without changing files
  --merge          Keep an existing bridge file and add DotAIOS below it
  --overwrite      Replace existing unmanaged bridge files
`);
}

async function createGlobalBridges(
  aiosPath,
  homePath,
  options,
  skillsFirst = false,
  skillsCatalog,
  lifecycle = {},
  detectedAgentNames = new Set()
) {
  const registry = await loadAgentRegistry(aiosPath);
  const results = [];
  let installedCount = 0;
  let configuredContextCount = 0;
  const blockedBridges = [];
  const installedAgentNames = new Set();

  for (const agent of registry) {
    const destination = bridgePath(homePath, agent) || path.join(homePath, agent.detect);
    const installed = detectedAgentNames.has(agent.name.toLowerCase());

    if (!installed) {
      results.push({ action: "skipped", path: destination, note: `${agent.name} not detected on this machine` });
      continue;
    }
    installedCount += 1;
    installedAgentNames.add(agent.name.toLowerCase());

    if (!agent.bridge) {
      results.push({
        action: "detected",
        path: destination,
        note: `${agent.name} has no bridge file; its skills use the native runtime configuration`
      });
      continue;
    }

    // One client's directory must not decide the fate of the others. Before
    // this, the first rejection unwound the whole command: the clients after it
    // in registry order were never attempted, and the ones already written were
    // never even reported, because printResults runs downstream of the throw.
    let result;
    try {
      result = await writeManagedFile(
        destination,
        await bridgeContent(agent, aiosPath, { skillsFirst, skillsCatalog }),
        {
          ...options,
          boundaryRoot: homePath,
          beforeReplace: lifecycle.beforeBridgeReplace,
          beforePublish: lifecycle.beforeBridgePublish,
          beforeCommit: lifecycle.beforeBridgeCommit
        }
      );
    } catch (error) {
      result = { action: "failed", path: destination, note: `${agent.name}: ${error.message}` };
    }
    results.push(result);
    if (isConfiguredBridgeAction(result.action)) {
      configuredContextCount += 1;
    } else {
      blockedBridges.push(result);
    }
  }

  const skills = await installAllSkills(
    aiosPath,
    homePath,
    options,
    registry,
    lifecycle
  );
  return {
    results: [...results, ...skills],
    installedCount,
    configuredContextCount,
    blockedBridges
  };
}

async function detectInstalledAgentNames(aiosPath, homePath, options) {
  const registry = await loadAgentRegistry(aiosPath);
  const detected = new Set();
  for (const agent of registry) {
    if (options.all || await isAgentInstalled(homePath, agent)) {
      detected.add(agent.name.toLowerCase());
    }
  }
  return detected;
}

function isConfiguredBridgeAction(action) {
  // "appended" belongs here: the client really is configured afterwards. The
  // user's own instructions were kept and the DotAIOS block was added below
  // them, so this is a success, not a collision to report.
  return [
    "created",
    "updated",
    "unchanged",
    "appended",
    "would create",
    "would update",
    "would append"
  ].includes(action);
}

async function previewSkillsIndex(aiosPath) {
  const skills = await collectSkills(aiosPath);
  return {
    skillsIndex: {
      path: path.join(aiosPath, "skills", "INDEX.md"),
      resolverPath: path.join(aiosPath, "skills", "RESOLVER.md"),
      count: skills.length,
      conflicts: []
    },
    skillsCatalog: {
      indexText: renderSkillsIndex(skills),
      resolverText: renderResolver(skills)
    }
  };
}

// Install DotAIOS skills natively into each documented client directory plus
// the shared Agent Skills root, then register the source dir in Hermes config.
async function installAllSkills(
  aiosPath,
  homePath,
  options,
  registry,
  lifecycle = {}
) {
  const aiosSkillsDir = path.join(aiosPath, "skills");
  if (!await pathExists(aiosSkillsDir)) return [];

  const results = [];
  for (const target of retiredSymlinkTargets(registry)) {
    const targetDir = path.join(homePath, target.dir);
    // Global projection deletion belongs to ManagedSkillStore's exact
    // receipt/proof transaction. Keep this legacy path zero-write so activate
    // cannot unlink a projection outside the store lock.
    if (options.dryRun) {
      results.push(...await removeManagedSkillLinks({
        aiosPath, targetDir, dryRun: true
      }));
    }
  }
  // Every symlink target, not just the detected ones: the real activation
  // reconciles all of them through ManagedSkillStore, so narrowing the preview
  // here made --dry-run promise less than the run writes.
  for (const target of symlinkTargets(registry)) {
    const targetDir = path.join(homePath, target.dir);
    // A real activation has already reconciled canonical projections through
    // ManagedSkillStore. Keep the legacy installer only for zero-write preview;
    // the remaining passes own alias/stale cleanup rather than publication.
    if (options.dryRun) {
      results.push(...await installSymlinkSkills({
        aiosPath, targetDir, dryRun: true, overwrite: false
      }));
    }
    if (options.dryRun && options.pruneAliases) {
      results.push(...await removeManagedSkillAliases({
        aiosPath, targetDir, dryRun: true
      }));
    }
    if (options.dryRun) {
      results.push(...await cleanupStaleLinks({ aiosPath, targetDir, dryRun: true }));
    }
  }

  for (const target of await discoverHermesConfigTargets(homePath, registry)) {
    const { configPath, key } = target;
    const r = await ensureExternalSkillsDir({
      configPath,
      skillsPath: aiosSkillsDir,
      key,
      dryRun: options.dryRun,
      createMissing: true,
      boundaryRoot: homePath,
      beforeReplace: lifecycle.beforeHermesReplace,
      beforePublish: lifecycle.beforeHermesPublish,
      beforeCommit: lifecycle.beforeHermesCommit,
      beforeRename: lifecycle.beforeHermesRename
    });
    results.push({ action: `hermes:${r.action}`, path: configPath, note: r.reason });
  }
  return results;
}

async function createProjectBridges(aiosPath, projectPath, options, lifecycle = {}) {
  let project = await resolveProjectContext({
    aiosPath,
    homePath: resolvePath(options.home || os.homedir()),
    cwd: projectPath
  });
  if (!project) {
    const registration = await registerProject({
      aiosPath,
      homePath: resolvePath(options.home || os.homedir()),
      projectPath,
      apply: !options.dryRun
    });
    project = {
      id: registration.id,
      slug: registration.slug,
      project: registration.slug,
      projectPath,
      registered: registration.applied
    };
  }
  const registry = await loadAgentRegistry(aiosPath);
  const bridges = [
    await writeManagedFile(path.join(projectPath, "AGENTS.md"), projectAgentsBridge(aiosPath, project, resolvePath(options.home || os.homedir())), {
      ...options,
      projectRoot: projectPath,
      beforeReplace: lifecycle.beforeBridgeReplace,
      beforePublish: lifecycle.beforeBridgePublish,
      beforeCommit: lifecycle.beforeBridgeCommit
    }),
    await removeRetiredManagedFile(
      path.join(projectPath, ".cursor", "rules", "dotaios.mdc"),
      { ...options, projectRoot: projectPath }
    )
  ];
  const skills = await propagateProjectSkills(projectPath, options, registry);
  return [...bridges, skills];
}

async function propagateProjectSkills(projectPath, options, registry) {
  const skillsDir = path.join(projectPath, "skills");
  const symlinkTargetsForProject = projectSymlinkTargets(registry);
  const retiredTargetsForProject = retiredSymlinkTargets(registry);
  const details = [];
  const sourceSafety = await validateProjectSourcePath({
    projectRoot: projectPath,
    sourcePath: skillsDir
  });
  if (!sourceSafety.safe) {
    return { action: "project-skills:unsafe-source", path: skillsDir, note: sourceSafety.reason };
  }
  const skillsDirectoryExists = await isDirectory(skillsDir);
  const skills = skillsDirectoryExists ? await collectSkills(projectPath) : [];

  for (const target of retiredTargetsForProject) {
    const targetDir = path.join(projectPath, target.dir);
    const safety = await validateProjectPath({ projectRoot: projectPath, targetPath: targetDir });
    if (!safety.safe) {
      details.push({
        action: "project-skills:unsafe-retired-target",
        path: targetDir,
        note: safety.reason
      });
      continue;
    }
    details.push(...await removeManagedSkillLinks({
      sourceDir: skillsDir,
      targetDir,
      dryRun: options.dryRun
    }));
    details.push(...await cleanupStaleLinks({
      sourceDir: skillsDir,
      targetDir,
      projectRoot: projectPath,
      dryRun: options.dryRun
    }));
  }

  for (const target of symlinkTargetsForProject) {
    const targetDir = path.join(projectPath, target.dir);
    const safety = await validateProjectPath({ projectRoot: projectPath, targetPath: targetDir });
    if (!safety.safe) {
      details.push({ action: "project-skills:unsafe-target", path: targetDir, note: safety.reason });
      continue;
    }
    if (skills.length === 0) {
      details.push(...await cleanupStaleLinks({
        sourceDir: skillsDir,
        targetDir,
        projectRoot: projectPath,
        dryRun: options.dryRun
      }));
      continue;
    }
    details.push(...await installSymlinkSkills({
      sourceDir: skillsDir,
      targetDir,
      projectRoot: projectPath,
      dryRun: options.dryRun,
      overwrite: options.overwrite
    }));
    if (options.pruneAliases) {
      details.push(...await removeManagedSkillAliases({
        sourceDir: skillsDir,
        targetDir,
        dryRun: options.dryRun
      }));
    }
    details.push(...await cleanupStaleLinks({
      sourceDir: skillsDir,
      targetDir,
      projectRoot: projectPath,
      dryRun: options.dryRun
    }));
  }

  if (skills.length === 0) {
    return {
      action: "project-skills",
      path: skillsDir,
      note: skillsDirectoryExists
        ? "checked project skills/ with no readable SKILL.md entries"
        : "checked missing project skills/ and cleaned owned links"
    };
  }

  const linked = details.filter((result) => ["linked", "already-linked", "would link"].includes(result.action)).length;
  const verb = skills.length === 0
    ? "checked"
    : (options.dryRun ? "would propagate" : "propagated");
  const skillLabel = skills.length === 0
    ? (skillsDirectoryExists ? "no readable project skills" : "no project skills directory")
    : skills.length === 1
    ? `skill ${skills[0].name}`
    : `${skills.length} skill(s)`;
  const targetPaths = symlinkTargetsForProject.map((target) => target.dir);
  const targetLabel = targetPaths.length > 0 ? targetPaths.join(", ") : "no registered targets";
  const unsafe = details.filter((result) =>
    result.action === "skipped-unsafe-target"
    || result.action.startsWith("project-skills:unsafe-")
  );
  const safetyNote = unsafe.length > 0
    ? `; ${unsafe.length} unsafe target(s) skipped`
    : "";
  const note = `${verb} ${skillLabel} to ${targetLabel}; ${linked} symlink action(s)${safetyNote}`;
  return { action: "project-skills", path: skillsDir, note };
}

async function isDirectory(value) {
  try {
    return (await fs.stat(value)).isDirectory();
  } catch {
    return false;
  }
}

async function writeManagedFile(
  destination,
  content,
  {
    dryRun = false,
    merge = false,
    overwrite = false,
    projectRoot = null,
    boundaryRoot = projectRoot,
    beforeReplace = null,
    beforePublish = null,
    beforeCommit = null
  } = {}
) {
  if (projectRoot) {
    const safety = await validateProjectPath({ projectRoot, targetPath: destination });
    if (!safety.safe) {
      return { action: "unsafe-target", path: destination, note: safety.reason };
    }
  }
  const stats = await lstatIfPresent(destination);
  if (stats && (!stats.isFile() || stats.isSymbolicLink())) {
    return { action: "unsafe-target", path: destination, note: "existing bridge path is not a regular file" };
  }

  if (!stats) {
    if (!dryRun) {
      await writeFileSafe(destination, content, "preserve", { boundaryRoot });
    }
    return { action: dryRun ? "would create" : "created", path: destination };
  }

  const current = await fs.readFile(destination, "utf8");
  const existingBlock = findManagedBlock(current);

  // No usable managed block: any DotAIOS marker is ambiguous and always fails
  // closed. A truly unmanaged file can be replaced only with explicit overwrite.
  if (!existingBlock) {
    const hasManagedMarker = current.includes(managedStart) || current.includes(managedEnd);
    if (hasManagedMarker) {
      return {
        action: "kept",
        path: destination,
        note: "managed markers are malformed; existing file kept"
      };
    }
    if (!overwrite) {
      // The default has always been to leave a file DotAIOS does not own
      // completely alone, and that promise stays. `--merge` is the explicit
      // opt-in for the common case below.
      //
      // Appending is only ever offered for the user's OWN home. A project
      // bridge lives in a repository that may be shared, reviewed, and
      // committed by other people, so a foreign one always fails closed.
      if (!merge || projectRoot) {
        return { action: "kept", path: destination, note: "existing unmanaged file" };
      }
      // Anyone who has ever asked their assistant to remember a preference
      // already has one of these files. Refusing to touch it left the most
      // common user in the worst state available: skills linked, exit 0, no
      // error, and their assistant never told who they are. The managed block
      // is delimited, so appending it below their own text loses nothing and
      // stays precisely removable. Replacing the file outright is still an
      // explicit --overwrite decision.
      const appendBlock = findManagedBlock(content);
      if (!appendBlock) {
        throw new Error("generated bridge content is missing its managed block");
      }
      if (dryRun) {
        return { action: "would append", path: destination };
      }
      const separator = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
      const appended = `${current}${separator}${appendBlock.text}\n`;
      const result = await replaceFileIfUnchanged(destination, current, appended, {
        boundaryRoot,
        beforeReplace,
        beforePublish,
        beforeCommit,
        expectedStats: stats,
        mode: stats.mode & 0o777
      });
      return result.replaced
        ? {
            action: "appended",
            path: destination,
            note: "added the DotAIOS block below your existing instructions"
          }
        : concurrentBridgeResult(destination, result.preservedPath);
    }
    if (dryRun) {
      return { action: "would update", path: destination };
    }
    const replacement = await replaceFileIfUnchanged(destination, current, content, {
      boundaryRoot,
      beforeReplace,
      beforePublish,
      beforeCommit,
      expectedStats: stats,
      mode: stats.mode & 0o777
    });
    return replacement.replaced
      ? updatedBridgeResult(destination, replacement.preservedPath)
      : concurrentBridgeResult(destination, replacement.preservedPath);
  }

  // Managed block present: replace only the block. Every byte the user wrote
  // outside the markers survives untouched.
  const generatedBlock = findManagedBlock(content);
  if (!generatedBlock) {
    throw new Error("generated bridge content is missing its managed block");
  }
  const next = `${current.slice(0, existingBlock.start)}${generatedBlock.text}${current.slice(existingBlock.end)}`;

  // Nothing to do when the block is already current. Rewriting an identical
  // file would only churn mtimes and litter a pointless backup beside it.
  if (next === current) {
    return { action: "unchanged", path: destination };
  }

  if (dryRun) {
    return { action: "would update", path: destination };
  }

  const replacement = await replaceFileIfUnchanged(destination, current, next, {
    boundaryRoot,
    beforeReplace,
    beforePublish,
    beforeCommit,
    expectedStats: stats,
    mode: stats.mode & 0o777
  });
  return replacement.replaced
    ? updatedBridgeResult(destination, replacement.preservedPath)
    : concurrentBridgeResult(destination, replacement.preservedPath);
}

function updatedBridgeResult(destination, preservedPath) {
  return {
    action: "updated",
    path: destination,
    ...(preservedPath ? { note: `preserved the previous file at ${path.basename(preservedPath)}` } : {})
  };
}

function concurrentBridgeResult(destination, preservedPath = null) {
  return {
    action: "conflict",
    path: destination,
    note: `bridge changed during activation; left the concurrent edit untouched${preservedPath ? ` and preserved the previous file at ${path.basename(preservedPath)}` : ""}`
  };
}

async function lstatIfPresent(destination) {
  try {
    return await fs.lstat(destination);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeRetiredManagedFile(destination, { dryRun = false, projectRoot = null } = {}) {
  if (projectRoot) {
    const safety = await validateProjectPath({ projectRoot, targetPath: destination });
    if (!safety.safe) {
      return { action: "unsafe-target", path: destination, note: safety.reason };
    }
  }

  let stat;
  try {
    stat = await fs.lstat(destination);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { action: "absent", path: destination, note: "retired managed file not present" };
    }
    throw error;
  }

  if (!stat.isFile()) {
    return { action: "kept", path: destination, note: "retired path is not a regular file" };
  }
  const current = await fs.readFile(destination, "utf8");
  const managedBlock = findManagedBlock(current);
  if (!managedBlock) {
    const hasManagedMarker = current.includes(managedStart) || current.includes(managedEnd);
    return {
      action: "kept",
      path: destination,
      note: hasManagedMarker ? "managed markers are malformed; existing file kept" : "existing unmanaged file"
    };
  }
  let remainder = `${current.slice(0, managedBlock.start)}${current.slice(managedBlock.end)}`;
  remainder = remainder.replace(
    /^---\r?\ndescription: DotAIOS personal context\r?\nglobs:\r?\nalwaysApply: true\r?\n---\r?\n*/u,
    ""
  );

  if (!remainder.trim()) {
    if (!dryRun) await fs.unlink(destination);
    return { action: dryRun ? "would remove" : "removed", path: destination };
  }
  if (!dryRun) await fs.writeFile(destination, remainder);
  return {
    action: dryRun ? "would update" : "updated",
    path: destination,
    note: "removed retired DotAIOS managed block; preserved surrounding content"
  };
}

function projectAgentsBridge(aiosPath, project, homePath) {
  return bridgeFile("DotAIOS Project Bridge", [
    `This checkout is project \`${project.slug}\` (id \`${project.id}\`).`,
    `At session start run \`dotaios brief --compact --project ${project.slug}\`.`,
    ...(project.registered ? [] : ["This checkout is not in the project catalog yet; run `dotaios project add <repo-path>` to enable automatic writer attribution."]),
    "",
    `Before personal recommendations or cross-project planning, read: ${portableAiosPointer(aiosPath, homePath)}`,
    "",
    "Keep project-specific instructions in this file short. Durable personal context belongs in DotAIOS."
  ]);
}

// This bridge lands in a shared checkout that teammates clone, so an absolute
// path would both publish the author's username and point every other reader
// at a directory that does not exist on their machine.
export function portableAiosPointer(aiosPath, homePath = os.homedir()) {
  const relative = path.relative(homePath, aiosPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return path.join(aiosPath, "AGENTS.md");
  }
  return `~/${path.join(relative, "AGENTS.md")}`;
}

function bridgeFile(title, lines) {
  return [
    `# ${title}`,
    "",
    managedStart,
    ...lines,
    managedEnd,
    ""
  ].join("\n");
}

function resolvePath(value) {
  return path.resolve(expandHome(value));
}

async function isTemporaryAiosPath(aiosPath) {
  const lexicalPath = path.resolve(aiosPath);
  const lexicalTempRoot = path.resolve(os.tmpdir());
  const [realPath, realTempRoot] = await Promise.all([
    realpathThroughExistingAncestor(lexicalPath),
    realpathThroughExistingAncestor(lexicalTempRoot)
  ]);

  // Check both representations. The lexical check catches a direct /tmp path,
  // while the realpath check catches a permanent-looking alias that points into
  // a temporary activation directory. We intentionally reject any path inside
  // the OS temp root, not only names matching one historical temp prefix.
  return isPathWithinLexically(lexicalTempRoot, lexicalPath) || isPathWithinLexically(realTempRoot, realPath);
}

async function realpathThroughExistingAncestor(value) {
  let current = path.resolve(value);
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function printResults(title, results) {
  console.log(`\n${title}`);
  for (const result of results) {
    const note = result.note ? ` (${result.note})` : "";
    console.log(`[${result.action}] ${result.path}${note}`);
  }
}
