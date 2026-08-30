import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { installSymlinkSkills } from "../../../core/src/skills-install.mjs";
import { collectSkills } from "../../../core/src/skills.mjs";
import { loadAgentRegistry } from "../../../core/src/bridges.mjs";
import { projectSymlinkTargets } from "../../../core/src/skill-targets.mjs";
import { registerProject } from "../../../core/src/projects.mjs";
import { resolveProjectRoute } from "../../../core/src/project-native-routing.mjs";
import {
  createInvocationReceipt,
  markerWasProduced,
  sha256File,
  writeInvocationReceipt
} from "../../../core/src/skill-invocation.mjs";

const PROBE_SKILL = "dotaios-probe";
const DEFAULT_TIMEOUT_MS = 90_000;

export function redactDiagnosticText(text) {
  return String(text || "")
    .replace(
      /\b((?:Proxy-)?Authorization\s*:\s*)[^\r\n]+/gi,
      "$1[REDACTED]"
    )
    .replace(
      /\b((?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi,
      "$1[REDACTED]"
    )
    .replace(
      /\b((?:X-)?Session(?:-Id|-Token)?\s*:\s*)[^\r\n,;]+/gi,
      "$1[REDACTED]"
    )
    .replace(
      /\b(Bearer\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /(["']?[A-Z0-9_.-]*(?:API[-_ ]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|OAUTH[-_ ]?CODE|CLIENT[-_ ]?SECRET)[A-Z0-9_.-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1[REDACTED]"
    )
    .replace(/([?&][^=\s&]+)=[^&\s]+/g, "$1=[REDACTED]")
    .replace(/https?:\/\/[^/@\s:]+:[^@\s]+@/gi, "https://[REDACTED]@")
    .replace(/\b([A-Z]:\\Users\\)[^\\\s]+/gi, "$1[REDACTED]")
    .replace(/\/(?:Users|home)\/[^/\s]+/g, (match) => {
      const prefix = match.startsWith("/Users/") ? "/Users/" : "/home/";
      return `${prefix}[REDACTED]`;
    })
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(
      /\b(?:sk|gh[pousr]|xox[baprs]|AIza|AKIA)[-_]?[A-Za-z0-9._~+/=-]{8,}\b/g,
      "[REDACTED]"
    )
    .replace(/\b[A-Za-z0-9][A-Za-z0-9._~+/=-]{23,}\b/g, "[REDACTED]");
}

export const PROBE_CLIENTS = {
  codex: {
    label: "Codex",
    binary: "codex",
    runnable: true,
    build: ({ projectPath, outputPath, prompt }) => ({
      args: [
        "exec",
        "--ephemeral",
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "-C", projectPath,
        "--output-last-message", outputPath,
        prompt
      ],
      receiptCommand: [
        "codex", "exec", "--ephemeral", "--sandbox", "read-only",
        "--skip-git-repo-check", "--ignore-user-config", "-C", projectPath,
        "--output-last-message", outputPath
      ]
    })
  },
  gemini: {
    label: "Gemini",
    binary: "gemini",
    runnable: true,
    build: ({ projectPath, prompt }) => ({
      args: [
        "--prompt", prompt,
        "--approval-mode", "plan",
        "--output-format", "text"
      ],
      receiptCommand: [
        "gemini", "--prompt", "<probe-prompt>", "--approval-mode", "plan",
        "--output-format", "text"
      ],
      cwd: projectPath
    })
  },
  "claude-code": {
    label: "Claude Code",
    binary: "claude",
    runnable: true,
    build: ({ projectPath, prompt }) => ({
      args: [
        "--print",
        "--no-session-persistence",
        "--permission-mode", "plan",
        "--tools", "Skill",
        "--setting-sources", "project",
        prompt
      ],
      receiptCommand: [
        "claude", "--print", "--no-session-persistence", "--permission-mode",
        "plan", "--tools", "Skill", "--setting-sources", "project",
        "<probe-prompt>"
      ],
      cwd: projectPath
    })
  },
  hermes: {
    label: "Hermes",
    binary: "hermes",
    runnable: false,
    limitation: "Hermes has no verified project-local config selector, and one-shot mode auto-bypasses approvals; global skill registration remains supported.",
    build: null
  },
  cursor: {
    label: "Cursor",
    binary: "cursor",
    runnable: false,
    limitation: "No bounded headless Cursor invocation surface is available in this probe.",
    build: null
  },
  antigravity: {
    label: "Antigravity IDE",
    binary: "antigravity",
    runnable: false,
    limitation: "No bounded headless Antigravity IDE invocation surface is available in this probe.",
    build: null
  }
};

export async function runSkillInvocationProbe({
  client = null,
  aiosPath,
  receiptPath = null,
  keep = false,
  dryRun = false,
  run = false,
  projectNativeRoute = false,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!client) throw new Error("--client is required; choose codex, gemini, claude-code, hermes, cursor, or antigravity");
  const definition = PROBE_CLIENTS[client];
  if (!definition) {
    throw new Error(`Unknown probe client: ${client}. Choose: ${Object.keys(PROBE_CLIENTS).join(", ")}`);
  }
  if (projectNativeRoute && client !== "codex") {
    throw new Error("--project-native-route is available only with --client codex.");
  }

  const sourcePath = path.resolve(aiosPath || path.join(os.homedir(), "aios"));
  await assertAiosSkillsSource(sourcePath);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-skill-probe-"));
  const projectPath = path.join(root, "project");
  const skillPath = path.join(projectPath, "skills", PROBE_SKILL, "SKILL.md");
  const marker = `DOTAIOS_PROBE_OK_${crypto.randomBytes(8).toString("hex")}`;
  const startedAt = new Date().toISOString();
  let receipt;

  try {
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, probeSkillBody(marker), "utf8");
    await fs.writeFile(
      path.join(projectPath, "AGENTS.md"),
      "# Disposable DotAIOS invocation probe\n\nUse the matching project-owned skill when its trigger matches the probe request. Do not edit files.\n",
      "utf8"
    );

    const target = await prepareProjectTargets({
      sourceAiosPath: sourcePath,
      projectPath,
      client
    });
    const routeEvidence = projectNativeRoute
      ? await prepareProjectNativeRoute({ root, projectPath })
      : null;
    const launchProjectPath = routeEvidence?.launchPath || projectPath;
    const configured = target.configured ? "yes" : "no";
    const discoverable = target.discoverable ? "path-ready" : "no";
    const digest = await sha256File(skillPath);
    const prompt = "Please verify project skill invocation. Report the exact current working directory and project skill marker only. Do not infer either value from this request. Follow the matching project-owned skill exactly. Do not edit files.";
    if (!definition.runnable) {
      receipt = createInvocationReceipt({
        client: definition.label,
        clientVersion: null,
        configured,
        discoverable,
        targetPath: target.path,
        skillName: PROBE_SKILL,
        skillPath,
        skillDigest: digest,
        marker,
        limitation: definition.limitation,
        startedAt,
        finishedAt: new Date().toISOString()
      });
    } else if (dryRun) {
      // An explicit dry run documents the would-be invocation and never
      // spawns the client, so it must not require the binary on PATH
      // (CI runners have no client CLIs installed).
      receipt = createInvocationReceipt({
        client: definition.label,
        clientVersion: null,
        configured,
        discoverable,
        targetPath: target.path,
        skillName: PROBE_SKILL,
        skillPath,
        skillDigest: digest,
        marker,
        command: definition.build({ projectPath: launchProjectPath, outputPath: "<temporary-output>", prompt }).receiptCommand,
        limitation: "client was not invoked; pass --run for the explicit live probe",
        startedAt,
        finishedAt: new Date().toISOString()
      });
    } else if (!commandExists(definition.binary)) {
      receipt = createInvocationReceipt({
        client: definition.label,
        clientVersion: null,
        configured,
        discoverable,
        targetPath: target.path,
        skillName: PROBE_SKILL,
        skillPath,
        skillDigest: digest,
        marker,
        limitation: `${definition.binary} was not found on PATH.`,
        startedAt,
        finishedAt: new Date().toISOString()
      });
    } else if (!run) {
      receipt = createInvocationReceipt({
        client: definition.label,
        clientVersion: null,
        configured,
        discoverable,
        targetPath: target.path,
        skillName: PROBE_SKILL,
        skillPath,
        skillDigest: digest,
        marker,
        command: definition.build({ projectPath: launchProjectPath, outputPath: "<temporary-output>", prompt }).receiptCommand,
        limitation: "client was not invoked; pass --run for the explicit live probe",
        startedAt,
        finishedAt: new Date().toISOString()
      });
    } else {
      const version = readClientVersion(definition.binary);
      const outputPath = path.join(root, "last-message.txt");
      const command = definition.build({ projectPath: launchProjectPath, outputPath, prompt });
      const result = spawnSync(definition.binary, command.args, {
        cwd: command.cwd || projectPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024
      });
      const output = await readOutput(outputPath, result.stdout || "");
      const canonicalProjectPath = await fs.realpath(launchProjectPath);
      const produced = (
        result.status === 0
        && !result.error
        && probeOutputMatchesProjectRoot(output, {
          marker,
          projectPath: launchProjectPath,
          canonicalProjectPath
        })
      );
      const timedOut = result.error?.code === "ETIMEDOUT";
      // A client that refuses usually says why: a missing entitlement, an
      // expired login, a model that needs a flag. Reporting only the timeout
      // hands back a receipt nobody can act on, so carry the client's own words.
      const diagnosticOutput = [
        result.stderr,
        result.status !== 0 ? result.stdout : ""
      ]
        .map((stream) => String(stream || "").trim())
        .filter(Boolean)
        .join("\n");
      const clientSaid = redactDiagnosticText(diagnosticOutput)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" ")
        .slice(0, 400);
      receipt = createInvocationReceipt({
        client: definition.label,
        clientVersion: version,
        configured,
        discoverable,
        invoked: result.error ? "no" : "yes",
        produced: produced ? "yes" : "no",
        targetPath: target.path,
        skillName: PROBE_SKILL,
        skillPath,
        skillDigest: digest,
        command: command.receiptCommand,
        marker,
        exitCode: result.status,
        limitation: [
          timedOut ? `client exceeded ${timeoutMs}ms` : null,
          clientSaid ? `client said: ${clientSaid}` : null,
          // Exit 0 with nothing written is an environment problem, not a
          // verdict on the skill. Left unlabelled it reads as "the client ran
          // fine and declined to use DotAIOS", which is a harsher and less
          // true claim than the evidence supports.
          !timedOut && !clientSaid && !String(output || "").trim()
            ? "client returned no output; treat as environment limitation, not a compatibility result"
            : null
        ].filter(Boolean).join("; ") || null,
        error: result.error ? result.error.code || "client-process-error" : null,
        startedAt,
        finishedAt: new Date().toISOString()
      });
    }

    if (routeEvidence) receipt.projectRoute = routeEvidence.receipt;

    if (receiptPath) await writeInvocationReceipt(receiptPath, receipt);
    return { receipt, fixturePath: root, kept: keep };
  } finally {
    if (!keep) await fs.rm(root, { recursive: true, force: true });
  }
}

async function prepareProjectNativeRoute({ root, projectPath }) {
  runLocalGit(projectPath, ["init", "-q"]);
  runLocalGit(projectPath, [
    "remote", "add", "origin",
    "https://github.com/dotaios-probe/project-native-route.git"
  ]);
  const aiosPath = path.join(root, "route-aios");
  const homePath = path.join(root, "route-home");
  await fs.mkdir(aiosPath, { recursive: true });
  await fs.mkdir(homePath, { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), "{\"schema_version\":\"1.2.0\"}\n");
  const intent = "Verify the project-native invocation probe.";
  const registration = {
    aiosPath,
    homePath,
    projectPath,
    slug: "project-native-probe",
    purpose: intent,
    createId: () => "project-native-probe-001",
    yes: false
  };
  const preview = await registerProject({ ...registration, apply: false });
  await registerProject({
    ...registration,
    operationId: preview.operationId,
    planFingerprint: preview.planFingerprint,
    apply: true
  });
  const supportedConventionKinds = ["agents-md", "repository-skill"];
  const candidate = await resolveProjectRoute({
    aiosPath,
    homePath,
    intent,
    supportedConventionKinds
  });
  if (candidate.status !== "candidate") {
    throw new Error(`Project-native probe discovery returned ${candidate.status}.`);
  }
  const exact = await resolveProjectRoute({
    aiosPath,
    homePath,
    intent,
    projectSelector: candidate.project.id,
    supportedConventionKinds,
    approvalBinding: candidate.approval_binding
  });
  if (exact.status !== "ready" || !exact.route?.location) {
    throw new Error(`Project-native probe exact resolution returned ${exact.status}.`);
  }
  const [canonicalProjectPath, canonicalLaunchPath] = await Promise.all([
    fs.realpath(projectPath),
    fs.realpath(exact.route.location)
  ]);
  if (canonicalProjectPath !== canonicalLaunchPath) {
    throw new Error("Project-native probe exact route did not preserve the registered root.");
  }
  return {
    launchPath: exact.route.location,
    receipt: {
      schema: "dotaios.project-native-invocation.v1",
      candidate: candidate.status,
      exact: exact.status,
      approvalBinding: "retained-opaque",
      exactLocation: "<temporary-project>",
      launchLocation: "<temporary-project>",
      rootMatch: "yes",
      outcomeBoundary: "same-caller-receipt"
    }
  };
}

function runLocalGit(projectPath, args) {
  const result = spawnSync("git", ["-C", projectPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`Project-native probe Git setup failed: ${result.error?.code || result.stderr || result.status}`);
  }
}

async function prepareProjectTargets({ sourceAiosPath, projectPath, client }) {
  const registry = await loadAgentRegistry(sourceAiosPath);
  const sourceDir = path.join(projectPath, "skills");

  for (const target of projectSymlinkTargets(registry)) {
    await installSymlinkSkills({
      sourceDir,
      targetDir: path.join(projectPath, target.dir),
      projectRoot: projectPath
    });
  }

  const agent = registry.find((entry) =>
    entry.name.toLowerCase() === clientAgentName(client).toLowerCase()
  );
  if (!agent?.skills) throw new Error(`No project skill target is registered for ${client}`);
  const project = agent.skills.project;
  if (!project) return { path: null, configured: false, discoverable: false };

  if (project.mode !== "symlink") return { path: null, configured: false, discoverable: false };
  const targetDir = path.join(projectPath, project.dir);
  const targetSkillPath = path.join(targetDir, PROBE_SKILL, "SKILL.md");
  const readable = await isReadableFile(targetSkillPath);
  return { path: targetDir, configured: readable, discoverable: readable };
}

function clientAgentName(client) {
  return {
    codex: "Codex",
    gemini: "Gemini",
    "claude-code": "Claude Code",
    hermes: "Hermes",
    cursor: "Cursor",
    antigravity: "Antigravity"
  }[client] || client;
}

export function formatProbeResult({ receipt, fixturePath }) {
  const { evidence } = receipt;
  const result = evidence.produced === "yes" ? "PROVEN" : evidence.invoked === "not-run" ? "NOT RUN" : "NOT PROVEN";
  return [
    `Skill invocation probe: ${result}`,
    `Client: ${receipt.client}${receipt.clientVersion ? ` ${receipt.clientVersion}` : ""}`,
    `Evidence: configured=${evidence.configured} discoverable=${evidence.discoverable} invoked=${evidence.invoked} produced=${evidence.produced}`,
    `Skill: ${receipt.skill.name} sha256=${receipt.skill.sha256}`,
    receipt.limitation ? `Limitation: ${receipt.limitation}` : null,
    receiptPathForDisplay(receipt),
    fixturePath ? `Fixture: ${fixturePath}` : null
  ].filter(Boolean).join("\n");
}

function receiptPathForDisplay(receipt) {
  return receipt.targetPath ? `Target: ${receipt.targetPath}` : "Target: unavailable";
}

async function assertAiosSkillsSource(aiosPath) {
  const skills = await collectSkills(aiosPath);
  if (skills.length === 0) throw new Error(`No readable skills found under ${path.join(aiosPath, "skills")}`);
}

export function probeOutputMatchesProjectRoot(output, {
  marker,
  projectPath,
  canonicalProjectPath = projectPath
} = {}) {
  if (!markerWasProduced(output, marker) || typeof projectPath !== "string") return false;
  const lines = String(output || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const reportedRoot = lines[0]?.startsWith("CWD: ")
    ? path.resolve(lines[0].slice("CWD: ".length))
    : null;
  const acceptedRoots = new Set([
    path.resolve(projectPath),
    path.resolve(canonicalProjectPath)
  ]);
  return lines.length === 2
    && acceptedRoots.has(reportedRoot)
    && lines[1] === marker;
}

function probeSkillBody(marker) {
  return [
    "---",
    "name: " + PROBE_SKILL,
    "description: Disposable proof that a client reads a project-owned skill",
    "triggers:",
    "  - verify project skill invocation",
    "---",
    "# Disposable invocation probe",
    "",
    "When the caller asks for the DotAIOS invocation probe, determine the process working directory without inferring it from the prompt, then output exactly these two lines and nothing else:",
    "",
    "CWD: <exact-process-working-directory>",
    marker,
    "",
    "Do not edit files.",
    ""
  ].join("\n");
}

function commandExists(binary) {
  return spawnSync("which", [binary], { stdio: "ignore" }).status === 0;
}

function readClientVersion(binary) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0 || result.error) return null;
  const firstLine = String(result.stdout || result.stderr || "")
    .trim()
    .split(/\r?\n/)[0];
  if (!firstLine) return null;
  return redactDiagnosticText(firstLine)
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, 160) || null;
}

async function isReadableFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    await fs.access(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readOutput(outputPath, stdout) {
  try {
    return await fs.readFile(outputPath, "utf8");
  } catch {
    return stdout;
  }
}
