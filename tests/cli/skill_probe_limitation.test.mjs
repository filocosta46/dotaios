import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  PROBE_CLIENTS,
  redactDiagnosticText
} from "../../packages/cli/src/lib/skill-invocation-probe.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("Claude probe enables the native Skill tool and not generic file reads", () => {
  const command = PROBE_CLIENTS["claude-code"].build({
    projectPath: "/tmp/project",
    prompt: "probe"
  });
  const toolsIndex = command.args.indexOf("--tools");

  assert.notEqual(toolsIndex, -1);
  assert.equal(command.args[toolsIndex + 1], "Skill");
  assert.doesNotMatch(command.args.join(" "), /--tools Read/);
  assert.deepEqual(command.receiptCommand.slice(-6), [
    "plan",
    "--tools",
    "Skill",
    "--setting-sources",
    "project",
    "<probe-prompt>"
  ]);
});

// A failing client usually says exactly what is wrong. Reporting only "client
// exceeded 90000ms" throws that away and leaves the user with a receipt they
// cannot act on — the same swallowed-error pattern this release exists to fix.
test("a failing client's own error reaches the receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-probe-"));
  const aios = path.join(root, "aios");
  assert.equal(
    spawnSync(process.execPath, [cli, "init", "--yes", "--path", aios], { encoding: "utf8" }).status,
    0
  );

  // Stand in for the real client, failing the way it actually failed here.
  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const fake = path.join(fakeBin, "claude");
  fs.writeFileSync(fake, [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "9.9.9 (Fake Claude Code)"; exit 0; fi',
    'echo "API Error: Usage credits required for 1M context; Authorization: Bearer sk-secret; api_key=topsecret; https://example.test/path?X-Amz-Signature=signedvalue; /Users/alice/private; alice@example.test" >&2',
    "exit 1"
  ].join("\n") + "\n");
  fs.chmodSync(fake, 0o755);

  const result = spawnSync(
    process.execPath,
    [cli, "skills", "probe", "--client", "claude-code", "--run", "--json", "--path", aios],
    { encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } }
  );

  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.evidence.produced, "no", "a failed client is never a pass");
  assert.match(
    `${receipt.limitation || ""}`,
    /Usage credits required/,
    `the client said why it failed; the receipt must carry it:\n${JSON.stringify(receipt, null, 1)}`
  );
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /sk-secret|topsecret|signedvalue|\/Users\/alice|alice@example\.test/
  );
  assert.match(receipt.limitation, /\[REDACTED\]/);
});

test("diagnostic redaction preserves useful context while removing common secrets", () => {
  const redacted = redactDiagnosticText(
    [
      "Login failed for bob@example.test at /home/bob/project",
      "Authorization: Bearer \"quoted-secret\"",
      "Authorization: Basic dXNlcjpwYXNz",
      "Authorization: ApiKey SHORTSECRETVALUE",
      "Proxy-Authorization: Basic Zm9vOmJhcg==",
      "Proxy-Authorization: AWS4-HMAC-SHA256 Credential=shortcred, Signature=shortsig",
      "Cookie: sid=abc123; theme=dark",
      "Set-Cookie: session=abc123; HttpOnly; Secure",
      "X-Session-Token: short-session-secret",
      '{"api_key":"json-secret","client_secret":"oauth-secret"}',
      "OPENAI_API_KEY=env-secret",
      "https://x.test/a?sig=xyz&code=oauth-code",
      "unlabelled-abcdefghijklmnopqrstuvwxyz123456"
    ].join("\n")
  );

  assert.match(redacted, /Login failed/);
  assert.doesNotMatch(
    redacted,
    /bob@example\.test|\/home\/bob|quoted-secret|dXNlcjpwYXNz|SHORTSECRETVALUE|Zm9vOmJhcg|shortcred|shortsig|abc123|short-session-secret|json-secret|oauth-secret|env-secret|xyz|oauth-code|abcdefghijklmnopqrstuvwxyz123456/
  );
  assert.match(redacted, /\[REDACTED\]/);
});

test("a marker from a failing client is not compatibility proof", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-probe-false-pass-"));
  const aios = path.join(root, "aios");
  assert.equal(
    spawnSync(process.execPath, [cli, "init", "--yes", "--path", aios], { encoding: "utf8" }).status,
    0
  );

  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const fake = path.join(fakeBin, "claude");
  fs.writeFileSync(fake, [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi',
    "marker=$(awk '/^CWD: <exact-process-working-directory>$/{getline;print;exit}' skills/dotaios-probe/SKILL.md)",
    'echo "$marker"',
    "exit 1"
  ].join("\n") + "\n");
  fs.chmodSync(fake, 0o755);

  const result = spawnSync(
    process.execPath,
    [cli, "skills", "probe", "--client", "claude-code", "--run", "--json", "--path", aios],
    { encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } }
  );
  const receipt = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(receipt.exitCode, 1);
  assert.equal(receipt.evidence.invoked, "yes");
  assert.equal(receipt.evidence.produced, "no");
});

test("live probe bounds and redacts untrusted client version output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-probe-version-"));
  const aios = path.join(root, "aios");
  assert.equal(
    spawnSync(process.execPath, [cli, "init", "--yes", "--path", aios], { encoding: "utf8" }).status,
    0
  );

  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const fake = path.join(fakeBin, "claude");
  fs.writeFileSync(fake, [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "Claude 9.9.9 /Users/alice/private alice@example.test token=version-secret"; exit 0; fi',
    "marker=$(awk '/^CWD: <exact-process-working-directory>$/{getline;print;exit}' skills/dotaios-probe/SKILL.md)",
    "printf 'CWD: %s\\n%s\\n' \"$PWD\" \"$marker\"",
    "exit 0"
  ].join("\n") + "\n");
  fs.chmodSync(fake, 0o755);

  const result = spawnSync(
    process.execPath,
    [cli, "skills", "probe", "--client", "claude-code", "--run", "--json", "--path", aios],
    { encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } }
  );
  const receipt = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(receipt.evidence.produced, "yes");
  assert.ok(receipt.clientVersion.length <= 160);
  assert.doesNotMatch(receipt.clientVersion, /\/Users\/alice|alice@example\.test|version-secret/);
  assert.match(receipt.clientVersion, /\[REDACTED\]/);
});

test("a failing client can explain itself on stdout when stderr is empty", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-probe-stdout-"));
  const aios = path.join(root, "aios");
  assert.equal(
    spawnSync(process.execPath, [cli, "init", "--yes", "--path", aios], { encoding: "utf8" }).status,
    0
  );

  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const fake = path.join(fakeBin, "claude");
  fs.writeFileSync(fake, [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "9.9.9 (Fake Claude Code)"; exit 0; fi',
    'echo "generic warning" >&2',
    'echo "Account plan does not permit this model"',
    "exit 1"
  ].join("\n") + "\n");
  fs.chmodSync(fake, 0o755);

  const result = spawnSync(
    process.execPath,
    [cli, "skills", "probe", "--client", "claude-code", "--run", "--json", "--path", aios],
    { encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } }
  );
  const receipt = JSON.parse(result.stdout);
  assert.match(receipt.limitation, /generic warning/);
  assert.match(receipt.limitation, /Account plan does not permit this model/);
});
