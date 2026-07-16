import os from "node:os";
import path from "node:path";
import {
  doctorProjects,
  listProjects,
  registerProject,
  resolveProject
} from "../../../core/src/projects.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const HELP_TEXT = `Usage:
  dotaios project add <repo-path> [options]
  dotaios project list [options]
  dotaios project resolve <slug-or-id> [options]
  dotaios project doctor [options]

Keep real project repositories outside AIOS. DotAIOS stores portable metadata
under projects/<slug>/README.md and a local path mapping only on this machine.

Add options:
  --slug <slug>       Override the slug derived from the repository folder
  --name <name>       Set the human-readable project name
  --status <status>   Set the project status (default: active)
  --domain <domain>   Set build, make, or sell; repeat for multiple domains
  --repo-url <url>    Override the Git origin URL discovered from the repository

Common options:
  --path <dir>        Use an AIOS folder other than ~/aios
  --home <dir>        Use a different home for machine-local state
  --state-path <file> Override the machine-local project path registry
`;

export async function projectCommand(args = [], dependencies = {}) {
  const output = dependencies.output || console;
  if (hasHelpFlag(args)) {
    output.log(HELP_TEXT);
    return;
  }

  const { subcommand, positionals, options, addOptions } = parseOptions(args);
  if (!subcommand) {
    output.log(HELP_TEXT);
    return;
  }

  const coreOptions = createCoreOptions(options, dependencies);
  if (subcommand === "add") {
    assertPositionals(positionals, 1, "dotaios project add <repo-path>");
    const project = await registerProject({
      ...coreOptions,
      projectPath: resolveUserPath(positionals[0], coreOptions.homePath),
      slug: addOptions.slug,
      name: addOptions.name,
      status: addOptions.status,
      domain: addOptions.domains.length > 0 ? addOptions.domains : undefined,
      repoUrl: addOptions.repoUrl
    });
    output.log(`Registered ${project.name} (${project.slug})`);
    output.log(`  metadata: ${project.readmePath}`);
    output.log(`  path:     ${project.projectPath}`);
    output.log(`  repo:     ${project.repoUrl || "not found"}`);
    return project;
  }

  assertNoAddOptions(addOptions, subcommand);
  if (subcommand === "list") {
    assertPositionals(positionals, 0, "dotaios project list");
    const projects = await listProjects(coreOptions);
    printProjects(output, projects);
    return projects;
  }

  if (subcommand === "resolve") {
    assertPositionals(positionals, 1, "dotaios project resolve <slug-or-id>");
    const projectPath = await resolveProject({
      ...coreOptions,
      project: positionals[0]
    });
    output.log(projectPath);
    return projectPath;
  }

  if (subcommand === "doctor") {
    assertPositionals(positionals, 0, "dotaios project doctor");
    const report = await doctorProjects(coreOptions);
    printDoctorReport(output, report);
    if (!report.ok) {
      const setExitCode = dependencies.setExitCode || ((code) => { process.exitCode = code; });
      setExitCode(1);
    }
    return report;
  }

  throw new Error(`Unknown project subcommand: ${subcommand}. Try \`dotaios project --help\`.`);
}

function createCoreOptions(options, dependencies) {
  const homePath = resolveUserPath(options.home || dependencies.homePath || os.homedir(), os.homedir());
  return {
    aiosPath: resolveUserPath(options.path || path.join(homePath, "aios"), homePath),
    homePath,
    statePath: options.statePath
      ? resolveUserPath(options.statePath, homePath)
      : dependencies.statePath,
    fs: dependencies.fs,
    readRepoUrl: dependencies.readRepoUrl,
    createId: dependencies.createId
  };
}

function parseOptions(args) {
  const options = { path: null, home: null, statePath: null };
  const addOptions = { slug: null, name: null, status: null, domains: [], repoUrl: null };
  const positionals = [];
  let subcommand = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--home") {
      options.home = readOptionValue(args, index, "--home");
      index += 1;
    } else if (arg === "--state-path") {
      options.statePath = readOptionValue(args, index, "--state-path");
      index += 1;
    } else if (arg === "--slug") {
      addOptions.slug = readOptionValue(args, index, "--slug");
      index += 1;
    } else if (arg === "--name") {
      addOptions.name = readOptionValue(args, index, "--name");
      index += 1;
    } else if (arg === "--status") {
      addOptions.status = readOptionValue(args, index, "--status");
      index += 1;
    } else if (arg === "--domain") {
      const value = readOptionValue(args, index, "--domain");
      addOptions.domains.push(...value.split(",").map((domain) => domain.trim()).filter(Boolean));
      index += 1;
    } else if (arg === "--repo-url") {
      addOptions.repoUrl = readOptionValue(args, index, "--repo-url");
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!subcommand) {
      subcommand = arg;
    } else {
      positionals.push(arg);
    }
  }

  return { subcommand, positionals, options, addOptions };
}

function assertPositionals(positionals, expected, usage) {
  if (positionals.length !== expected) {
    throw new Error(`Usage: ${usage}`);
  }
}

function assertNoAddOptions(options, subcommand) {
  if (options.slug || options.name || options.status || options.domains.length > 0 || options.repoUrl) {
    throw new Error(`Project metadata options can only be used with \`dotaios project add\`, not ${subcommand}.`);
  }
}

function printProjects(output, projects) {
  if (projects.length === 0) {
    output.log("No projects registered.");
    output.log("Add one with: dotaios project add <repo-path>");
    return;
  }

  output.log("DotAIOS projects");
  for (const project of projects) {
    const state = project.pathAvailable ? "ok" : "missing";
    const domains = project.domain.join(", ") || "none";
    output.log(`[${state}] ${project.slug}: ${project.name}`);
    output.log(`       status: ${project.status} | domain: ${domains}`);
    output.log(`       path: ${project.projectPath || "not registered on this machine"}`);
    if (project.repoUrl) output.log(`       repo: ${project.repoUrl}`);
  }
}

function printDoctorReport(output, report) {
  output.log(`Project catalog doctor: checked ${report.checked}`);
  if (report.checked === 0) {
    output.log("[ok] No projects registered.");
    return;
  }

  const issuesByProject = new Map();
  for (const issue of report.issues) {
    const projectIssues = issuesByProject.get(issue.project.slug) || [];
    issuesByProject.set(issue.project.slug, [...projectIssues, issue]);
  }
  for (const project of report.projects) {
    const projectIssues = issuesByProject.get(project.slug) || [];
    if (projectIssues.length === 0) {
      output.log(`[ok] ${project.slug}: ${project.projectPath || "metadata only"}`);
      continue;
    }
    for (const issue of projectIssues) {
      const status = issue.type === "remote_mismatch" ? "mismatch" : "missing";
      output.log(`[${status}] ${issue.message}`);
    }
  }
  output.log(report.ok ? "Project catalog is healthy." : `${report.issues.length} issue(s) found.`);
}

function resolveUserPath(value, homePath) {
  if (value === "~") return path.resolve(homePath);
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(homePath, value.slice(2));
  }
  return path.resolve(value);
}
