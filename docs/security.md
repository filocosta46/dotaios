# Security

DotAIOS is local-first, but local files can still contain sensitive data. The safest rule is simple: memory files are for context, not secrets.

## Secrets

Users should store secrets in:

```text
~/aios/.env
```

Generated AIOS folders include a `.gitignore` that ignores:

- `.env`
- `.env.*`
- `credentials.*`
- `token.*`
- `*.pem`
- `*.key`

`.env.example` is safe to commit because it contains placeholders only.

Agents should never ask users to paste API keys, passwords, tokens, private keys, or OAuth client secrets into chat. They should name the required variable and ask the user to edit `.env` locally.

## Optional Connections

Google Workspace auth remains inside `gws`. DotAIOS requests the fixed read-only Gmail, Calendar, and Drive service set, and does not expose full, custom-scope, or custom-service login options. `gws auth status` does not verify the scopes of an existing grant, so broader grants must be revoked or re-authorized in `gws`. Google and `gws` process requested Workspace data. DotAIOS connection records contain neither OAuth material nor absolute binary paths. Google commands are not exposed through the read-only DotAIOS MCP adapter.

Lightpanda is never downloaded as an unattended default. Interactive setup requires confirmation, and non-interactive setup requires `--install-lightpanda`. Downloads use a pinned release and per-platform SHA-256 digest, stay non-executable while being verified, and move atomically into place only after verification. A failed or declined install leaves plain web fetch available.

## Plugins

Plugins can come from trusted local folders or trusted git URLs. The manifest declares permissions, and the CLI prints them before install, but DotAIOS does not sandbox plugin code.

Current rule:

- Install only plugins you trust and have reviewed locally.
- Use `--dry-run` before install.
- Do not treat the current plugin system as a public marketplace.

Git URL installs are supported, but they are still trust-based. Prefer known sources, run `npx dotaios@latest install <plugin> --dry-run`, and review permissions and source before install.

## Integration Safety Lanes

Use these lanes for Google Workspace, MCP tools, schedules, plugins, and agent workflows:

- Green: local DotAIOS reads such as context, search, schedules, skills, and memory inspection.
- Yellow: read external data into terminal or agent output, with source attribution and no automatic durable write.
- Red: send, edit, delete, move, label, archive, create events, or write durable context/wiki/org/CRM memory. Ask first.
- Black: OAuth secrets, refresh tokens, credential files, private keys, passwords, and API keys. Never paste these into chat or memory.
