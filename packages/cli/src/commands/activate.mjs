import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../../../core/src/files.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import {
  MANAGED_END,
  MANAGED_START,
  bridgeContent,
  bridgePath,
  isAgentInstalled,
  loadAgentRegistry
} from "../../../core/src/bridges.mjs";
import {
  collectSkills,
  renderResolver,
  renderSkillsIndex,
  writeSkillsIndex
} from "../../../core/src/skills.mjs";
import { readAiosConfig, updateAiosConfig } from "../../../core/src/config.mjs";
import {
  symlinkTargets,
  retiredSymlinkTargets,
  projectSymlinkTargets,
  projectHermesConfigTargets
} from "../../../core/src/skill-targets.mjs";
import {
  installSymlinkSkills,
  cleanupStaleLinks,
  removeManagedSkillLinks,
  removeManagedSkillAliases,
  validateProjectPath,
  validateProjectSourcePath
} from "../../../core/src/skills-install.mjs";
import { discoverHermesConfigPaths, ensureExternalSkillsDir } from "../../../core/src/hermes-config.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const managedStart = MANAGED_START;
const managedEnd = MANAGED_END;

export async function activateCommand(args) {
  if (hasHelpFlag(args)) {
    printActivateHelp();
    return;
  }

  const options = parseOptions(args);
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

  const config = await readAiosConfig(aiosPath);
  const skillsFirst = options.skillsFirst ?? Boolean(config.skills_first);

  // A real activation persists an explicit preference. Dry-run uses the
  // requested value for its preview without changing aios.json.
  if (!options.dryRun && options.skillsFirst !== undefined) {
    await updateAiosConfig(aiosPath, { skills_first: options.skillsFirst });
  }

  // Refresh before writing bridges. Dry-run renders the same catalog in memory
  // so its bridge preview is current without touching INDEX.md or RESOLVER.md.
  const { skillsIndex, skillsCatalog } = options.dryRun
    ? await previewSkillsIndex(aiosPath)
    : { skillsIndex: await writeSkillsIndex(aiosPath), skillsCatalog: undefined };

  const global = await createGlobalBridges(
    aiosPath,
    homePath,
    options,
    skillsFirst,
    skillsCatalog
  );
  const results = [...global.results];

  if (options.project) {
    results.push(...await createProjectBridges(aiosPath, resolvePath(options.project), options));
  }

  printResults("DotAIOS activated", results);
  const refreshAction = options.dryRun ? "would refresh" : "refreshed";
  console.log(`[${refreshAction}] ${skillsIndex.path} and ${skillsIndex.resolverPath} (${skillsIndex.count} workflow(s) indexed)`);
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

  return {
    detectedClientCount: global.installedCount,
    configuredContextCount: global.configuredContextCount,
    results
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
}

function parseOptions(args = []) {
  const options = {
    all: false,
    dryRun: false,
    home: null,
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

function printActivateHelp() {
  console.log(`Usage:
  dotaios activate [options]

Options:
  --path <dir>          Use an AIOS folder other than ~/aios
  --home <dir>          Write global agent bridges somewhere other than your home
  --project <dir>       Also attach DotAIOS to a project folder
  --all                 Connect every known AI tool, even ones not detected yet
  --dry-run             Show what would be written without changing files
  --overwrite           Replace existing unmanaged bridge files
  --prune-aliases       Remove only exact DotAIOS frontmatter alias links
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
  --overwrite      Replace existing unmanaged bridge files
`);
}

async function createGlobalBridges(
  aiosPath,
  homePath,
  options,
  skillsFirst = false,
  skillsCatalog
) {
  const registry = await loadAgentRegistry(aiosPath);
  const results = [];
  let installedCount = 0;
  let configuredContextCount = 0;

  for (const agent of registry) {
    const destination = bridgePath(homePath, agent) || path.join(homePath, agent.detect);
    const installed = options.all || await isAgentInstalled(homePath, agent);

    if (!installed) {
      results.push({ action: "skipped", path: destination, note: `${agent.name} not detected on this machine` });
      continue;
    }
    installedCount += 1;

    if (!agent.bridge) {
      results.push({
        action: "detected",
        path: destination,
        note: `${agent.name} has no bridge file; its skills use the native runtime configuration`
      });
      continue;
    }

    const result = await writeManagedFile(
      destination,
      await bridgeContent(agent, aiosPath, { skillsFirst, skillsCatalog }),
      options
    );
    results.push(result);
    if (["created", "updated", "would create", "would update"].includes(result.action)) {
      configuredContextCount += 1;
    }
  }

  const skills = await installAllSkills(aiosPath, homePath, options, registry);
  return { results: [...results, ...skills], installedCount, configuredContextCount };
}

async function previewSkillsIndex(aiosPath) {
  const skills = await collectSkills(aiosPath);
  return {
    skillsIndex: {
      path: path.join(aiosPath, "skills", "INDEX.md"),
      resolverPath: path.join(aiosPath, "skills", "RESOLVER.md"),
      count: skills.length
    },
    skillsCatalog: {
      indexText: renderSkillsIndex(skills),
      resolverText: renderResolver(skills)
    }
  };
}

// Install DotAIOS skills natively into each documented client directory plus
// the shared Agent Skills root, then register the source dir in Hermes config.
async function installAllSkills(aiosPath, homePath, options, registry) {
  const aiosSkillsDir = path.join(aiosPath, "skills");
  if (!await pathExists(aiosSkillsDir)) return [];

  const results = [];
  for (const target of retiredSymlinkTargets(registry)) {
    const targetDir = path.join(homePath, target.dir);
    results.push(...await removeManagedSkillLinks({
      aiosPath, targetDir, dryRun: options.dryRun
    }));
  }
  for (const target of symlinkTargets(registry)) {
    const targetDir = path.join(homePath, target.dir);
    results.push(...await installSymlinkSkills({
      aiosPath, targetDir, dryRun: options.dryRun, overwrite: options.overwrite
    }));
    if (options.pruneAliases) {
      results.push(...await removeManagedSkillAliases({
        aiosPath, targetDir, dryRun: options.dryRun
      }));
    }
    results.push(...await cleanupStaleLinks({ aiosPath, targetDir, dryRun: options.dryRun }));
  }

  for (const configPath of await discoverHermesConfigPaths(homePath, registry)) {
    const r = await ensureExternalSkillsDir({
      configPath,
      skillsPath: aiosSkillsDir,
      dryRun: options.dryRun,
      createMissing: true
    });
    results.push({ action: `hermes:${r.action}`, path: configPath, note: r.reason });
  }
  return results;
}

async function createProjectBridges(aiosPath, projectPath, options) {
  const registry = await loadAgentRegistry(aiosPath);
  const bridges = await Promise.all([
    writeManagedFile(path.join(projectPath, "AGENTS.md"), projectAgentsBridge(aiosPath), {
      ...options,
      projectRoot: projectPath
    }),
    writeManagedFile(path.join(projectPath, ".cursor", "rules", "dotaios.mdc"), cursorRule(aiosPath), {
      ...options,
      projectRoot: projectPath
    })
  ]);
  const skills = await propagateProjectSkills(projectPath, options, registry);
  return [...bridges, skills];
}

async function propagateProjectSkills(projectPath, options, registry) {
  const skillsDir = path.join(projectPath, "skills");
  const symlinkTargetsForProject = projectSymlinkTargets(registry);
  const hermesTargetsForProject = projectHermesConfigTargets(registry);
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

  for (const target of hermesTargetsForProject) {
    const configPath = path.join(projectPath, target.configFile);
    const safety = await validateProjectPath({ projectRoot: projectPath, targetPath: configPath });
    if (!safety.safe) {
      details.push({ action: "project-skills:unsafe-hermes-config", path: configPath, note: safety.reason });
      continue;
    }
    const result = await ensureExternalSkillsDir({
      configPath,
      skillsPath: skillsDir,
      key: target.key,
      dryRun: options.dryRun,
      createMissing: true
    });
    details.push({ action: `hermes:${result.action}`, path: configPath, note: result.reason });
  }

  const linked = details.filter((result) => ["linked", "already-linked", "would link"].includes(result.action)).length;
  const changed = details.filter((result) => result.action.startsWith("hermes:") && !result.action.endsWith("manual") && !result.action.endsWith("already-present")).length;
  const verb = skills.length === 0
    ? "checked"
    : (options.dryRun ? "would propagate" : "propagated");
  const skillLabel = skills.length === 0
    ? (skillsDirectoryExists ? "no readable project skills" : "no project skills directory")
    : skills.length === 1
    ? `skill ${skills[0].name}`
    : `${skills.length} skill(s)`;
  const targetPaths = [
    ...symlinkTargetsForProject.map((target) => target.dir),
    ...hermesTargetsForProject.map((target) => target.configFile)
  ];
  const targetLabel = targetPaths.length > 0 ? targetPaths.join(", ") : "no registered targets";
  const unsafe = details.filter((result) =>
    result.action === "skipped-unsafe-target"
    || result.action.startsWith("project-skills:unsafe-")
  );
  const safetyNote = unsafe.length > 0
    ? `; ${unsafe.length} unsafe target(s) skipped`
    : "";
  const note = `${verb} ${skillLabel} to ${targetLabel}; ${linked} symlink action(s), ${changed} Hermes config action(s)${safetyNote}`;
  return { action: "project-skills", path: skillsDir, note };
}

async function isDirectory(value) {
  try {
    return (await fs.stat(value)).isDirectory();
  } catch {
    return false;
  }
}

async function writeManagedFile(destination, content, { dryRun = false, overwrite = false, projectRoot = null } = {}) {
  if (projectRoot) {
    const safety = await validateProjectPath({ projectRoot, targetPath: destination });
    if (!safety.safe) {
      return { action: "unsafe-target", path: destination, note: safety.reason };
    }
  }
  const exists = await pathExists(destination);

  if (!exists) {
    if (!dryRun) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
    }
    return { action: dryRun ? "would create" : "created", path: destination };
  }

  const current = await fs.readFile(destination, "utf8");
  const managed = current.includes(managedStart) && current.includes(managedEnd);
  if (!managed && !overwrite) {
    return { action: "kept", path: destination, note: "existing unmanaged file" };
  }

  if (!dryRun) {
    await fs.writeFile(destination, content);
  }

  return { action: dryRun ? "would update" : "updated", path: destination };
}

function projectAgentsBridge(aiosPath) {
  return bridgeFile("DotAIOS Project Bridge", [
    "This project is attached to the user's DotAIOS memory.",
    "",
    `Before personal recommendations or cross-project planning, read: ${path.join(aiosPath, "AGENTS.md")}`,
    "",
    "Keep project-specific instructions in this file short. Durable personal context belongs in DotAIOS."
  ]);
}

function cursorRule(aiosPath) {
  return [
    "---",
    "description: DotAIOS personal context",
    "globs:",
    "alwaysApply: true",
    "---",
    "",
    managedStart,
    "Read the user's DotAIOS context before recommendations that depend on identity, priorities, active work, memory, or writing style.",
    "",
    `@${path.join(aiosPath, "AGENTS.md")}`,
    managedEnd,
    ""
  ].join("\n");
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
  return isWithin(lexicalTempRoot, lexicalPath) || isWithin(realTempRoot, realPath);
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

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function printResults(title, results) {
  console.log(`\n${title}`);
  for (const result of results) {
    const note = result.note ? ` (${result.note})` : "";
    console.log(`[${result.action}] ${result.path}${note}`);
  }
}
