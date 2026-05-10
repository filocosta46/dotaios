---
name: ingest
description: Save a URL, PDF, document, text file, or binary into the AIOS vault as clean Markdown via the Universal Knowledge Router. Use when the user asks to save, archive, ingest, or capture an article, paper, or document.
---

# ingest

Use this skill when the user asks to save a file, article, URL, PDF, document, note, or external material into AIOS.

The CLI command `dotaios ingest <input>` is the routing authority. This skill mirrors that command and adds bulk and curation guidance for agents. If anything in this skill conflicts with the CLI, the CLI wins — flag the conflict and update this file.

## Routing

`dotaios ingest <input>` classifies the input and writes to one of two locations:

| Input | Path | Parser | Output |
|---|---|---|---|
| `http://` / `https://` URL | A — web scraper | linkedom + cheerio + readability + turndown (lazy-loaded); PDF responses re-route to Path B | `vault/raw/<slug>.md` with frontmatter |
| `.pdf` | B — document parser | `marker_single` if installed, otherwise `unpdf` (basic text only) | `vault/raw/<slug>.md` + `vault/assets/<file>` |
| `.docx` / `.pptx` / `.epub` | B — document parser | `marker_single` required; without marker the command rejects with a `MARKER_REQUIRED` error | `vault/raw/<slug>.md` + `vault/assets/<file>` |
| `.md` / `.txt` / `.json` / `.csv` | C — text passthrough | copy with frontmatter (json/csv wrapped in fenced code blocks) | `vault/raw/<slug>.md` |
| anything else | D — binary fallthrough | byte-exact copy, no parse | `vault/assets/<file>` (no markdown) |

The original document is preserved at `vault/assets/` for every Path B and Path D ingest so users never lose fidelity.

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
| `--path <dir>` | Use an AIOS folder other than `~/aios` |
| `--overwrite` | Replace an existing destination (default behavior is skip-if-exists) |
| `--dry-run` | Classify the input and print the plan; no fetch, no spawn, no write |
| `--timeout <secs>` | URL fetch timeout (Path A only, default 10s) |

## Privacy

URL ingestion fetches the page from the user's machine to the user's machine. Documents are parsed locally with `marker` or `unpdf`. No content is uploaded to any cloud service. If a future change introduces an outbound parser, mention it in the command's `--help` text and update this skill.

Dynamic or paywalled pages, including some Substack pages, may ingest partial content. If the markdown ends abruptly or table-of-contents sections are missing, ask the user to save the logged-in page as a PDF from their browser and re-ingest that PDF.

## Bulk ingestion

There is no `--batch` flag in v1.4. For multiple files or URLs, loop the single-file command:

```bash
for f in ~/Downloads/*.pdf; do
  dotaios ingest "$f"
done
```

Each invocation appends one entry to `memory/events.jsonl`. Failures stop only that one item; the next invocation continues.

## Marker install (optional, power-user)

`marker_single` is a Python package from the Datalab project. It produces high-fidelity markdown for PDFs (tables, math, layout) and is the only way to ingest `.docx` / `.pptx` / `.epub` locally without going through PDF.

Before installing, prompt the user with the cost and confirm:

> This installs the `marker-pdf` Python package (~2 GB on disk including model weights). It runs entirely on your machine. Continue? [y/N]

If the user accepts, install with:

```bash
pip install marker-pdf
```

Then verify with `dotaios status` — the **Ingest engines** section should show `Marker (local) : installed (<path>)`.

If the user declines or installation fails, PDFs continue to use the bundled `unpdf` text fallback. `.docx` / `.pptx` / `.epub` will still reject with `MARKER_REQUIRED` until marker is available.

## Output guidance for agents

When the user asks you to ingest something:

- Run `dotaios ingest <input>` and report the destination path.
- If the result is `Already ingested:`, ask whether the user wants `--overwrite` rather than re-running unprompted.
- If the result is a `MARKER_REQUIRED` error, offer the install prompt above before suggesting alternatives.
- For Path D (binary fallthrough), make it explicit that no markdown was generated and the file lives in `vault/assets/` only.
- Append a short event to `memory/events.jsonl` is handled by the CLI; do not duplicate the entry.

## Curation routing (post-ingest)

Once a file lives in `vault/raw/`, downstream skills may decide to:

- Promote it to `vault/wiki/<topic>/_index.md` as a durable topic summary.
- Extract a company profile to `vault/org/companies/`.
- Extract a person profile to `vault/org/people/`.
- Save a writing sample to `vault/writing-style.md`.

Ask before durable writes to `vault/wiki/`, `vault/org/`, or `context/`. Do not duplicate companies or people in `memory/`. Preserve the original `source` attribution from the raw file's frontmatter when promoting.
