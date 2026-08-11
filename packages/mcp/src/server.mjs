#!/usr/bin/env node

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import {
  WORKING_CONTEXT_OPERATIONAL_OVERHEAD_LIMIT,
  buildWorkingContextEnvelope
} from "../../core/src/working-context-envelope.mjs";
import { createEvidenceReader } from "../../core/src/evidence-reader.mjs";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../core/src/paths.mjs";
import { SEARCH_SCOPES, searchAios } from "../../core/src/search.mjs";
import { rankSkills } from "../../core/src/skill-resolver.mjs";
import { collectSkills } from "../../core/src/skills.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;
const DEFAULT_RESULT_BUDGET = 6000;
const MAX_SEARCH_CONFIG_BYTES = 1024 * 1024;

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
      const protocolCode = Number.isInteger(error?.code) && error.code < 0 ? error.code : -32603;
      const messageText = protocolCode !== -32603
        ? error.message
        : error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
          ? "DotAIOS could not read working context safely."
          : "DotAIOS request failed safely.";
      this.writeError(message.id, protocolCode, messageText);
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
      const rawArguments = message.params?.arguments;
      const args = rawArguments === undefined ? {} : requireArgumentsObject(rawArguments);
      return textResult(await this.callTool(name, args));
    }
    throw protocolError(-32601, `Method not found: ${message.method}`);
  }

  async callTool(name, args) {
    await this.assertAios();
    if (name === "read_working_context") {
      assertAllowedArguments(args, ["project", "limit", "budget"]);
      return this.readWorkingContext(args);
    }
    if (name === "search_aios") {
      assertAllowedArguments(args, ["query", "scope", "limit", "budget"]);
      return this.searchAios(args);
    }
    if (name === "resolve_skill") {
      assertAllowedArguments(args, ["intent", "limit", "budget"]);
      return this.resolveSkill(args);
    }
    throw protocolError(-32602, `Unknown tool: ${name}`);
  }

  async assertAios() {
    try {
      await fs.access(path.join(this.aiosPath, "aios.json"));
    } catch {
      throw protocolError(-32602, "No AIOS folder found at the configured path");
    }
  }

  async readConfig(reader) {
    return reader.readJson(
      this.aiosPath,
      path.join(this.aiosPath, "aios.json"),
      {
        invalidCode: "DOTAIOS_EVIDENCE_CONFIG_INVALID",
        maxBytes: MAX_SEARCH_CONFIG_BYTES
      }
    );
  }

  async readWorkingContext(args) {
    const project = optionalString(args.project, "project", 200);
    if (project && /\p{Cc}/u.test(project)) {
      throw protocolError(-32602, "project must be a project slug or stable id");
    }
    const limit = args.limit === undefined ? 3 : boundedInteger(args.limit, "limit", 1, 10);
    const visibleCharacterBudget = args.budget === undefined
      ? undefined
      : boundedInteger(args.budget, "budget", 256, 32000);
    let envelope;
    try {
      envelope = await buildWorkingContextEnvelope(this.aiosPath, {
        project,
        limit,
        visibleCharacterBudget,
      });
    } catch (error) {
      if (
        error?.code === "DOTAIOS_AMBIGUOUS_PROJECT"
        || error?.cause?.code === "DOTAIOS_AMBIGUOUS_PROJECT"
      ) {
        throw protocolError(-32602, "project selector is ambiguous; use its stable id");
      }
      throw error;
    }
    const { digest, budget, generatedAt, projectFilter, operational } = envelope;
    const metadata = {
      scope: { project: projectFilter },
      generated_at: generatedAt,
      budget,
      operational,
    };
    if (JSON.stringify(metadata, null, 2).length > WORKING_CONTEXT_OPERATIONAL_OVERHEAD_LIMIT) {
      throw new Error("Working-context metadata exceeded its fixed operational bound.");
    }
    return JSON.stringify({ markdown: digest, ...metadata }, null, 2);
  }

  async resolveSkill(args) {
    const intent = requireString(args.intent, "intent", 500);
    const limit = args.limit === undefined ? 1 : boundedInteger(args.limit, "limit", 1, 10);
    const budget = args.budget === undefined
      ? DEFAULT_RESULT_BUDGET
      : boundedInteger(args.budget, "budget", 256, 32000);
    const skillsDir = path.join(this.aiosPath, "skills");
    const reader = createEvidenceReader({ roots: [this.aiosPath] });
    const skills = await collectSkills(this.aiosPath, { reader, root: this.aiosPath });
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
    return serializeBoundedSkillResults({ intent, matches, limit: budget });
  }

  async searchAios(args) {
    const query = requireString(args.query, "query", 500);
    const limit = args.limit === undefined ? 10 : boundedInteger(args.limit, "limit", 1, 20);
    const budget = args.budget === undefined
      ? DEFAULT_RESULT_BUDGET
      : boundedInteger(args.budget, "budget", 256, 32000);
    const scope = optionalString(args.scope) || "all";
    if (!SEARCH_SCOPES.includes(scope)) {
      throw protocolError(-32602, `scope must be one of: ${SEARCH_SCOPES.join(", ")}`);
    }
    let reader = createEvidenceReader({ roots: [this.aiosPath] });
    const config = await this.readConfig(reader);
    const vaultPath = resolveVaultPath(config, this.aiosPath);
    reader = reader.withAuthorizedRoots([vaultPath]);
    const groups = await searchAios({
      aiosPath: this.aiosPath,
      vaultPath,
      query,
      scope,
      limit,
      evidenceReader: reader
    });
    return serializeBoundedSearchResults({ query, scope, groups, limit: budget });
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
      description: "Read the same bounded, project-filtered working-context projection produced by dotaios brief --compact plus fixed operational compatibility state beside it. This tool has no write side effects.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          project: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            pattern: "^(?=.*\\S)[^\\u0000-\\u001F\\u007F-\\u009F]*$",
            description: "Optional project slug or stable id. Opaque identifiers without Unicode control characters are accepted within the 200-code-point bound."
          },
          limit: { type: "integer", minimum: 1, maximum: 10, default: 3 },
          budget: { type: "integer", minimum: 256, maximum: 32000, default: 6000, description: "Character budget for canonical Markdown; bounded operational metadata is separate." },
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
          budget: { type: "integer", minimum: 256, maximum: 32000, default: 6000 },
        },
        required: ["intent"],
      },
    },
  ];
}

function serializeBoundedSearchResults({ query, scope, groups, limit }) {
  const selected = [];
  let truncated = false;
  outer: for (const group of groups) {
    for (const rawResult of group.results || []) {
      const result = sanitizeResultValue(rawResult);
      const candidate = [...selected, { scope: group.scope, ...result }];
      const candidateText = serializeSearchEnvelope({ query, scope, results: candidate, limit, truncated: false });
      if (candidateText.length > limit) {
        truncated = true;
        break outer;
      }
      selected.push({ scope: group.scope, ...result });
    }
  }

  let boundedQuery = query;
  let serialized = serializeSearchEnvelope({ query: boundedQuery, scope, results: selected, limit, truncated });
  while (serialized.length > limit && selected.length > 0) {
    selected.pop();
    truncated = true;
    serialized = serializeSearchEnvelope({ query: boundedQuery, scope, results: selected, limit, truncated });
  }

  if (serialized.length > limit) {
    const marker = "[query truncated]";
    truncated = true;
    const fitted = fitSerializedString({
      value: boundedQuery,
      marker,
      limit,
      serialize: (candidate) => serializeSearchEnvelope({
        query: candidate,
        scope,
        results: selected,
        limit,
        truncated
      })
    });
    if (fitted) {
      boundedQuery = fitted.value;
      serialized = fitted.serialized;
    }
  }

  if (serialized.length > limit) {
    throw protocolError(-32602, `budget ${limit} is too small for the search response envelope`);
  }
  return serialized;
}

function serializeBoundedSkillResults({ intent, matches, limit }) {
  const selected = [];
  let truncated = false;
  for (const rawMatch of matches) {
    const match = sanitizeResultValue(rawMatch, "", Number.POSITIVE_INFINITY);
    const candidate = [...selected, match];
    if (serializeSkillEnvelope({ intent, matches: candidate, limit, truncated: false }).length > limit) {
      truncated = true;
      break;
    }
    selected.push(match);
  }

  let boundedIntent = intent;
  let serialized = serializeSkillEnvelope({ intent: boundedIntent, matches: selected, limit, truncated });
  while (serialized.length > limit && selected.length > 0) {
    selected.pop();
    truncated = true;
    serialized = serializeSkillEnvelope({ intent: boundedIntent, matches: selected, limit, truncated });
  }

  if (serialized.length > limit) {
    const marker = "[intent truncated]";
    truncated = true;
    const fitted = fitSerializedString({
      value: boundedIntent,
      marker,
      limit,
      serialize: (candidate) => serializeSkillEnvelope({
        intent: candidate,
        matches: selected,
        limit,
        truncated
      })
    });
    if (fitted) {
      boundedIntent = fitted.value;
      serialized = fitted.serialized;
    }
  }

  if (serialized.length > limit) {
    throw protocolError(-32602, `budget ${limit} is too small for the skill response envelope`);
  }
  return serialized;
}

function serializeSkillEnvelope({ intent, matches, limit, truncated }) {
  let used = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const serialized = JSON.stringify({
      intent,
      matches,
      budget: { limit, used, truncated },
    }, null, 2);
    if (serialized.length === used) return serialized;
    used = serialized.length;
  }
  throw new Error("Could not stabilize skill response budget metadata");
}

function serializeSearchEnvelope({ query, scope, results, limit, truncated }) {
  let used = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const serialized = JSON.stringify({
      query,
      scope,
      results,
      budget: { limit, used, truncated },
    }, null, 2);
    if (serialized.length === used) return serialized;
    used = serialized.length;
  }
  throw new Error("Could not stabilize search response budget metadata");
}

function fitSerializedString({ value, marker, limit, serialize }) {
  const codePoints = Array.from(value);
  let lower = 0;
  let upper = codePoints.length;
  let best = null;
  while (lower <= upper) {
    const count = Math.floor((lower + upper) / 2);
    const candidate = count === 0
      ? marker
      : `${codePoints.slice(0, count).join("")}${marker}`;
    const serialized = serialize(candidate);
    if (serialized.length <= limit) {
      best = { value: candidate, serialized };
      lower = count + 1;
    } else {
      upper = count - 1;
    }
  }
  return best;
}

function sanitizeResultValue(value, key = "", maximumArrayEntries = 5) {
  if (Array.isArray(value)) {
    return value
      .slice(0, maximumArrayEntries)
      .map((entry) => sanitizeResultValue(entry, "", maximumArrayEntries));
  }
  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (/^(?:path|source_path|projectPath|readmePath|rootPath)$/i.test(childKey)) continue;
      sanitized[childKey] = sanitizeResultValue(childValue, childKey, maximumArrayEntries);
    }
    return sanitized;
  }
  if (typeof value === "string") {
    const maximum = key === "content" || key === "summary" ? 800 : 300;
    return truncateSanitizedString(value, maximum);
  }
  return value;
}

function truncateSanitizedString(value, maximum) {
  if (value.length <= maximum) return value;
  const marker = "\n[truncated]";
  const available = maximum - marker.length;
  let prefix = "";
  for (const codePoint of Array.from(value)) {
    if (prefix.length + codePoint.length > available) break;
    prefix += codePoint;
  }
  return `${prefix}${marker}`;
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
  if (maximumLength && Array.from(value).length > maximumLength) {
    throw protocolError(-32602, `${name} must be at most ${maximumLength} characters`);
  }
  return value;
}

function optionalString(value, name = "value", maximumLength = null) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw protocolError(-32602, `${name} must be a non-empty string`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw protocolError(-32602, `${name} must not contain control characters`);
  }
  if (maximumLength && Array.from(value).length > maximumLength) {
    throw protocolError(-32602, `${name} must be at most ${maximumLength} characters`);
  }
  const result = value.trim();
  return result;
}

function requireArgumentsObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError(-32602, "tool arguments must be an object");
  }
  return value;
}

function assertAllowedArguments(args, allowedNames) {
  const allowed = new Set(allowedNames);
  const unknown = Object.keys(args).find((name) => !allowed.has(name));
  if (unknown) throw protocolError(-32602, "Unknown tool argument");
}

function boundedInteger(value, name, minimum, maximum) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw protocolError(-32602, `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
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
