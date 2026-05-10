# Context Import

Use context import when a user wants to bring useful knowledge from old ChatGPT, Claude, Gemini, Cursor, or other LLM chats into DotAIOS.

## Extraction Prompt

Paste this into the old chat or another LLM that can see the conversation you want to summarize:

```text
You are preparing a DotAIOS context import for me.

Read this conversation and extract only stable, useful context. Do not include secrets, API keys, passwords, tokens, private keys, or credentials. If you see anything sensitive, replace it with "[REDACTED]" and note that it belongs in ~/aios/.env.

Return valid JSON only, using this shape:

{
  "context": {
    "identity": "Durable facts about who I am, my background, preferences, values, communication style, or long-term goals.",
    "work": "Current active work threads and near-term project context.",
    "priorities": "Current priorities, bets, next actions, and anti-priorities.",
    "north_star": "Long-term direction and decision filters."
  },
  "projects": [
    {
      "slug": "project-slug",
      "name": "Project Name",
      "summary": "Durable project summary and current status.",
      "content": "# Project Name\n\nUseful project context."
    }
  ],
  "wiki": [
    {
      "topic": "topic-slug",
      "summary": "Reusable long-term knowledge.",
      "content": "# Topic\n\nUseful durable knowledge."
    }
  ],
  "companies": [
    {
      "name": "Company Name",
      "summary": "What matters about this company."
    }
  ],
  "people": [
    {
      "name": "Person Name",
      "summary": "Who this person is and why they matter."
    }
  ],
  "signals": [
    {
      "type": "chat-import",
      "project": "project-slug",
      "domain": "build",
      "summary": "Short-lived observation that may matter this week."
    }
  ],
  "events": [
    {
      "type": "context-import",
      "project": "project-slug",
      "domain": "build",
      "summary": "Meaningful durable import event."
    }
  ]
}

Rules:
- Keep entries concise.
- Prefer durable, reusable facts over transcript recap.
- Put short-term status in signals or events, not identity.
- Put people and companies only in people/companies.
- Do not invent missing details.
```

## CLI Flow

Preview first:

```bash
npx dotaios import ./import.json --dry-run
```

Apply only after reviewing the planned writes:

```bash
npx dotaios import ./import.json --apply
```

If the import contains secret-like terms, DotAIOS blocks apply by default. Move real secrets to `~/aios/.env`; use `--allow-sensitive` only after manual review.
