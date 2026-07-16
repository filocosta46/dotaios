#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { buildSessionDigest } from "../../core/src/digest.mjs";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../core/src/paths.mjs";
import { SEARCH_SCOPES, searchAios } from "../../core/src/search.mjs";
import { rankSkills } from "../../core/src/skill-resolver.mjs";
import { collectSkills } from "../../core/src/skills.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = "1.8.0";
const DEFAULT_SEARCH_BUDGET = 6000;

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const options = parseOptions(argv);
  const aiosPath = path.resolve(expandHome(options.path || process.env.DOTAIOS_PATH || defaultAiosPath()));
  const server = new DotaiosMcpServer({ aiosPath });
  await server.start();
}

class DotaiosMcpServer {
  constructor({ aiosPath }) {
    this.aiosPath = aiosPath;
  }

  async start() {
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const trimmed = line.trim();
      if (trimmed) await this.handleLine(trimmed);
    }
  }

  async handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.writeError(null, -32700, "Parse error");
      return;
    }

    if (!Object.hasOwn(message, "id")) return;
    try {
      const result = await this.handleRequest(message);
      this.write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.writeError(message.id, error.code || -32603, error.message || "Internal error");
    }
  }

  async handleRequest(message) {
    if (message.jsonrpc !== "2.0" || !message.method) {
      throw protocolError(-32600, "Invalid Request");
    }

    if (message.method === "initialize") {
      return {
        protocolVersion: message.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: "dotaios-mcp",
          title: "DotAIOS MCP",
          version: SERVER_VERSION,
        },
        instructions: [
          "This is an optional, read-only DotAIOS adapter.",
          "Use read_working_context for bounded continuity, search_aios to find local material,",
          "and resolve_skill before inventing a workflow. Content returned here may be sent to the configured AI provider.",
        ].join(" "),
      };
    }

    if (message.method === "ping") return {};
    if (message.method === "tools/list") return { tools: tools() };
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      return textResult(await this.callTool(name, args));
    }
    throw protocolError(-32601, `Method not found: ${message.method}`);
  }

  async callTool(name, args) {
    await this.assertAios();
    if (name === "read_working_context") return this.readWorkingContext(args);
    if (name === "search_aios") return this.searchAios(args);
    if (name === "resolve_skill") return this.resolveSkill(args);
    throw protocolError(-32602, `Unknown tool: ${name}`);
  }

  async assertAios() {
    try {
      await fs.access(path.join(this.aiosPath, "aios.json"));
    } catch {
      throw protocolError(-32602, `No AIOS folder found at ${this.aiosPath}`);
    }
  }

  async readConfig() {
    try {
      return JSON.parse(await fs.readFile(path.join(this.aiosPath, "aios.json"), "utf8"));
    } catch {
      return {};
    }
  }

  async readWorkingContext(args) {
    const project = optionalString(args.project);
    const limit = args.limit === undefined ? 3 : boundedInteger(args.limit, "limit", 1, 10);
    const visibleCharacterBudget = args.budget === undefined
      ? undefined
      : boundedInteger(args.budget, "budget", 256, 32000);
    const { digest, budget, generatedAt, projectFilter } = await buildSessionDigest(this.aiosPath, {
      project,
      limit,
      visibleCharacterBudget,
    });
    return JSON.stringify({
      markdown: digest,
      scope: { project: projectFilter },
      generated_at: generatedAt,
      budget,
    }, null, 2);
  }

  async resolveSkill(args) {
    const intent = requireString(args.intent, "intent", 500);
    const limit = args.limit === undefined ? 1 : boundedInteger(args.limit, "limit", 1, 10);
    const skillsDir = path.join(this.aiosPath, "skills");
    const skills = await collectSkills(this.aiosPath);
    const matches = rankSkills(intent, skills, { skillsDir })
      .slice(0, limit)
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        triggers: entry.triggers,
        score: Math.round(entry.score * 1000) / 1000,
        reason: entry.reason,
        resource: `skills/${entry.dir}/SKILL.md`,
      }));
    return JSON.stringify({ intent, matches }, null, 2);
  }

  async searchAios(args) {
    const query = requireString(args.query, "query", 500);
    const limit = args.limit === undefined ? 10 : boundedInteger(args.limit, "limit", 1, 20);
    const budget = args.budget === undefined
      ? DEFAULT_SEARCH_BUDGET
      : boundedInteger(args.budget, "budget", 256, 32000);
    const scope = optionalString(args.scope) || "all";
    if (!SEARCH_SCOPES.includes(scope)) {
      throw protocolError(-32602, `scope must be one of: ${SEARCH_SCOPES.join(", ")}`);
    }
    const config = await this.readConfig();
    const vaultPath = resolveVaultPath(config, this.aiosPath);
    const groups = await searchAios({ aiosPath: this.aiosPath, vaultPath, query, scope, limit });
    return JSON.stringify(boundSearchResults({ query, scope, groups, limit: budget }), null, 2);
  }

  write(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  writeError(id, code, message) {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

function tools() {
  return [
    {
      name: "read_working_context",
      title: "Read Working Context",
      description: "Read the same bounded, project-filtered working context produced by dotaios brief --compact. This tool has no write side effects.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          project: { type: "string", description: "Optional project slug or stable id." },
          limit: { type: "integer", minimum: 1, maximum: 10, default: 3 },
          budget: { type: "integer", minimum: 256, maximum: 32000, default: 6000 },
        },
      },
    },
    {
      name: "search_aios",
      title: "Search AIOS",
      description: "Search bounded local results across memory, sessions, context, projects, vault, skills, references, and plugins.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          scope: { type: "string", enum: SEARCH_SCOPES, default: "all" },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
          budget: { type: "integer", minimum: 256, maximum: 32000, default: 6000 },
        },
        required: ["query"],
      },
    },
    {
      name: "resolve_skill",
      title: "Resolve Workflow",
      description: "Match a user request to one of the installed DotAIOS workflows before hand-rolling the work.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          intent: { type: "string", minLength: 1, maxLength: 500 },
          limit: { type: "integer", minimum: 1, maximum: 10, default: 1 },
        },
        required: ["intent"],
      },
    },
  ];
}

function boundSearchResults({ query, scope, groups, limit }) {
  const selected = [];
  let truncated = false;
  outer: for (const group of groups) {
    for (const rawResult of group.results || []) {
      const result = sanitizeSearchValue(rawResult);
      const candidate = [...selected, { scope: group.scope, ...result }];
      if (JSON.stringify({ query, scope, results: candidate }).length > limit) {
        truncated = true;
        break outer;
      }
      selected.push({ scope: group.scope, ...result });
    }
  }
  const envelope = { query, scope, results: selected, budget: { limit, used: 0, truncated } };
  envelope.budget.used = JSON.stringify(envelope).length;
  return envelope;
}

function sanitizeSearchValue(value, key = "") {
  if (Array.isArray(value)) return value.slice(0, 5).map((entry) => sanitizeSearchValue(entry));
  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (/^(?:path|source_path|projectPath|readmePath|rootPath)$/i.test(childKey)) continue;
      sanitized[childKey] = sanitizeSearchValue(childValue, childKey);
    }
    return sanitized;
  }
  if (typeof value === "string") {
    const maximum = key === "content" || key === "summary" ? 800 : 300;
    return value.length <= maximum ? value : `${value.slice(0, maximum - 16)}\n[truncated]`;
  }
  return value;
}

function parseOptions(args) {
  const options = { path: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--path requires a value");
      options.path = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  dotaios-mcp [options]

Options:
  --path <dir>  Use a non-default AIOS folder

This starts the optional read-only DotAIOS stdio adapter.
`);
}

function textResult(text) {
  return { content: [{ type: "text", text }], isError: false };
}

function requireString(value, name, maximumLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw protocolError(-32602, `${name} must be a non-empty string`);
  }
  if (maximumLength && value.length > maximumLength) {
    throw protocolError(-32602, `${name} must be at most ${maximumLength} characters`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedInteger(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw protocolError(-32602, `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
