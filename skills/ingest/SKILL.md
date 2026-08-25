---
name: ingest
triggers: save this article, ingest this, archive this url, capture this pdf, read and save this link
description: Save a URL, PDF, document, text file, or binary into the AIOS vault as clean Markdown via the Universal Knowledge Router. Use when the user asks to save, archive, ingest, or capture an article, paper, or document.
when_to_use: save this article · ingest this · archive this url · capture this pdf · read and save this link
---

# ingest

Drop any URL or file into your AIOS and get a clean Markdown copy you can search later.

## Start here (non-technical)

If you only need the basics:

- Share a URL or file and say "save this to my AIOS."
- DotAIOS stores a readable copy in your local folder.
- If you want, say where it should go: "save this as wiki" or "save this as a company note."
- For private or paywalled pages, export PDF in your browser first, then ingest the PDF.

## What this does

- Saves articles from URLs as clean Markdown (strips ads and chrome).
- Extracts text from PDFs, `.docx`, `.pptx`, `.epub` (richer when `marker` is installed).
- Copies plain text, JSON, and CSV files verbatim with frontmatter.
- Routes an item to the right shelf by purpose with `--to` (raw, wiki, company, person, signal).
- Keeps the original file in `vault/assets/` so you never lose fidelity.
- Logs each ingest in `memory/events.jsonl` so it's searchable later.

## What this doesn't do

- It does not upload anything to a cloud service. Everything happens on your machine.
- It does not bulk-ingest in one call. Loop the command in a shell for batches.
- It does not guess the shelf from content. Routing is explicit: `--to`, or the one
  interactive question. With neither, it saves to `vault/raw` (today's default).
- It does not fetch pages behind a login. For paywalled content, save as PDF first and ingest that.

## How to use it

Try saying:

- "save this URL: <url>"
- "ingest this PDF: <path>"
- "capture this article into my vault"

Or run it directly:

```bash
npx dotaios@<exact-candidate-version> ingest <url-or-path>
npx dotaios@<exact-candidate-version> ingest <input> --to wiki --name <ref>   # route by purpose
npx dotaios@<exact-candidate-version> ingest <input> --dry-run                # preview the plan
npx dotaios@<exact-candidate-version> ingest <input> --overwrite              # replace existing
```

## Advanced details

## Shelf routing (`--to`)

`--to` decides **where** an item lands, by purpose. It is orthogonal to the input
type (URL/PDF/text), which only decides **how** the content is extracted.

| `--to` | Goes to | Needs `--name`? | Notes |
|---|---|---|---|
| `raw` (default) | `vault/raw/<slug>.md` | no | Rough source, today's behavior. |
| `wiki` | `vault/wiki/<slug>/_index.md` | optional (defaults to title) | Lasting reference. Durable shelf. |
| `company` | `vault/org/companies/<slug>.md` | **yes** | Org record. Durable shelf. |
| `person` | `vault/org/people/<slug>.md` | **yes** | Org record. Durable shelf. |
| `signal` | `memory/signals/<date>.jsonl` | no | Working note. Long sources are preserved in `vault/raw` and linked. |

If `<slug>.md` already exists on a durable shelf, the new content is **appended**
under a dated heading, it never overwrites.

**Durable shelves need approval.** `wiki`, `company`, and `person` write into
permanent knowledge. When you (an agent) run `--to wiki|company|person`
non-interactively, the command **previews** the destination and writes nothing.
Re-run with `--apply` once the user has confirmed. A human picking the shelf in
the interactive Terminal question counts as approval and writes immediately.

Examples:

```bash
npx dotaios@<exact-candidate-version> ingest report.pdf --to raw
npx dotaios@<exact-candidate-version> ingest https://example.com/post --to wiki --name ai-sales-research
npx dotaios@<exact-candidate-version> ingest company-brief.pdf --to company --name acme --apply
npx dotaios@<exact-candidate-version> ingest call-note.md --to signal
```

## Routing internals (what goes where)

The CLI command `npx dotaios@<exact-candidate-version> ingest <input>` is the routing authority. This skill mirrors that command. If anything conflicts with the CLI, the CLI wins, flag the conflict and update this file.

| Input | Path | Parser | Output |
|---|---|---|---|
| `http://` / `https://` URL | Path A: web scraper | linkedom + readability + turndown (lazy-loaded); PDF responses re-route to Path B | `vault/raw/<slug>.md` with frontmatter |
| `.pdf` | Path B: document parser | `marker_single` if installed, otherwise `unpdf` (basic text only) | `vault/raw/<slug>.md` + `vault/assets/<file>` |
| `.docx` / `.pptx` / `.epub` | Path B: document parser | `marker_single` required; without marker rejects with `MARKER_REQUIRED` | `vault/raw/<slug>.md` + `vault/assets/<file>` |
| `.md` / `.txt` / `.json` / `.csv` | Path C: text passthrough | copy with frontmatter (json/csv wrapped in fenced code blocks) | `vault/raw/<slug>.md` |
| anything else | Path D: binary fallthrough | byte-exact copy, no parse | `vault/assets/<file>` (no markdown) |

The **Output** column shows the default (`--to raw`). `--to wiki|company|person|signal`
changes the destination, see [Shelf routing](#shelf-routing---to) below. Binaries (Path D)
always go to `vault/assets/` regardless of `--to`.

## Frontmatter schema

Every markdown file written by ingest has this shape:

```yaml
---
source: <url or absolute path>
ingested_at: <ISO 8601 timestamp>
kind: web | pdf | document | text | binary
parser: readability+turndown | marker-local | unpdf | copy
title: <extracted title or filename stem>
tags: []
---
```

`tags` starts empty. Curation skills can populate it later when wiki backlinks ship.

## Flags

| Flag | Effect |
|---|---|
| `--to <shelf>` | Route by purpose: `raw` (default), `wiki`, `company`, `person`, `signal` |
| `--name <name>` | Record name; required for `company`/`person`, optional for `wiki` |
| `--apply` | Approve a durable write (`wiki`/`company`/`person`) when not interactive |
| `--path <dir>` | Use an AIOS folder other than `~/aios` |
| `--overwrite` | Replace an existing destination (default is skip-if-exists) |
| `--dry-run` | Classify the input and print the plan; no fetch, no spawn, no write |
| `--timeout <secs>` | URL fetch timeout (Path A only, default 10s) |

## Privacy

URL ingestion fetches the page from the user's machine to the user's machine. Documents are parsed locally with `marker` or `unpdf`. No content is uploaded to any cloud service. If a future change introduces an outbound parser, mention it in the command's `--help` text and update this skill.

Dynamic or paywalled pages, including some Substack pages, may ingest partial content. If the markdown ends abruptly or table-of-contents sections are missing, ask the user to save the logged-in page as a PDF from their browser and re-ingest that PDF.

## Bulk ingestion

There is no `--batch` flag. For multiple files or URLs, loop the single-file command:

```bash
for f in ~/Downloads/*.pdf; do
  npx dotaios@<exact-candidate-version> ingest "$f"
done
```

Each invocation appends one entry to `memory/events.jsonl`. Failures stop only that item; the next invocation continues.

## Marker install (optional, power user)

`marker_single` is a Python package from the Datalab project. It produces high-fidelity markdown for PDFs (tables, math, layout) and is the only way to ingest `.docx` / `.pptx` / `.epub` locally without going through PDF.

Before installing, prompt the user with the cost and confirm:

> This installs the `marker-pdf` Python package (~2 GB on disk including model weights). It runs entirely on your machine. Continue? [y/N]

If the user accepts, install with:

```bash
pip install marker-pdf
```

Then verify with `npx dotaios@<exact-candidate-version> status`, the **Ingest engines** section should show `Marker (local) : installed (<path>)`.

If declined or installation fails, PDFs continue to use the bundled `unpdf` text fallback. `.docx` / `.pptx` / `.epub` will still reject with `MARKER_REQUIRED` until marker is available.

## Agent steps

When the user asks to ingest:

- If the user's intent is clear ("save this company brief", "file this under acme"),
  pass `--to` and `--name` directly instead of dumping everything in `vault/raw`.
- For a durable shelf (`wiki`/`company`/`person`), the command will preview and not
  write. Show the user the previewed destination, confirm, then re-run with `--apply`.
- If intent is unclear, run plain `npx dotaios@<exact-candidate-version> ingest <input>` (saves to `vault/raw`) and
  ask the user where it should ultimately live.
- If the result is `Already ingested:`, ask whether the user wants `--overwrite` rather than re-running unprompted.
- If the result is a `MARKER_REQUIRED` error, offer the install prompt above before suggesting alternatives.
- For Path D (binary fallthrough), make it explicit that no markdown was generated and the file lives in `vault/assets/` only. `--to` does not apply to binaries.
- Do not duplicate the event log, the CLI handles `memory/events.jsonl`.

## Curation routing (post-ingest)

`--to` routes at ingest time. For items already sitting in `vault/raw/`, downstream
skills may still re-route them, re-ingest with the right `--to`, or move them:

- Promote to `vault/wiki/<topic>/_index.md` as a durable topic summary.
- Extract a company profile to `vault/org/companies/`.
- Extract a person profile to `vault/org/people/`.
- Save a writing sample to `vault/writing-style.md`.

Ask before durable writes to `vault/wiki/`, `vault/org/`, or `context/`, the `--apply`
gate enforces this for `ingest`. Do not duplicate companies or people in `memory/`.
Preserve the original `source` attribution from the raw file's frontmatter when promoting.
