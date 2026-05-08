#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { appendEvent, searchMemory, searchVault } from "../../core/src/memory.mjs";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../core/src/paths.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = "0.1.0";

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
    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await this.handleLine(trimmed);
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

    if (!Object.hasOwn(message, "id")) {
      return;
    }

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
      const requestedVersion = message.params?.protocolVersion;
      return {
        protocolVersion: requestedVersion || PROTOCOL_VERSION,
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "dotaios-mcp",
          title: "DotAIOS MCP",
          version: SERVER_VERSION
        },
        instructions: "Use DotAIOS tools to read local context, search memory/vault, list projects, and log approved events."
      };
    }

    if (message.method === "ping") return {};
    if (message.method === "tools/list") return { tools: tools() };

    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      const result = await this.callTool(name, args);
      return textResult(result);
    }

    throw protocolError(-32601, `Method not found: ${message.method}`);
  }

  async callTool(name, args) {
    await this.assertAios();

    if (name === "read_context") return await this.readContext(args);
    if (name === "search_memory") return await this.searchMemory(args);
    if (name === "search_vault") return await this.searchVault(args);
    if (name === "list_projects") return await this.listProjects();
    if (name === "log_event") return await this.logEvent(args);

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

  async readContext(args) {
    const contextDir = path.join(this.aiosPath, "context");
    if (args.file) {
      const safeFile = safeRelativePath(args.file);
      const filePath = path.join(contextDir, safeFile);
      const content = await fs.readFile(filePath, "utf8");
      return JSON.stringify({ file: safeFile, content }, null, 2);
    }

    const files = await listMarkdownFiles(contextDir);
    const entries = [];
    for (const file of files) {
      const relative = path.relative(contextDir, file);
      entries.push({
        file: relative,
        content: await fs.readFile(file, "utf8")
      });
    }
    return JSON.stringify({ context: entries }, null, 2);
  }

  async searchMemory(args) {
    const query = requireString(args.query, "query");
    const limit = positiveInteger(args.limit || 10, "limit");
    const results = await searchMemory(path.join(this.aiosPath, "memory"), query, { limit });
    return JSON.stringify({ query, results }, null, 2);
  }

  async searchVault(args) {
    const query = requireString(args.query, "query");
    const limit = positiveInteger(args.limit || 10, "limit");
    const config = await this.readConfig();
    const vaultPath = resolveVaultPath(config, this.aiosPath);
    const results = await searchVault(vaultPath, query, { limit });
    return JSON.stringify({ query, vaultPath, results }, null, 2);
  }

  async listProjects() {
    const projectsDir = path.join(this.aiosPath, "projects");
    let entries;
    try {
      entries = await fs.readdir(projectsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    const projects = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: path.join(projectsDir, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return JSON.stringify({ projects }, null, 2);
  }

  async logEvent(args) {
    const type = requireString(args.type, "type");
    const event = await appendEvent(path.join(this.aiosPath, "memory", "events.jsonl"), {
      type,
      project: optionalString(args.project),
      domain: optionalString(args.domain),
      summary: optionalString(args.summary),
      source: optionalString(args.source || "mcp"),
      data: args.data
    });
    return JSON.stringify({ event }, null, 2);
  }

  write(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  writeError(id, code, message) {
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code, message }
    });
  }
}

function tools() {
  return [
    {
      name: "read_context",
      title: "Read Context",
      description: "Read DotAIOS context markdown files. Pass file for one context file, or omit it for all context.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Context file under context/, such as work.md or priorities.md." }
        }
      }
    },
    {
      name: "search_memory",
      title: "Search Memory",
      description: "Search DotAIOS memory events, archived events, and signals.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, default: 10 }
        },
        required: ["query"]
      }
    },
    {
      name: "search_vault",
      title: "Search Vault",
      description: "Search DotAIOS vault markdown files.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, default: 10 }
        },
        required: ["query"]
      }
    },
    {
      name: "list_projects",
      title: "List Projects",
      description: "List local DotAIOS projects.",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "log_event",
      title: "Log Event",
      description: "Append an approved structured event to DotAIOS memory.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string" },
          summary: { type: "string" },
          project: { type: "string" },
          domain: { type: "string" },
          source: { type: "string" },
          data: { type: "object" }
        },
        required: ["type"]
      }
    }
  ];
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

This starts a local stdio MCP server. It speaks newline-delimited JSON-RPC 2.0 over stdin/stdout.
`);
}

function textResult(text) {
  return {
    content: [{ type: "text", text }],
    isError: false
  };
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw protocolError(-32602, `${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(Number(value)) || Number(value) <= 0) {
    throw protocolError(-32602, `${name} must be a positive integer`);
  }
  return Number(value);
}

function safeRelativePath(value) {
  const normalized = path.normalize(value);
  if (path.isAbsolute(normalized) || normalized.startsWith("..")) {
    throw protocolError(-32602, "file must stay inside context/");
  }
  return normalized;
}

function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function listMarkdownFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }

  return results.sort();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
