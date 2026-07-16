import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { installSymlinkSkills } from "../../../core/src/skills-install.mjs";
import { collectSkills } from "../../../core/src/skills.mjs";
import { loadAgentRegistry } from "../../../core/src/bridges.mjs";
import { projectHermesConfigTargets, projectSymlinkTargets } from "../../../core/src/skill-targets.mjs";
import { ensureExternalSkillsDir } from "../../../core/src/hermes-config.mjs";
import {
  createInvocationReceipt,
  markerWasProduced,
  sha256File,
  writeInvocationReceipt
} from "../../../core/src/skill-invocation.mjs";

const PROBE_SKILL = "dotaios-probe";
const DEFAULT_TIMEOUT_MS = 90_000;

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
        "--tools", "Read",
        "--setting-sources", "project",
        prompt
      ],
      receiptCommand: [
        "claude", "--print", "--no-session-persistence", "--permission-mode",
        "plan", "--tools", "Read", "--setting-sources", "project",
        "<probe-prompt>"
      ],
      cwd: projectPath
    })
  },
  hermes: {
    label: "Hermes",
    binary: "hermes",
    runnable: false,
    limitation: "Hermes one-shot mode auto-bypasses approvals; prove a read-only toolset before invoking it.",
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
    label: "Antigravity",
    binary: "antigravity",
    runnable: false,
    limitation: "No detected Antigravity CLI or bounded headless invocation surface.",
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
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!client) throw new Error("--client is required; choose codex, gemini, claude-code, hermes, cursor, or antigravity");
  const definition = PROBE_CLIENTS[client];
  if (!definition) {
    throw new Error(`Unknown probe client: ${client}. Choose: ${Object.keys(PROBE_CLIENTS).join(", ")}`);
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
    const configured = target.configured ? "yes" : "no";
    const discoverable = target.discoverable ? "path-ready" : "no";
    const digest = await sha256File(skillPath);
    const prompt = "Please verify project skill invocation. Do not infer or guess the marker from this request. Follow the matching project-owned skill exactly. Do not edit files.";
    const version = readClientVersion(definition.binary);

    if (!definition.runnable) {
      receipt = createInvocationReceipt({
        client: definition.label,
        clientVersion: version,
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
        clientVersion: version,
        configured,
        discoverable,
        targetPath: target.path,
        skillName: PROBE_SKILL,
        skillPath,
        skillDigest: digest,
        marker,
        command: definition.build({ projectPath, outputPath: "<temporary-output>", prompt }).receiptCommand,
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
        clientVersion: version,
        configured,
        discoverable,
        targetPath: target.path,
        skillName: PROBE_SKILL,
        skillPath,
        skillDigest: digest,
        marker,
        command: definition.build({ projectPath, outputPath: "<temporary-output>", prompt }).receiptCommand,
        limitation: "client was not invoked; pass --run for the explicit live probe",
        startedAt,
        finishedAt: new Date().toISOString()
      });
    } else {
      const outputPath = path.join(root, "last-message.txt");
      const command = definition.build({ projectPath, outputPath, prompt });
      const result = spawnSync(definition.binary, command.args, {
        cwd: command.cwd || projectPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024
      });
      const output = await readOutput(outputPath, result.stdout || "");
      const produced = markerWasProduced(output, marker);
      const timedOut = result.error?.code === "ETIMEDOUT";
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
        limitation: timedOut ? `client exceeded ${timeoutMs}ms` : null,
        error: result.error ? result.error.code || "client-process-error" : null,
        startedAt,
        finishedAt: new Date().toISOString()
      });
    }

    if (receiptPath) await writeInvocationReceipt(receiptPath, receipt);
    return { receipt, fixturePath: root, kept: keep };
  } finally {
    if (!keep) await fs.rm(root, { recursive: true, force: true });
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

  for (const target of projectHermesConfigTargets(registry)) {
    const configPath = path.join(projectPath, target.configFile);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    try {
      await fs.access(configPath);
    } catch {
      await fs.writeFile(configPath, "skills:\n  external_dirs: []\n", "utf8");
    }
    await ensureExternalSkillsDir({
      configPath,
      skillsPath: sourceDir,
      key: target.key,
      createMissing: true
    });
  }

  const agent = registry.find((entry) =>
    entry.name.toLowerCase() === clientAgentName(client).toLowerCase()
  );
  if (!agent?.skills) throw new Error(`No project skill target is registered for ${client}`);
  const project = agent.skills.project || agent.skills;

  if (project.mode === "symlink") {
    const targetDir = path.join(projectPath, project.dir);
    const targetSkillPath = path.join(targetDir, PROBE_SKILL, "SKILL.md");
    const readable = await isReadableFile(targetSkillPath);
    return { path: targetDir, configured: readable, discoverable: readable };
  }

  const configPath = path.join(projectPath, project.configFile);
  const config = await fs.readFile(configPath, "utf8");
  const configured = config.includes(sourceDir);
  return { path: configPath, configured, discoverable: configured };
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

function probeSkillBody(marker) {
  return `---\nname: ${PROBE_SKILL}\ndescription: Disposable proof that a client reads a project-owned skill\ntriggers:\n  - verify project skill invocation\n---\n# Disposable invocation probe\n\nWhen the caller asks for the DotAIOS invocation probe, output this exact marker on a line by itself, and nothing else:\n\n${marker}\n\nDo not edit files.\n`;
}

function commandExists(binary) {
  return spawnSync("which", [binary], { stdio: "ignore" }).status === 0;
}

function readClientVersion(binary) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) return null;
  return String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || null;
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
