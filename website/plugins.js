// =====================================================================
// DotAIOS SKILLS — bundled slash commands
// Source: github.com/filocosta46/dotaios/tree/main/skills
// =====================================================================
// To add a new skill: append an object. Required: id, name, glyph,
// slash, tagline, category, author, price. Optional: longDescription,
// does[], doesnt[], tryit[], version.
// =====================================================================

window.AIOS_PLUGINS = [
  {
    id: "plan-today",
    name: "Plan today",
    slash: "/plan-today",
    glyph: "Pt",
    tagline: "Build a focused plan from your priorities and active work.",
    category: "Planning",
    author: "DotAIOS",
    price: "Included",
    version: "1.0",
    longDescription:
      "Reads your priorities, your active work, and recent signals — then proposes a few focused work blocks and names the one task you'd avoid otherwise (the 'frog'). Honors the planning style you set in the interview: how many priorities, how long the blocks, whether to use time-boxing.",
    does: [
      "Honors your planning style and priority count",
      "Names one 'frog' — the task you'd avoid",
      "Calls out one explicit non-priority for the day",
      "Surfaces dependencies and missing context",
    ],
    doesnt: [
      "Does not save a daily note (use /today for that)",
      "Does not read your calendar or email unless a plugin has captured signals",
      "Does not second-guess your priorities",
    ],
    tryit: [
      "plan my day",
      "what should I work on today?",
      "build me today's plan",
    ],
  },
  {
    id: "today",
    name: "Today",
    slash: "/today",
    glyph: "T",
    tagline: "Open today's note. Saves your plan to memory so you can come back to it.",
    category: "Planning",
    author: "DotAIOS",
    price: "Included",
    version: "1.0",
    longDescription:
      "Builds today's plan and writes it to memory/daily/YYYY-MM-DD.md with a structured close-out section already in place. If today's note already exists, it shows what's there and asks before updating it.",
    does: [
      "Writes a structured daily note with Focus, Plan, and Close sections",
      "Stages a close-out section ready for /closeday",
      "Logs the event to your operational memory",
    ],
    doesnt: [
      "Does not plan if your context is empty — asks you to run dotaios interview first",
      "Does not overwrite a close section that's already been filled in",
      "Does not touch external services",
    ],
    tryit: [
      "start my day",
      "open today's note",
      "build and save today's plan",
    ],
  },
  {
    id: "closeday",
    name: "Close day",
    slash: "/closeday",
    glyph: "Cd",
    tagline: "End the day in three questions. Carries unfinished tasks to tomorrow.",
    category: "Planning",
    author: "DotAIOS",
    price: "Included",
    version: "1.0",
    longDescription:
      "Asks three short questions — what got done, what didn't, what would you do differently — then fills today's note and stages any carry-over tasks into tomorrow's plan. The answers stay in your words; nothing gets paraphrased.",
    does: [
      "Asks one question at a time, end-of-day",
      "Logs done, carry-over, and a one-sentence reflection",
      "Creates tomorrow's note with carry-over tasks already in the plan",
    ],
    doesnt: [
      "Does not invent what you did — you answer, it writes",
      "Does not read email or calendar",
      "Does not overwrite a close section that already has content without asking",
    ],
    tryit: [
      "close my day",
      "I'm done for the day",
      "fill in my daily note",
    ],
  },
  {
    id: "weekly-review",
    name: "Weekly review",
    slash: "/weekly-review",
    glyph: "Wr",
    tagline: "Turn the week's memory into clearer context for next week.",
    category: "Memory",
    author: "DotAIOS",
    price: "Included",
    version: "1.0",
    longDescription:
      "Reads the past week of memory, daily notes, projects, and priorities. Groups findings into stale, repeated, blocked, and promotable — then recommends at most five small updates to your context, projects, or vault.",
    does: [
      "Identifies stale priorities and repeated work",
      "Calls out loose ends and candidate knowledge to promote",
      "Proposes at most five specific updates",
    ],
    doesnt: [
      "Does not rewrite identity, priorities, or vault without approval",
      "Does not treat memory as an infinite transcript",
      "Does not summarize private services unless you provide the output",
    ],
    tryit: [
      "review my AIOS from this week",
      "what should I update in my context?",
      "use weekly-review",
    ],
  },
  {
    id: "audit",
    name: "Audit",
    slash: "/audit",
    glyph: "A",
    tagline: "A weekly health check for your folder. Findings only — no changes.",
    category: "Memory",
    author: "DotAIOS",
    price: "Included",
    version: "1.0",
    longDescription:
      "A quick sanity check on your DotAIOS folder. Spots stale context, abandoned projects, and noisy memory before they bite. Returns findings in priority order plus one to three small fixes you can make today.",
    does: [
      "Checks context freshness — identity, work, priorities, north-star",
      "Checks project clarity, memory hygiene, connection health",
      "Suggests 1–3 specific maintenance actions",
    ],
    doesnt: [
      "Does not change any files — findings only",
      "Does not touch external services",
      "Not a substitute for your own weekly review",
    ],
    tryit: [
      "audit my AIOS",
      "give me a health check on my setup",
      "what's stale in my context?",
    ],
  },
  {
    id: "ingest",
    name: "Ingest",
    slash: "/ingest",
    glyph: "In",
    tagline: "Save any URL, PDF, or document into your vault as clean Markdown.",
    category: "Knowledge",
    author: "DotAIOS",
    price: "Included",
    version: "1.4",
    longDescription:
      "The Universal Knowledge Router. Throw any source at it — URL, PDF, .docx, .pptx, .epub, plain text — and get a clean Markdown copy your agents can read forever. The original is preserved in vault/assets/, so you never lose fidelity.",
    does: [
      "Saves articles as clean Markdown (strips ads and chrome)",
      "Extracts text from PDF, .docx, .pptx, .epub",
      "Keeps the original file alongside the Markdown",
      "Adds full provenance frontmatter so you know where everything came from",
    ],
    doesnt: [
      "Does not upload anything to the cloud — everything runs locally",
      "Does not bulk-ingest in one call (loop the command for batches)",
      "Does not fetch pages behind a login (save as PDF first)",
    ],
    tryit: [
      "save this URL: https://example.com/article",
      "ingest this PDF: ./research.pdf",
      "capture this article into my vault",
    ],
  },
  {
    id: "import-context",
    name: "Import context",
    slash: "/import-context",
    glyph: "Ic",
    tagline: "Bring what ChatGPT, Claude, or Gemini already knew about you into AIOS.",
    category: "Knowledge",
    author: "DotAIOS",
    price: "Included",
    version: "1.0",
    longDescription:
      "Take what you told another AI tool — ChatGPT, Claude, Gemini, Cursor — and route it into the right AIOS files. Builds a draft import you can preview before any write, and flags anything that looks like a secret so you keep it out of memory.",
    does: [
      "Sorts pasted context into identity, work, priorities, or projects",
      "Flags secrets before they end up in memory",
      "Dry-run by default — you always preview before applying",
    ],
    doesnt: [
      "Does not connect to ChatGPT, Claude, Gemini, or Cursor for you",
      "Does not overwrite without a preview",
      "Does not store API keys or credentials",
    ],
    tryit: [
      "I'm switching from ChatGPT — here's what it knew about me: …",
      "import this old chat into my AIOS",
      "merge what Gemini had on this project",
    ],
  },
  {
    id: "privacy-brief",
    name: "Privacy brief",
    slash: "/privacy-brief",
    glyph: "Pb",
    tagline: "Distill sensitive local context into a cloud-safe brief before you share.",
    category: "Privacy",
    author: "DotAIOS",
    price: "Included",
    version: "1.0",
    longDescription:
      "Before sending sensitive context to a cloud model, this skill writes a brief that keeps the useful decision-making bits and omits the rest. You see what stays in and what got left out — names of categories, never the secrets themselves.",
    does: [
      "Separates safe context from sensitive details",
      "Produces a cloud-safe brief you approve before sharing",
      "Lists what was omitted and why, by category",
    ],
    doesnt: [
      "Does not send anything to a cloud model itself",
      "Does not hide secrets inside summaries",
      "Not a substitute for legal or compliance redaction",
    ],
    tryit: [
      "make a cloud-safe brief of this email thread",
      "summarize this without exposing private details",
      "use privacy-brief on this folder before we ask Claude",
    ],
  },
  {
    id: "summarize-source",
    name: "Summarize source",
    slash: "/summarize-source",
    glyph: "Ss",
    tagline: "Turn an ingested article, PDF, or call note into a reusable local summary.",
    category: "Knowledge",
    author: "DotAIOS",
    price: "Included",
    version: "1.0",
    longDescription:
      "Once a source lives in your vault, this turns it into a concise summary your agents can lean on later — with provenance preserved. You choose how deep: minimal (key points + next actions) or detailed (evidence, decisions, risks, follow-ups).",
    does: [
      "Minimal or detailed depth, your call",
      "Preserves source, title, parser, and ingest date",
      "Recommends where the summary belongs — but asks before writing",
    ],
    doesnt: [
      "Does not transcribe audio or video by default",
      "Does not auto-promote raw notes to wiki",
      "Does not write durable wiki/org/context files without approval",
    ],
    tryit: [
      "summarize this source for my AIOS",
      "make a detailed summary of vault/raw/article.md",
      "turn these call notes into a reusable project summary",
    ],
  },
];
