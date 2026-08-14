#!/usr/bin/env node

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import {
  WORKING_CONTEXT_OPERATIONAL_OVERHEAD_LIMIT,
  buildWorkingContextEnvelope
} from "../../core/src/working-context-envelope.mjs";
import {
  DEFAULT_EVIDENCE_READ_LIMITS,
  createEvidenceReader,
} from "../../core/src/evidence-reader.mjs";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../core/src/paths.mjs";
import { SEARCH_SCOPES, searchAios } from "../../core/src/search.mjs";
import { validateProjectSelector } from "../../core/src/projects.mjs";
import { rankSkills } from "../../core/src/skill-resolver.mjs";
import { collectSkills } from "../../core/src/skills.mjs";
import { MEMORY_MODES, resolveMemoryPolicy } from "../../core/src/memory-policy.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;
const DEFAULT_RESULT_BUDGET = 6000;
const MAX_SEARCH_CONFIG_BYTES = 1024 * 1024;
const SEARCH_QUERY_TRUNCATION_MARKER = "[query truncated]";
const LEGACY_MIN_SEARCH_RESULT_BUDGET = 3530;
const MIN_SEARCH_RESULT_BUDGET = Math.max(
  LEGACY_MIN_SEARCH_RESULT_BUDGET,
  deriveMinimumSearchResultBudget()
);

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
    validateMcpToolArguments(name, args);
    const memoryPolicy = resolveMcpMemoryPolicy(args);
    if (memoryPolicy.mode === "off") return serializeOffToolResult(name, args, memoryPolicy);
    await this.assertAios();
    if (name === "read_working_context") {
      assertAllowedArguments(args, ["memory", "project", "limit", "budget"]);
      return this.readWorkingContext(args, memoryPolicy);
    }
    if (name === "search_aios") {
      assertAllowedArguments(args, ["memory", "query", "scope", "project", "limit", "budget"]);
      return this.searchAios(args, memoryPolicy);
    }
    if (name === "resolve_skill") {
      assertAllowedArguments(args, ["memory", "project", "intent", "limit", "budget"]);
      return this.resolveSkill(args, memoryPolicy);
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

  async readWorkingContext(args, memoryPolicy) {
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
        memory: memoryPolicy.mode,
        project: memoryPolicy.projectSelector || project,
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
    const { digest, budget, generatedAt, projectFilter, operational, memoryMode, memoryReceipt } = envelope;
    const metadata = {
      memory: memoryMode,
      receipt: memoryReceipt,
      notice: null,
      complete: true,
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

  async resolveSkill(args, memoryPolicy) {
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
    return serializeBoundedSkillResults({ intent, matches, limit: budget, memoryPolicy });
  }

  async searchAios(args, memoryPolicy) {
    const query = requireString(args.query, "query", 500);
    const project = args.project === undefined
      ? undefined
      : requireString(args.project, "project", 200);
    const limit = args.limit === undefined ? 10 : boundedInteger(args.limit, "limit", 1, 20);
    const budget = args.budget === undefined
      ? DEFAULT_RESULT_BUDGET
      : boundedInteger(args.budget, "budget", MIN_SEARCH_RESULT_BUDGET, 32000);
    const scope = optionalString(args.scope) || "all";
    if (!SEARCH_SCOPES.includes(scope)) {
      throw protocolError(-32602, `scope must be one of: ${SEARCH_SCOPES.join(", ")}`);
    }
    if (scope === "projects" && !project) {
      throw protocolError(-32602, "project is required when scope is projects");
    }
    if (project) {
      try {
        validateProjectSelector(project);
      } catch (error) {
        throw protocolError(-32602, error.message);
      }
    }
    let reader = createEvidenceReader({ roots: [this.aiosPath] });
    const config = await this.readConfig(reader);
    const vaultPath = resolveVaultPath(config, this.aiosPath);
    reader = reader.withAuthorizedRoots([vaultPath]);
    let groups;
    try {
      groups = await searchAios({
        aiosPath: this.aiosPath,
        vaultPath,
        query,
        scope,
        limit,
        memoryPolicy,
        projectSelector: memoryPolicy.projectSelector || project,
        evidenceReader: reader
      });
    } catch (error) {
      if (String(error?.code || "").startsWith("DOTAIOS_PROJECT_SELECTOR_")) {
        throw protocolError(-32602, error.message);
      }
      throw error;
    }
    return serializeBoundedSearchResults({
      query,
      scope,
      scopeDetail: groups.scope.project
        ? { project: groups.scope.project, project_id: groups.scope.project_id }
        : groups.scope.projects_omitted
          ? { projects: "omitted" }
          : null,
      groups,
      omissions: groups.omissions,
      memoryPolicy: {
        mode: groups.memory,
        receipt: groups.receipt,
        notice: groups.notice,
      },
      limit: budget
    });
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
          memory: memoryModeSchema(),
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
          memory: memoryModeSchema(),
          query: { type: "string", minLength: 1, maxLength: 500 },
          scope: { type: "string", enum: SEARCH_SCOPES, default: "all" },
          project: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            pattern: "^[^\\s\\u0000-\\u001F\\u007F-\\u009F/\\\\]+$",
            description: "Optional canonical project slug or stable id. Required for project-only scope."
          },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
          budget: {
            type: "integer",
            minimum: MIN_SEARCH_RESULT_BUDGET,
            maximum: 32000,
            default: DEFAULT_RESULT_BUDGET,
            description: "Character budget for the complete serialized search response, including full omission metadata.",
          },
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
          memory: memoryModeSchema(),
          project: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Required only when memory is project. Skills remain capabilities rather than memory."
          },
          intent: { type: "string", minLength: 1, maxLength: 500 },
          limit: { type: "integer", minimum: 1, maximum: 10, default: 1 },
          budget: { type: "integer", minimum: 256, maximum: 32000, default: 6000 },
        },
        required: ["intent"],
      },
    },
  ];
}

function memoryModeSchema() {
  return {
    type: "string",
    enum: MEMORY_MODES,
    default: "shared",
    description: "Shared uses personal continuity, project requires a project selector, and off performs no DotAIOS read, search, save, or capture."
  };
}

function validateMcpToolArguments(name, args) {
  if (name === "read_working_context") {
    assertAllowedArguments(args, ["memory", "project", "limit", "budget"]);
    optionalString(args.project, "project", 200);
    if (args.limit !== undefined) boundedInteger(args.limit, "limit", 1, 10);
    if (args.budget !== undefined) boundedInteger(args.budget, "budget", 256, 32000);
    return;
  }
  if (name === "search_aios") {
    assertAllowedArguments(args, ["memory", "query", "scope", "project", "limit", "budget"]);
    requireString(args.query, "query", 500);
    const project = args.project === undefined
      ? undefined
      : requireString(args.project, "project", 200);
    const scope = optionalString(args.scope) || "all";
    if (!SEARCH_SCOPES.includes(scope)) {
      throw protocolError(-32602, `scope must be one of: ${SEARCH_SCOPES.join(", ")}`);
    }
    if (scope === "projects" && !project) {
      throw protocolError(-32602, "project is required when scope is projects");
    }
    if (project) {
      try {
        validateProjectSelector(project);
      } catch (error) {
        throw protocolError(-32602, error.message);
      }
    }
    if (args.limit !== undefined) boundedInteger(args.limit, "limit", 1, 20);
    if (args.budget !== undefined) {
      boundedInteger(args.budget, "budget", MIN_SEARCH_RESULT_BUDGET, 32000);
    }
    return;
  }
  if (name === "resolve_skill") {
    assertAllowedArguments(args, ["memory", "project", "intent", "limit", "budget"]);
    optionalString(args.project, "project", 200);
    requireString(args.intent, "intent", 500);
    if (args.limit !== undefined) boundedInteger(args.limit, "limit", 1, 10);
    if (args.budget !== undefined) boundedInteger(args.budget, "budget", 256, 32000);
    return;
  }
  throw protocolError(-32602, `Unknown tool: ${name}`);
}

function resolveMcpMemoryPolicy(args) {
  try {
    return resolveMemoryPolicy({ mode: args.memory, project: args.project });
  } catch (error) {
    if (error?.code === "DOTAIOS_MEMORY_POLICY_INVALID") {
      throw protocolError(-32602, error.message);
    }
    throw error;
  }
}

function serializeOffToolResult(name, args, policy) {
  const shared = {
    memory: policy.mode,
    receipt: policy.receipt,
    notice: policy.notice,
    complete: true
  };
  if (name === "read_working_context") {
    assertAllowedArguments(args, ["memory", "project", "limit", "budget"]);
    return JSON.stringify({
      markdown: `${policy.receipt}\n\n${policy.notice}`,
      scope: { project: null },
      ...shared
    }, null, 2);
  }
  if (name === "search_aios") {
    assertAllowedArguments(args, ["memory", "query", "scope", "project", "limit", "budget"]);
    return JSON.stringify({
      query: typeof args.query === "string" ? args.query : "",
      scope: typeof args.scope === "string" ? args.scope : "all",
      results: [],
      omissions: [],
      ...shared
    }, null, 2);
  }
  if (name === "resolve_skill") {
    assertAllowedArguments(args, ["memory", "project", "intent", "limit", "budget"]);
    return JSON.stringify({
      intent: typeof args.intent === "string" ? args.intent : "",
      matches: [],
      ...shared
    }, null, 2);
  }
  throw protocolError(-32602, `Unknown tool: ${name}`);
}

function serializeBoundedSearchResults({ query, scope, scopeDetail, groups, omissions = [], memoryPolicy, limit }) {
  const complete = omissions.length === 0;
  const selected = [];
  let truncated = false;
  outer: for (const group of groups) {
    for (const rawResult of group.results || []) {
      const result = sanitizeResultValue(rawResult);
      const candidate = [...selected, { scope: group.scope, ...result }];
      const candidateText = serializeSearchEnvelope({
        query, scope, scopeDetail, results: candidate, complete, omissions, memoryPolicy, limit, truncated: false
      });
      if (candidateText.length > limit) {
        truncated = true;
        break outer;
      }
      selected.push({ scope: group.scope, ...result });
    }
  }

  let boundedQuery = query;
  let serialized = serializeSearchEnvelope({
    query: boundedQuery, scope, scopeDetail, results: selected, complete, omissions, memoryPolicy, limit, truncated
  });
  while (serialized.length > limit && selected.length > 0) {
    selected.pop();
    truncated = true;
    serialized = serializeSearchEnvelope({
      query: boundedQuery, scope, scopeDetail, results: selected, complete, omissions, memoryPolicy, limit, truncated
    });
  }

  if (serialized.length > limit) {
    truncated = true;
    const fitted = fitSerializedString({
      value: boundedQuery,
      marker: SEARCH_QUERY_TRUNCATION_MARKER,
      limit,
      serialize: (candidate) => serializeSearchEnvelope({
        query: candidate,
        scope,
        scopeDetail,
        results: selected,
        complete,
        omissions,
        memoryPolicy,
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

function serializeBoundedSkillResults({ intent, matches, limit, memoryPolicy }) {
  const selected = [];
  let truncated = false;
  for (const rawMatch of matches) {
    const match = sanitizeResultValue(rawMatch, "", Number.POSITIVE_INFINITY);
    const candidate = [...selected, match];
    if (serializeSkillEnvelope({ intent, matches: candidate, memoryPolicy, limit, truncated: false }).length > limit) {
      truncated = true;
      break;
    }
    selected.push(match);
  }

  let boundedIntent = intent;
  let serialized = serializeSkillEnvelope({ intent: boundedIntent, matches: selected, memoryPolicy, limit, truncated });
  while (serialized.length > limit && selected.length > 0) {
    selected.pop();
    truncated = true;
    serialized = serializeSkillEnvelope({ intent: boundedIntent, matches: selected, memoryPolicy, limit, truncated });
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
        memoryPolicy,
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

function serializeSkillEnvelope({ intent, matches, memoryPolicy, limit, truncated }) {
  let used = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const serialized = JSON.stringify({
      intent,
      matches,
      memory: memoryPolicy.mode,
      receipt: memoryPolicy.receipt,
      notice: memoryPolicy.notice,
      complete: true,
      budget: { limit, used, truncated },
    }, null, 2);
    if (serialized.length === used) return serialized;
    used = serialized.length;
  }
  throw new Error("Could not stabilize skill response budget metadata");
}

function serializeSearchEnvelope({ query, scope, scopeDetail, results, complete, omissions, memoryPolicy, limit, truncated }) {
  const envelope = (used) => ({
    query,
    scope,
    memory: memoryPolicy.mode,
    receipt: memoryPolicy.receipt,
    notice: memoryPolicy.notice,
    ...(scopeDetail ? { scope_selection: scopeDetail } : {}),
    results,
    complete,
    omissions,
    budget: { limit, used, truncated },
  });
  // Keep the representation fixed so changing `used` cannot oscillate across the limit.
  const usePretty = JSON.stringify(envelope(limit), null, 2).length <= limit;
  let used = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = envelope(used);
    const serialized = usePretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
    if (serialized.length === used) return serialized;
    used = serialized.length;
  }
  throw new Error("Could not stabilize search response budget metadata");
}

function deriveMinimumSearchResultBudget() {
  const maximumOmissions = SEARCH_SCOPES
    // Shared searches cannot simultaneously select a strict project corpus.
    // Project mode has only three scopes, so eight Shared omissions are the
    // largest envelope users can actually request.
    .filter((scope) => scope !== "all" && scope !== "projects")
    .map((scope) => ({
      scope,
      reason: "directory_entries_exceeded",
      observed: {
        files: DEFAULT_EVIDENCE_READ_LIMITS.maxFiles + 1,
        bytes: DEFAULT_EVIDENCE_READ_LIMITS.maxBytes + 1,
        entries: DEFAULT_EVIDENCE_READ_LIMITS.maxEntries + 1,
      },
      inspection: "partially_enumerated",
      recovery: {
        code: "reduce_directory_entries",
        message: "Move some directory entries elsewhere, then retry the same search.",
      },
    }));
  let candidate = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const serialized = serializeSearchEnvelope({
      query: SEARCH_QUERY_TRUNCATION_MARKER,
      scope: "all",
      scopeDetail: { projects: "omitted" },
      results: [],
      complete: false,
      omissions: maximumOmissions,
      memoryPolicy: { mode: "shared", receipt: "Memory: Shared", notice: null },
      limit: candidate,
      truncated: true,
    });
    if (serialized.length === candidate) return candidate;
    candidate = serialized.length;
  }
  throw new Error("Could not derive the minimum search response budget");
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
