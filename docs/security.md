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

## Plugins

Plugins are trusted local folders. The manifest declares permissions, and the CLI prints them before install, but DotAIOS does not sandbox plugin code.

Current rule:

- Install only plugins you trust and have reviewed locally.
- Use `--dry-run` before install.
- Do not treat the current plugin system as a public marketplace.

Future marketplace work must add provenance, package verification, permission review, and stronger install failure recovery before remote installs are allowed.
