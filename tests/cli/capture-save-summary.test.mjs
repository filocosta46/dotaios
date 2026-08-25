import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { formatJsonlEntry } from "../../packages/core/src/jsonl.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const cleanupRoots = new Set();

after(() => {
  for (const root of cleanupRoots) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupRoots.add(root);
  return root;
}

function setupAios() {
  const tempRoot = makeTempRoot("dotaios-save-summary-test-");
  const aiosPath = path.join(tempRoot, "aios");
  const result = run(["init", "--path", aiosPath, "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  return { aiosPath, tempRoot };
}

function run(args, { input, rawInput, cwd = repoRoot, env = process.env } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env,
    encoding: "utf8",
    input: rawInput ?? (input === undefined ? undefined : `${JSON.stringify(input)}\n`),
  });
}

function runAsync(args, { input, cwd = repoRoot, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function sharedEnvelope(overrides = {}) {
  return {
    version: 1,
    operation_id: "save-session-0123456789abcdef",
    memory: { mode: "shared" },
    session: {
      agent: "codex",
      title: "Intentional save contract",
      summary: [
        "# Intentional save contract",
        "",
        "A bounded summary that deliberately omits its generated session ID.",
      ].join("\n"),
    },
    ...overrides,
  };
}

function serializeEnvelope(envelope, spacing = 0) {
  return `${JSON.stringify(envelope, null, spacing)}\n`;
}

function requestHash(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function operationHash(operationId) {
  return crypto.createHash("sha256").update(operationId).digest("hex");
}

function envelopeBytesOfSize(size) {
  const envelope = sharedEnvelope({
    operation_id: `save-session-boundary-${size}`,
    session: { ...sharedEnvelope().session, summary: "" },
  });
  const empty = serializeEnvelope(envelope);
  envelope.session.summary = "x".repeat(size - Buffer.byteLength(empty));
  const raw = serializeEnvelope(envelope);
  assert.equal(Buffer.byteLength(raw), size);
  return raw;
}

function readIndex(aiosPath) {
  const raw = fs.readFileSync(path.join(aiosPath, "memory", "sessions", "index.jsonl"), "utf8").trim();
  return raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
}

function writeIndex(aiosPath, entries) {
  fs.writeFileSync(
    path.join(aiosPath, "memory", "sessions", "index.jsonl"),
    entries.map(formatJsonlEntry).join(""),
  );
}

function addPortableProject(aiosPath, { id, slug }) {
  const projectPath = path.join(aiosPath, "projects", slug);
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, "README.md"),
    `---\nid: ${id}\nproject: ${slug}\nname: ${slug}\nstatus: active\ndomain: build\n---\n# ${slug}\n`,
  );
  return { id, slug };
}

function sessionMarkdownFiles(aiosPath) {
  const sessionsPath = path.join(aiosPath, "memory", "sessions");
  return fs.readdirSync(sessionsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => fs.readdirSync(path.join(sessionsPath, entry.name))
      .filter((name) => name.endsWith(".md"))
      .map((name) => path.join(sessionsPath, entry.name, name)));
}

function sessionTreeFiles(aiosPath) {
  const root = path.join(aiosPath, "memory", "sessions");
  const visit = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? visit(entryPath) : [path.relative(root, entryPath).split(path.sep).join("/")];
  });
  return visit(root).sort();
}

test("capture save-summary publishes the session file and index row before returning a verified receipt", () => {
  const { aiosPath } = setupAios();
  const envelope = sharedEnvelope();
  const raw = serializeEnvelope(envelope);

  const result = run(
    ["capture", "save-summary", "--path", aiosPath],
    { rawInput: raw },
  );

  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.status, "verified");
  assert.equal(receipt.operation_id, envelope.operation_id);
  assert.match(receipt.session_id, /^[0-9a-f]{8}$/);
  assert.match(receipt.path, /^memory\/sessions\/\d{4}-\d{2}-\d{2}\/.+\.md$/);
  assert.deepEqual(Object.keys(receipt), ["version", "status", "operation_id", "session_id", "path"]);
  assert.ok(Buffer.byteLength(result.stdout) < 512, "the success receipt stays deliberately small");

  const sessionPath = path.join(aiosPath, receipt.path);
  const session = fs.readFileSync(sessionPath, "utf8");
  assert.match(session, new RegExp(`\\noperation_id: "${envelope.operation_id}"\\n`));
  assert.match(session, new RegExp(`\\nrequest_hash: "${requestHash(raw)}"\\n`));
  assert.match(session, /# Intentional save contract/);

  const index = readIndex(aiosPath);
  assert.equal(index.length, 1);
  assert.equal(index[0].operation_id, envelope.operation_id);
  assert.equal(index[0].request_hash, requestHash(raw));
  assert.equal(index[0].session_id, receipt.session_id);
  assert.equal(index[0].path, receipt.path);
});

test("an exact operation retry returns the completed receipt without duplicating state", () => {
  const { aiosPath } = setupAios();
  const envelope = sharedEnvelope();
  const args = ["capture", "save-summary", "--path", aiosPath];

  const first = run(args, { input: envelope });
  const retry = run(args, { input: envelope });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.stdout, first.stdout);
  assert.equal(readIndex(aiosPath).length, 1);
});

test("a byte-different JSON envelope cannot reuse a completed operation", () => {
  const { aiosPath } = setupAios();
  const envelope = sharedEnvelope({ operation_id: "save-session-exact-envelope-bytes" });
  const args = ["capture", "save-summary", "--path", aiosPath];
  const compact = serializeEnvelope(envelope);
  const pretty = serializeEnvelope(envelope, 2);
  assert.notEqual(pretty, compact);

  const first = run(args, { rawInput: compact });
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(first.stdout);
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const sessionPath = path.join(aiosPath, receipt.path);
  const beforeIndex = fs.readFileSync(indexPath);
  const beforeSession = fs.readFileSync(sessionPath);

  const retry = run(args, { rawInput: pretty });

  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /operation reuse does not match/i);
  assert.deepEqual(fs.readFileSync(indexPath), beforeIndex);
  assert.deepEqual(fs.readFileSync(sessionPath), beforeSession);
});

test("reusing an operation ID for different summary bytes refuses without mutation", () => {
  const { aiosPath } = setupAios();
  const envelope = sharedEnvelope();
  const args = ["capture", "save-summary", "--path", aiosPath];
  const first = run(args, { input: envelope });
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(first.stdout);
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const sessionPath = path.join(aiosPath, receipt.path);
  const beforeIndex = fs.readFileSync(indexPath, "utf8");
  const beforeSession = fs.readFileSync(sessionPath, "utf8");

  const mismatch = run(args, {
    input: sharedEnvelope({
      session: {
        ...envelope.session,
        summary: "# A different summary\n\nThis operation ID is being reused incorrectly.",
      },
    }),
  });

  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /operation reuse does not match the original summary/i);
  assert.equal(fs.readFileSync(indexPath, "utf8"), beforeIndex);
  assert.equal(fs.readFileSync(sessionPath, "utf8"), beforeSession);
});

test("retry repairs the exact interrupted file-without-row state", () => {
  const { aiosPath } = setupAios();
  const envelope = sharedEnvelope();
  const args = ["capture", "save-summary", "--path", aiosPath];
  const first = run(args, { input: envelope });
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(first.stdout);
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const sessionPath = path.join(aiosPath, receipt.path);
  const publishedSession = fs.readFileSync(sessionPath, "utf8");

  // This is the only repairable interruption state: canonical frontmatter was
  // published, but the derived row was not.
  fs.writeFileSync(indexPath, "");
  const retry = run(args, { input: envelope });

  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.stdout, first.stdout);
  assert.deepEqual(readIndex(aiosPath).map((entry) => entry.operation_id), [envelope.operation_id]);
  assert.equal(sessionMarkdownFiles(aiosPath).length, 1);
  assert.equal(fs.readFileSync(sessionPath, "utf8"), publishedSession);
});

test("file-only repair refuses byte-different input using frontmatter request authority", () => {
  const { aiosPath } = setupAios();
  const envelope = sharedEnvelope({ operation_id: "save-session-file-only-byte-mismatch" });
  const compact = serializeEnvelope(envelope);
  const pretty = `${JSON.stringify(envelope, null, 2)}\n`;
  const args = ["capture", "save-summary", "--path", aiosPath];
  const first = run(args, { rawInput: compact });
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(first.stdout);
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const sessionPath = path.join(aiosPath, receipt.path);
  const publishedSession = fs.readFileSync(sessionPath);
  fs.writeFileSync(indexPath, "");

  const retry = run(args, { rawInput: pretty });

  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /operation reuse does not match/i);
  assert.deepEqual(readIndex(aiosPath), []);
  assert.deepEqual(fs.readFileSync(sessionPath), publishedSession);
});

test("repair keeps numeric-looking authority fields as strings", () => {
  const { aiosPath } = setupAios();
  const envelope = sharedEnvelope({ operation_id: "123" });
  const raw = serializeEnvelope(envelope);
  const capturedAt = "2026-08-25T12:34:56.000Z";
  const sessionId = "12345678";
  const relativePath = `memory/sessions/2026-08-25/2026-08-25T12-34-56_codex_123456_${operationHash(envelope.operation_id)}.md`;
  const markdown = [
    "---",
    'agent: "codex"',
    `session_id: "${sessionId}"`,
    'operation_id: "123"',
    `request_hash: "${requestHash(raw)}"`,
    `captured_at: "${capturedAt}"`,
    'source_type: "save-session"',
    "turns: 0",
    `title: ${JSON.stringify(envelope.session.title)}`,
    "schema: 1",
    "---",
    "",
    envelope.session.summary,
  ].join("\n");
  fs.mkdirSync(path.dirname(path.join(aiosPath, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, relativePath), markdown);

  const result = run(
    ["capture", "save-summary", "--path", aiosPath],
    { rawInput: raw },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    status: "verified",
    operation_id: "123",
    session_id: sessionId,
    path: relativePath,
  });
  assert.equal(readIndex(aiosPath)[0].session_id, sessionId);
});

test("repair refuses captured_at forms the writer cannot emit", () => {
  const mutations = [
    ["missing milliseconds", (value) => value.replace(/\.\d{3}Z$/, "Z")],
    ["lowercase z", (value) => value.replace(/Z$/, "z")],
    ["UTC offset", (value) => value.replace(/Z$/, "+00:00")],
    ["date only", (value) => value.slice(0, 10)],
    ["normalized invalid calendar", () => "2026-02-30T10:00:00.000Z"],
  ];

  for (const [label, mutateTimestamp] of mutations) {
    const { aiosPath } = setupAios();
    const envelope = sharedEnvelope({ operation_id: `save-session-timestamp-${label.replaceAll(" ", "-")}` });
    const args = ["capture", "save-summary", "--path", aiosPath];
    const first = run(args, { input: envelope });
    assert.equal(first.status, 0, `${label}: ${first.stderr}`);
    const receipt = JSON.parse(first.stdout);
    const sessionPath = path.join(aiosPath, receipt.path);
    const markdown = fs.readFileSync(sessionPath, "utf8");
    const capturedAt = markdown.match(/\ncaptured_at: "([^"]+)"\n/)[1];
    fs.writeFileSync(
      sessionPath,
      markdown.replace(
        `\ncaptured_at: "${capturedAt}"\n`,
        `\ncaptured_at: "${mutateTimestamp(capturedAt)}"\n`,
      ),
    );
    writeIndex(aiosPath, []);

    const retry = run(args, { input: envelope });

    assert.notEqual(retry.status, 0, label);
    assert.match(retry.stderr, /not canonical|reuse does not match/i, label);
    assert.deepEqual(readIndex(aiosPath), [], label);
  }
});

test("repair rejects invalid UTF-8 in a candidate session file", () => {
  const { aiosPath } = setupAios();
  const envelope = sharedEnvelope({ operation_id: "save-session-invalid-session-utf8" });
  const args = ["capture", "save-summary", "--path", aiosPath];
  const first = run(args, { input: envelope });
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(first.stdout);
  const sessionPath = path.join(aiosPath, receipt.path);
  const bytes = fs.readFileSync(sessionPath);
  const bodyOffset = bytes.indexOf(Buffer.from("bounded summary"));
  assert.notEqual(bodyOffset, -1);
  bytes[bodyOffset] = 0xff;
  fs.writeFileSync(sessionPath, bytes);
  writeIndex(aiosPath, []);

  const retry = run(args, { input: envelope });

  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /valid UTF-8/i);
  assert.deepEqual(readIndex(aiosPath), []);
});

test("ambiguous and unsafe recovery states refuse without mutation", () => {
  const cases = [
    {
      label: "row without file",
      mutate({ sessionPath }) { fs.unlinkSync(sessionPath); },
      error: /index row without its session file/i,
    },
    {
      label: "duplicate operation rows",
      mutate({ aiosPath }) {
        const [row] = readIndex(aiosPath);
        writeIndex(aiosPath, [row, row]);
      },
      error: /ambiguous/i,
    },
    {
      label: "duplicate operation files",
      mutate({ sessionPath }) {
        fs.copyFileSync(sessionPath, path.join(path.dirname(sessionPath), `duplicate-${path.basename(sessionPath)}`));
      },
      error: /ambiguous/i,
    },
    {
      label: "conflicting row claims the file and session ID",
      mutate({ aiosPath }) {
        const [row] = readIndex(aiosPath);
        delete row.operation_id;
        delete row.request_hash;
        row.title = "Unrelated index claimant";
        writeIndex(aiosPath, [row]);
      },
      error: /conflicting index row/i,
    },
    {
      label: "changed body without row",
      mutate({ aiosPath, sessionPath }) {
        writeIndex(aiosPath, []);
        fs.appendFileSync(sessionPath, "\nchanged after publication");
      },
      error: /reuse does not match/i,
    },
    {
      label: "source path in recovery authority",
      mutate({ aiosPath, sessionPath }) {
        writeIndex(aiosPath, []);
        const markdown = fs.readFileSync(sessionPath, "utf8");
        fs.writeFileSync(sessionPath, markdown.replace("\nturns: 0\n", '\nsource_path: "/tmp/request.json"\nturns: 0\n'));
      },
      error: /reuse does not match/i,
    },
    {
      label: "partial frontmatter still claims the operation",
      mutate({ aiosPath, sessionPath }) {
        writeIndex(aiosPath, []);
        fs.writeFileSync(sessionPath, '---\noperation_id: "save-session-0123456789abcdef"\n');
      },
      error: /invalid frontmatter/i,
    },
  ];

  for (const { label, mutate, error } of cases) {
    const { aiosPath } = setupAios();
    const envelope = sharedEnvelope();
    const args = ["capture", "save-summary", "--path", aiosPath];
    const first = run(args, { input: envelope });
    assert.equal(first.status, 0, `${label}: ${first.stderr}`);
    const receipt = JSON.parse(first.stdout);
    const sessionPath = path.join(aiosPath, receipt.path);
    mutate({ aiosPath, sessionPath, receipt });
    const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
    const beforeIndex = fs.readFileSync(indexPath, "utf8");
    const beforeFiles = sessionMarkdownFiles(aiosPath).map((file) => [file, fs.readFileSync(file, "utf8")]);

    const retry = run(args, { input: envelope });

    assert.notEqual(retry.status, 0, label);
    assert.match(retry.stderr, error, label);
    assert.equal(fs.readFileSync(indexPath, "utf8"), beforeIndex, label);
    assert.deepEqual(
      sessionMarkdownFiles(aiosPath).map((file) => [file, fs.readFileSync(file, "utf8")]),
      beforeFiles,
      label,
    );
  }
});

test("a same-operation row that disagrees with frontmatter refuses without mutation", () => {
  const { aiosPath } = setupAios();
  const envelope = sharedEnvelope({ operation_id: "save-session-row-frontmatter-mismatch" });
  const args = ["capture", "save-summary", "--path", aiosPath];
  const first = run(args, { input: envelope });
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(first.stdout);
  const sessionPath = path.join(aiosPath, receipt.path);
  const sessionBefore = fs.readFileSync(sessionPath);
  const [row] = readIndex(aiosPath);
  writeIndex(aiosPath, [{ ...row, title: "Index disagrees with frontmatter" }]);
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const indexBefore = fs.readFileSync(indexPath);

  const retry = run(args, { input: envelope });

  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /index and frontmatter do not match/i);
  assert.deepEqual(fs.readFileSync(indexPath), indexBefore);
  assert.deepEqual(fs.readFileSync(sessionPath), sessionBefore);
});

test("a malformed index refuses without quarantine or session publication", () => {
  const { aiosPath } = setupAios();
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  fs.writeFileSync(indexPath, "{not-json\n");

  const result = run(
    ["capture", "save-summary", "--path", aiosPath],
    { input: sharedEnvelope() },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /session index.*malformed/i);
  assert.equal(fs.readFileSync(indexPath, "utf8"), "{not-json\n");
  assert.equal(fs.existsSync(`${indexPath}.bad.jsonl`), false);
  assert.equal(sessionMarkdownFiles(aiosPath).length, 0);
});

test("summary publication refuses symlinked storage descendants without touching their targets", (t) => {
  if (process.platform === "win32") return t.skip("symlink creation is not portable on Windows");
  const cases = [
    {
      label: "sessions root",
      plant({ aiosPath, outside }) {
        const sessionsRoot = path.join(aiosPath, "memory", "sessions");
        fs.rmSync(sessionsRoot, { recursive: true, force: true });
        fs.symlinkSync(outside, sessionsRoot, "dir");
      },
    },
    {
      label: "date directory",
      plant({ aiosPath, outside }) {
        fs.symlinkSync(
          outside,
          path.join(aiosPath, "memory", "sessions", new Date().toISOString().slice(0, 10)),
          "dir",
        );
      },
    },
    {
      label: "index file",
      plant({ aiosPath, outside }) {
        const outsideIndex = path.join(outside, "outside-index.jsonl");
        fs.writeFileSync(outsideIndex, "");
        fs.symlinkSync(outsideIndex, path.join(aiosPath, "memory", "sessions", "index.jsonl"));
      },
    },
  ];

  for (const { label, plant } of cases) {
    const { aiosPath, tempRoot } = setupAios();
    const outside = path.join(tempRoot, `outside-${label.replaceAll(" ", "-")}`);
    fs.mkdirSync(outside);
    plant({ aiosPath, outside });
    const before = fs.readdirSync(outside).map((name) => [name, fs.readFileSync(path.join(outside, name))]);

    const result = run(["capture", "save-summary", "--path", aiosPath], {
      input: sharedEnvelope({ operation_id: `save-session-symlink-${label.replaceAll(" ", "-")}` }),
    });

    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, /unsafe|symbolic|symlink|not a directory/i, label);
    assert.deepEqual(
      fs.readdirSync(outside).map((name) => [name, fs.readFileSync(path.join(outside, name))]),
      before,
      label,
    );
  }
});

test("parseable but unusable index rows refuse before summary publication", () => {
  const valid = {
    session_id: "legacy-session",
    agent: "manual",
    captured_at: "2026-08-25T10:00:00.000Z",
    source_type: "import",
    turns: 1,
    title: "Legacy session",
    path: "memory\\sessions\\2026-08-25\\legacy-session.md",
    content_hash: "0123456789abcdef",
  };
  const cases = [
    ["missing required fields", {}],
    ["missing agent", { ...valid, agent: undefined }],
    ["missing source type", { ...valid, source_type: undefined }],
    ["missing turns", { ...valid, turns: undefined }],
    ["missing title", { ...valid, title: undefined }],
    ["empty agent", { ...valid, agent: "" }],
    ["empty source type", { ...valid, source_type: "" }],
    ["absolute path", { ...valid, path: "/tmp/outside.md" }],
    ["traversal path", { ...valid, path: "memory/sessions/../outside.md" }],
    ["control-file path", { ...valid, path: "memory/sessions/index.jsonl" }],
    ["invalid historical timestamp", { ...valid, captured_at: "2026-08-25 10:00:00Z" }],
    ["invalid historical calendar date", { ...valid, captured_at: "2026-02-30T10:00:00Z" }],
    ["invalid historical hour", { ...valid, captured_at: "2026-08-25T24:00:00Z" }],
    ["wrong searchable type", { ...valid, title: ["not", "text"] }],
    ["coerced content hash", { ...valid, content_hash: ["0123456789abcdef"] }],
    ["invalid operation request hash", {
      ...valid,
      operation_id: "save-session-invalid-row",
      source_type: "save-session",
      request_hash: "not-a-sha256",
    }],
    ["operation with legacy source type", {
      ...valid,
      operation_id: "save-session-invalid-source-type",
      request_hash: "a".repeat(64),
    }],
    ["operation missing content hash", {
      ...valid,
      operation_id: "save-session-missing-content-hash",
      source_type: "save-session",
      request_hash: "a".repeat(64),
      turns: 0,
      content_hash: undefined,
    }],
    ["operation with turns", {
      ...valid,
      operation_id: "save-session-invalid-turns",
      source_type: "save-session",
      request_hash: "a".repeat(64),
      turns: 1,
    }],
    ["operation with source path", {
      ...valid,
      operation_id: "save-session-invalid-source-path",
      source_type: "save-session",
      source_path: "/tmp/source.jsonl",
      request_hash: "a".repeat(64),
      turns: 0,
    }],
    ["operation with coerced request hash", {
      ...valid,
      operation_id: "save-session-coerced-request-hash",
      source_type: "save-session",
      request_hash: ["a".repeat(64)],
      turns: 0,
    }],
  ];

  for (const [label, row] of cases) {
    const { aiosPath } = setupAios();
    const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
    writeIndex(aiosPath, [row]);
    const before = fs.readFileSync(indexPath);

    const result = run(["capture", "save-summary", "--path", aiosPath], {
      input: sharedEnvelope({ operation_id: `save-session-malformed-${label.replaceAll(" ", "-")}` }),
    });

    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, /session index.*malformed/i, label);
    assert.deepEqual(fs.readFileSync(indexPath), before, label);
    assert.equal(sessionMarkdownFiles(aiosPath).length, 0, label);
  }
});

test("strict summary classification rejects duplicate decoded keys in an index row", () => {
  const { aiosPath } = setupAios();
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const duplicateAuthority = [
    '{"session_id":"shadow","session_id":"visible"',
    '"agent":"manual"',
    '"captured_at":"2026-08-25T10:00:00.000Z"',
    '"source_type":"import"',
    '"turns":1',
    '"title":"Duplicate authority"',
    '"path":"memory/sessions/2026-08-25/visible.md"',
    '"content_hash":"0123456789abcdef"}',
  ].join(",") + "\n";
  fs.writeFileSync(indexPath, duplicateAuthority);

  const result = run(["capture", "save-summary", "--path", aiosPath], {
    input: sharedEnvelope({ operation_id: "save-session-duplicate-index-key" }),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /session index.*malformed/i);
  assert.equal(fs.readFileSync(indexPath, "utf8"), duplicateAuthority);
  assert.equal(sessionMarkdownFiles(aiosPath).length, 0);
});

test("strict summary classification rejects invalid UTF-8 in the session index", () => {
  const { aiosPath } = setupAios();
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  fs.writeFileSync(indexPath, Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
  const before = fs.readFileSync(indexPath);

  const result = run(["capture", "save-summary", "--path", aiosPath], {
    input: sharedEnvelope({ operation_id: "save-session-invalid-index-utf8" }),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /session index.*malformed/i);
  assert.deepEqual(fs.readFileSync(indexPath), before);
  assert.equal(sessionMarkdownFiles(aiosPath).length, 0);
});

test("a valid legacy index row remains compatible with summary save and ID search", () => {
  const { aiosPath } = setupAios();
  const legacyRow = {
    session_id: "legacy-session-id",
    agent: "manual",
    captured_at: "2026-08-25T10:00:00.000Z",
    source_type: "import",
    turns: 1,
    title: "Legacy session",
    path: "memory\\sessions\\2026-08-25\\legacy-session.md",
    content_hash: "0123456789abcdef",
  };
  const legacyBodyPath = path.join(
    aiosPath,
    "memory",
    "sessions",
    "2026-08-25",
    "legacy-session.md",
  );
  fs.mkdirSync(path.dirname(legacyBodyPath), { recursive: true });
  fs.writeFileSync(legacyBodyPath, "# Legacy\n\nWINDOWS-LEGACY-BODY-CANARY");
  // A final newline is conventional, but valid legacy JSONL did not require it.
  fs.writeFileSync(
    path.join(aiosPath, "memory", "sessions", "index.jsonl"),
    JSON.stringify(legacyRow),
  );
  const saved = run(["capture", "save-summary", "--path", aiosPath], {
    input: sharedEnvelope({ operation_id: "save-session-with-legacy-index" }),
  });
  assert.equal(saved.status, 0, saved.stderr);
  const receipt = JSON.parse(saved.stdout);

  const search = run([
    "search", receipt.session_id,
    "--scope", "sessions",
    "--memory", "shared",
    "--path", aiosPath,
  ]);

  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, /Intentional save contract/);
  assert.match(search.stdout, /1 result\(s\) found\./);

  const legacySearch = run([
    "search", "WINDOWS-LEGACY-BODY-CANARY",
    "--scope", "sessions",
    "--memory", "shared",
    "--path", aiosPath,
  ]);
  assert.equal(legacySearch.status, 0, legacySearch.stderr);
  assert.match(legacySearch.stdout, /Legacy session/);
});

test("historical save-session index rows remain compatible with summary save", () => {
  const { aiosPath } = setupAios();
  const historicalRows = [
    {
      session_id: "historical-without-hash",
      agent: "grok",
      captured_at: "2026-08-18T16:54:35Z",
      source_type: "save-session",
      turns: 0,
      title: "Historical session without a hash",
      path: "memory/sessions/2026-08-18/historical-without-hash.md",
      project: "dotaios",
    },
    {
      session_id: "historical-offset-hash",
      agent: "claude",
      captured_at: "2026-08-24T21:15:38+02:00",
      source_type: "save-session",
      turns: 0,
      title: "Historical session with an offset and full hash",
      path: "memory/sessions/2026-08-24/historical-offset-hash.md",
      content_hash: `sha256:${"a".repeat(64)}`,
      project: "dotaios",
    },
    {
      session_id: "historical-tenth-second",
      agent: "codex",
      captured_at: "2026-08-24T19:15:38.1Z",
      source_type: "save-session",
      turns: 0,
      title: "Historical session with one fractional digit",
      path: "memory/sessions/2026-08-24/historical-tenth-second.md",
      project: "dotaios",
    },
    {
      session_id: "historical-microseconds",
      agent: "codex",
      captured_at: "2024-02-29T19:15:38.123456Z",
      source_type: "save-session",
      turns: 0,
      title: "Historical session with six fractional digits",
      path: "memory/sessions/2024-02-29/historical-microseconds.md",
      project: "dotaios",
    },
  ];
  writeIndex(aiosPath, historicalRows);

  const saved = run(["capture", "save-summary", "--path", aiosPath], {
    input: sharedEnvelope({ operation_id: "save-session-with-historical-index" }),
  });

  assert.equal(saved.status, 0, saved.stderr);
  const persisted = readIndex(aiosPath);
  assert.deepEqual(persisted.slice(0, historicalRows.length), historicalRows);
  assert.equal(persisted[historicalRows.length].operation_id, "save-session-with-historical-index");
});

test("an operation ID cannot cross Shared and Project scope", () => {
  const { aiosPath } = setupAios();
  const project = addPortableProject(aiosPath, { id: "project-alpha-id", slug: "alpha" });
  const envelope = sharedEnvelope();
  const args = ["capture", "save-summary", "--path", aiosPath];
  const first = run(args, { input: envelope });
  assert.equal(first.status, 0, first.stderr);
  const before = fs.readFileSync(path.join(aiosPath, "memory", "sessions", "index.jsonl"), "utf8");

  const retry = run(args, {
    input: { ...envelope, memory: { mode: "project", project } },
  });

  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /reuse does not match/i);
  assert.equal(fs.readFileSync(path.join(aiosPath, "memory", "sessions", "index.jsonl"), "utf8"), before);
});

test("Project saves require exact portable identity and stay isolated in public search", () => {
  const { aiosPath } = setupAios();
  const alpha = addPortableProject(aiosPath, { id: "project-alpha-id", slug: "alpha" });
  const beta = addPortableProject(aiosPath, { id: "project-beta-id", slug: "beta" });
  const canary = "PROJECT-SCOPE-CANARY";
  const saves = [
    sharedEnvelope({
      operation_id: "save-session-shared-scope",
      session: { agent: "codex", title: "Shared session", summary: `# Shared\n\n${canary}` },
    }),
    sharedEnvelope({
      operation_id: "save-session-alpha-scope",
      memory: { mode: "project", project: alpha },
      session: { agent: "codex", title: "Alpha session", summary: `# Alpha\n\n${canary}` },
    }),
    sharedEnvelope({
      operation_id: "save-session-beta-scope",
      memory: { mode: "project", project: beta },
      session: { agent: "codex", title: "Beta session", summary: `# Beta\n\n${canary}` },
    }),
  ];

  const receipts = saves.map((input) => {
    const result = run(["capture", "save-summary", "--path", aiosPath], { input });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  const rows = readIndex(aiosPath);
  const alphaRow = rows.find((row) => row.operation_id === "save-session-alpha-scope");
  assert.equal(alphaRow.project, alpha.slug);
  assert.equal(alphaRow.project_id, alpha.id);
  const alphaMarkdown = fs.readFileSync(path.join(aiosPath, receipts[1].path), "utf8");
  assert.match(alphaMarkdown, /\nproject: "alpha"\n/);
  assert.match(alphaMarkdown, /\nproject_id: "project-alpha-id"\n/);

  const search = run([
    "search", canary,
    "--scope", "sessions",
    "--memory", "project",
    "--project", alpha.slug,
    "--path", aiosPath,
  ]);
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, /Alpha session/);
  assert.match(search.stdout, /1 result\(s\) found\./);
  assert.doesNotMatch(search.stdout, /Shared session|Beta session/);

  const beforeIndex = fs.readFileSync(path.join(aiosPath, "memory", "sessions", "index.jsonl"), "utf8");
  const mismatch = run(["capture", "save-summary", "--path", aiosPath], {
    input: sharedEnvelope({
      operation_id: "save-session-project-mismatch",
      memory: { mode: "project", project: { id: alpha.id, slug: beta.slug } },
    }),
  });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /exactly match/i);
  assert.equal(fs.readFileSync(path.join(aiosPath, "memory", "sessions", "index.jsonl"), "utf8"), beforeIndex);
  assert.equal(sessionMarkdownFiles(aiosPath).length, 3);
});

test("Project save classification never opens unrelated session bodies", () => {
  if (process.platform === "win32") return;
  const { aiosPath } = setupAios();
  const project = addPortableProject(aiosPath, { id: "project-read-boundary-id", slug: "read-boundary" });
  const unrelated = run(["capture", "save-summary", "--path", aiosPath], {
    input: sharedEnvelope({ operation_id: "save-session-unrelated-unreadable" }),
  });
  assert.equal(unrelated.status, 0, unrelated.stderr);
  const unrelatedPath = path.join(aiosPath, JSON.parse(unrelated.stdout).path);
  fs.chmodSync(unrelatedPath, 0o000);

  try {
    const saved = run(["capture", "save-summary", "--path", aiosPath], {
      input: sharedEnvelope({
        operation_id: "save-session-project-does-not-open-unrelated",
        memory: { mode: "project", project },
      }),
    });

    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(readIndex(aiosPath).length, 2);
  } finally {
    fs.chmodSync(unrelatedPath, 0o600);
  }
});

test("public session search retrieves a saved summary by generated ID alone", () => {
  const { aiosPath } = setupAios();
  const envelope = sharedEnvelope({
    operation_id: "save-session-id-only-search",
    session: {
      agent: "codex",
      title: "ID-only retrieval proof",
      summary: "# ID-only retrieval proof\n\nThe generated identifier is deliberately absent from this prose.",
    },
  });
  const saved = run(["capture", "save-summary", "--path", aiosPath], { input: envelope });
  assert.equal(saved.status, 0, saved.stderr);
  const receipt = JSON.parse(saved.stdout);
  const markdown = fs.readFileSync(path.join(aiosPath, receipt.path), "utf8");
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n\n/, "");
  assert.equal(body.includes(receipt.session_id), false, "the body prose must not repeat the generated ID");

  const distractor = run(["capture", "save-summary", "--path", aiosPath], {
    input: sharedEnvelope({
      operation_id: "save-session-id-search-distractor",
      session: {
        agent: "codex",
        title: `${receipt.session_id} fuzzy distractor`,
        summary: "# Newer distractor\n\nThis prose does not contain the target identifier.",
      },
    }),
  });
  assert.equal(distractor.status, 0, distractor.stderr);

  const search = run([
    "search", receipt.session_id,
    "--scope", "sessions",
    "--memory", "shared",
    "--limit", "1",
    "--path", aiosPath,
  ]);

  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, /ID-only retrieval proof/);
  assert.doesNotMatch(search.stdout, /fuzzy distractor/);
  assert.match(search.stdout, /1 result\(s\) found\./);
});

test("concurrent identical operations collapse to one verified record and no prepared journal", async () => {
  const { aiosPath } = setupAios();
  const envelope = sharedEnvelope({ operation_id: "save-session-concurrent-proof" });
  const args = ["capture", "save-summary", "--path", aiosPath];

  const results = await Promise.all(Array.from({ length: 6 }, () => runAsync(args, { input: envelope })));

  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(new Set(results.map((result) => result.stdout)).size, 1);
  const receipt = JSON.parse(results[0].stdout);
  assert.equal(readIndex(aiosPath).length, 1);
  assert.equal(sessionMarkdownFiles(aiosPath).length, 1);
  assert.deepEqual(sessionTreeFiles(aiosPath), ["index.jsonl", receipt.path.replace("memory/sessions/", "")].sort());
});

test("frontmatter-bearing fields reject control characters before AIOS access", () => {
  const tempRoot = makeTempRoot("dotaios-save-summary-invalid-");
  const missingAiosPath = path.join(tempRoot, "must-not-exist");
  const envelope = sharedEnvelope({
    session: {
      ...sharedEnvelope().session,
      title: "unsafe\nschema: 99",
    },
  });

  const result = run(
    ["capture", "save-summary", "--path", missingAiosPath],
    { input: envelope },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /title/i);
  assert.equal(fs.existsSync(missingAiosPath), false);
});

test("Memory Off refuses before opening the selected AIOS path", () => {
  const tempRoot = makeTempRoot("dotaios-save-summary-off-");
  const missingAiosPath = path.join(tempRoot, "must-not-exist");

  const result = run(
    ["capture", "save-summary", "--path", missingAiosPath],
    { input: sharedEnvelope({ memory: { mode: "off" } }) },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Memory Off/i);
  assert.equal(fs.existsSync(missingAiosPath), false);
});

test("duplicate decoded JSON keys refuse before selecting a memory mode or AIOS path", () => {
  const tempRoot = makeTempRoot("dotaios-save-summary-duplicate-keys-");
  const shared = serializeEnvelope(sharedEnvelope()).trimEnd();
  const project = serializeEnvelope(sharedEnvelope({
    memory: { mode: "project", project: { id: "project-id", slug: "project-slug" } },
  })).trimEnd();
  const cases = [
    ["top-level", shared.replace('{"version":1,', '{"version":1,"version":1,')],
    ["memory authority", shared.replace('{"mode":"shared"}', '{"mode":"off","mode":"shared"}')],
    ["escaped memory authority", shared.replace('{"mode":"shared"}', '{"m\\u006fde":"off","mode":"shared"}')],
    ["session field", shared.replace('"agent":"codex"', '"agent":"codex","agent":"codex"')],
    ["project identity", project.replace('"id":"project-id"', '"id":"other-id","id":"project-id"')],
  ];

  for (const [label, rawInput] of cases) {
    const missingAiosPath = path.join(tempRoot, label.replaceAll(" ", "-"));
    const result = run(
      ["capture", "save-summary", "--path", missingAiosPath],
      { rawInput: `${rawInput}\n` },
    );
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, /sets "[^"]+" twice/i, label);
    assert.equal(fs.existsSync(missingAiosPath), false, label);
  }
});

test("unsafe summary control characters refuse before AIOS access", () => {
  const tempRoot = makeTempRoot("dotaios-save-summary-controls-");
  const cases = [
    ["escape", "Unsafe \u001b control"],
    ["C1", "Unsafe \u0085 control"],
    ["bidi override", "Unsafe \u202e control"],
    ["Arabic letter mark", "Unsafe \u061c control"],
    ["left-to-right mark", "Unsafe \u200e control"],
    ["bare carriage return", "Unsafe\rforged line"],
  ];

  for (const [label, summary] of cases) {
    const missingAiosPath = path.join(tempRoot, label.replaceAll(" ", "-"));
    const result = run(["capture", "save-summary", "--path", missingAiosPath], {
      input: sharedEnvelope({ session: { ...sharedEnvelope().session, summary } }),
    });
    assert.notEqual(result.status, 0, label);
    assert.match(
      result.stderr,
      /summary must be non-empty Markdown without unsafe control characters/i,
      label,
    );
    assert.equal(fs.existsSync(missingAiosPath), false, label);
  }
});

test("invalid versions, fields, mode combinations, and options refuse before mutation", () => {
  const tempRoot = makeTempRoot("dotaios-save-summary-invalid-matrix-");
  const cases = [
    ["unknown version", sharedEnvelope({ version: 2 })],
    ["unknown top-level options", { ...sharedEnvelope(), options: { arbitrary: true } }],
    ["shared with project", sharedEnvelope({ memory: { mode: "shared", project: { id: "p", slug: "p" } } })],
    ["project without identity", sharedEnvelope({ memory: { mode: "project" } })],
    ["unknown memory mode", sharedEnvelope({ memory: { mode: "private" } })],
    ["unknown session option", sharedEnvelope({ session: { ...sharedEnvelope().session, arbitrary: true } })],
    ["unsafe operation ID", sharedEnvelope({ operation_id: "../not-safe" })],
  ];

  for (const [label, envelope] of cases) {
    const missingAiosPath = path.join(tempRoot, label.replaceAll(" ", "-"));
    const result = run(
      ["capture", "save-summary", "--path", missingAiosPath],
      { input: envelope },
    );
    assert.notEqual(result.status, 0, label);
    assert.equal(fs.existsSync(missingAiosPath), false, label);
  }

  const optionPath = path.join(tempRoot, "unknown-cli-option");
  const unknownOption = run(
    ["capture", "save-summary", "--project", "anything", "--path", optionPath],
    { input: sharedEnvelope() },
  );
  assert.notEqual(unknownOption.status, 0);
  assert.equal(fs.existsSync(optionPath), false);
});

test("malformed, invalid UTF-8, and bounded stdin enforce the exact byte contract", () => {
  const tempRoot = makeTempRoot("dotaios-save-summary-bounds-");
  const malformedPath = path.join(tempRoot, "malformed");
  const malformed = run(
    ["capture", "save-summary", "--path", malformedPath],
    { rawInput: "{not-json\n" },
  );
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /not valid JSON/i);
  assert.equal(fs.existsSync(malformedPath), false);

  const invalidUtf8Path = path.join(tempRoot, "invalid-utf8");
  const invalidUtf8 = run(
    ["capture", "save-summary", "--path", invalidUtf8Path],
    { rawInput: Buffer.from([0xff, 0xfe]) },
  );
  assert.notEqual(invalidUtf8.status, 0);
  assert.match(invalidUtf8.stderr, /not valid UTF-8/i);
  assert.equal(fs.existsSync(invalidUtf8Path), false);

  const { aiosPath } = setupAios();
  const accepted = run(
    ["capture", "save-summary", "--path", aiosPath],
    { rawInput: envelopeBytesOfSize(65_535) },
  );
  assert.equal(accepted.status, 0, accepted.stderr);

  const boundaryPath = path.join(tempRoot, "exact-boundary");
  const boundary = run(
    ["capture", "save-summary", "--path", boundaryPath],
    { rawInput: envelopeBytesOfSize(65_536) },
  );
  assert.notEqual(boundary.status, 0);
  assert.match(boundary.stderr, /65536-byte limit/i);
  assert.equal(fs.existsSync(boundaryPath), false);
});
