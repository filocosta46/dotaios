# Website design brief — hand to Claude (design / artifacts)

**How to use this:** paste everything below the line into Claude (the design/artifact
surface). If you can, attach screenshots of the visual references named in the brief
(hyperspell.com, t1energy.com, perplexity.ai, apple.com). Claude returns a complete,
self-contained landing page that drops into `website/` (replacing `index.html` +
`styles.css`).

---

You are a **senior product designer + front-end engineer** with a strong, opinionated
visual taste. I want you to design and build a **complete, production-grade marketing
landing page** for a product called **DotAIOS**. This is a redesign — a previous version
exists and I'll tell you exactly how to read it and what to keep. Aim for something a
top-tier YC / Silicon-Valley dev tool would ship: **simple, calm, confident, and quietly
innovative** — not busy, not "AI-slop".

## Deliverable + constraints (hard)
- Return **one self-contained `index.html` + one `styles.css`**, plus inline vanilla JS
  only (the animated graph below + copy buttons + scroll-reveal). **No framework, no build
  step, no React, no Tailwind, no CDN UI libraries.** It must deploy as static files and
  load instantly on Vercel.
- Everything must work with JS disabled (content visible; only animation/reveal degrade).
- Responsive and elegant down to 360px. Accessible: semantic landmarks, skip link, visible
  focus rings, AA contrast, and a `prefers-reduced-motion` path that freezes the graph and
  disables reveals.

## Where this lives / how to read the current version
- Repo: `https://github.com/filocosta46/dotaios`, folder `website/`.
- The current site you are replacing: `website/index.html` + `website/styles.css`
  (a dark static page). **Read it to inherit the real copy, FAQ answers, and the install
  one-liner — do not invent new product claims.**
- The previous site had a hero animation I loved and want to **bring back as the
  centerpiece**: `website/graph.jsx` (an Obsidian-style self-building knowledge graph,
  described in detail below). You're rebuilding it as framework-free canvas JS.
- Keep `website/registry.json` untouched (the test suite reads it). You only output
  `index.html` + `styles.css`.

## What DotAIOS is (the truth — never embellish)
DotAIOS is **one plain-text folder on your computer** — `~/aios/` — that holds your
context, your memory, and the skills you want your AI to run. Every AI coding agent on your
machine (Claude Code, Cursor, Codex, Gemini CLI, OpenCode, and anything that reads an
`AGENTS.md` file) reads from that same folder. You tell your AI who you are, what you're
working on, and how you like to work **once**, and every tool knows.

Messaging truths (keep all, invent none):
- Local-first. Plain Markdown/JSON you own and can open in any editor.
- No account, no server we run, no cloud database.
- Optional sync is to **your own private GitHub repo** (opt-in).
- Open source, MIT, free.
- Hero analogy: `.gitconfig` makes Git know your name; `~/aios/` makes every AI know your life.
- Primary CTA is **copy a one-line prompt**, never "book a demo".

The one-line install prompt (must appear with a copy button):
`Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.`
Secondary, in a disclosure for terminal users: `npx dotaios setup`.

## Audience (do not drift)
**Non-technical people.** Onboarding is agent-led: paste one sentence into an AI agent and
it installs everything — the user never opens a terminal. Tone: warm, plain, confident.
No enterprise jargon.

## Aesthetic direction — the important part
I want something **much more refined** than a typical dev-tool template. Study these and
take a *specific* thing from each:

- **Apple** → restraint and rhythm. Huge whitespace, one idea per screen, type does the
  work, motion is subtle and purposeful. Steal the **calm pacing**.
- **Perplexity** → clean, near-monochrome surfaces with one confident accent; crisp cards;
  nothing shouts. Steal the **editorial cleanliness**.
- **Hyperspell** → modern SV dev-tool polish; tasteful depth. Steal the **product
  confidence**.
- **t1energy.com** → big mission-statement typography, generous scroll storytelling, and an
  **exploded technical diagram with thin annotation lines**. Steal the **annotated-diagram
  device** — apply it to the `~/aios/` folder anatomy.

Commit to **one coherent palette**. My lean (recommended): a **refined, near-monochrome
canvas** (very dark `~#0b0c0e` *or* a clean off-white `~#fafafa` — pick one and own it)
with **a single restrained accent** and **lots of negative space**. The page should feel
expensive and quiet, and the **self-building graph is the one "wow" moment** — let it
breathe, don't compete with it. Avoid: rainbow gradients, glassmorphism overload, generic
purple-on-white, stocky hero illustrations.

### Fonts (explicit — do NOT use the defaults)
I specifically do **not** want the system/Inter/Roboto/`ui-sans-serif` look that design
tools fall back to. Load real, refined typefaces via Google Fonts with `display=swap` +
preconnect:
- **Display / headlines:** a precise modern grotesk or refined serif — pick one and use it
  decisively. Good options: **Geist**, **General Sans**, or **Söhne-like** grotesks for the
  clean SV feel; or a tight editorial serif (**Fraunces**, **Newsreader**) if you go the
  Apple/editorial route. Headlines large, tight tracking.
- **Body:** **Geist** or **Hanken Grotesk** — high legibility, slightly warm.
- **Mono (folder tree / code):** **Geist Mono**, **JetBrains Mono**, or **IBM Plex Mono**.
Use a real type scale (clear jumps, not 5 sizes one px apart) and a consistent baseline rhythm.

## The signature hero: the self-building knowledge graph (centerpiece — get this right)
Rebuild, as **framework-free `<canvas>` + requestAnimationFrame**, an animation where a
personal knowledge graph **grows and wires itself together**, like an Obsidian graph
assembling in real time. This is the emotional core of the page.

Behavior (port from the old `website/graph.jsx` — same idea, refined for this palette):
- A central node `~/aios/` appears first. Over ~30s, child nodes spawn on a timed script
  and connect to their parent with an **edge that draws itself** (a short tracer animation),
  then settle via light force-directed repulsion + gentle centering.
- Four colored categories radiate out (use restrained, palette-coherent hues, not loud):
  **context** (who you are), **memory** (what's recent), **vault** (what you've read),
  **skills** (what your AI can do).
- Representative nodes (mirror the real folder): `identity`, `work`, `priorities`,
  `north star`, `preferences`; `memory → daily notes, events, signals`;
  `vault → raw clippings, wiki, people · companies, summaries`;
  `skills → /today, /closeday, /ingest, /audit, /weekly-review`.
- Then a "growth" phase adds incoming knowledge (`article saved`, `paper saved`,
  `today`, `colleague`, `company`…) and **cross-links form by themselves** between related
  nodes (e.g. `daily → work`, `wiki → priorities`, `weekly → memory`) — softer/secondary
  styling than parent edges.
- Newly born nodes get a soft halo that fades; labels fade in just after the dot.
- Small live readout in a corner: `files NN · links NN · last + <label>`, plus a tiny
  category legend. Loop gracefully (fade out, restart).
- Honor `prefers-reduced-motion`: render the **final settled graph** as a static frame.
- Keep it lightweight (cap DPR at 2, no per-frame allocations in the hot loop).

The old file's growth script, category list, and cross-link timing are a good blueprint —
keep the *feel* (calm, intentional, self-assembling), restyle the *look* to this palette.

## Page structure (use this content)
1. **Sticky top nav** — wordmark "DotAIOS" + small accent logo mark; links: Features,
   How it works, Plugins, FAQ, GitHub; a pill "Get started" CTA.
2. **Hero** — eyebrow "Open source · local-first · no account"; a big, calm headline on the
   one-folder idea; a one-paragraph lede; two buttons (primary "Get started free" → #install,
   ghost "View on GitHub"); and **the self-building graph as the dominant visual** (right
   side on desktop, full-width below the fold on mobile).
3. **Annotated folder anatomy** (the t1energy device) — a `~/aios/` tree rendered in a
   mono card with **thin annotation lines** pointing to short plain-language explanations
   (`context/identity.md` → "who you are", `memory/` → "what happened recently",
   `vault/` → "things you saved", `skills/` → "what your AI can run", `AGENTS.md` →
   "the file every agent reads"). End with a "reads into → Claude Code · Cursor · Gemini ·
   Codex" row.
4. **Agent row** — "Works with the agents you already use": Claude Code, Cursor, Codex,
   Gemini CLI, OpenCode, + anything that reads AGENTS.md.
5. **Features** (3 calm cards): "One folder, every agent"; "Continuity between sessions"
   (a working-memory digest injected at session start); "Turn anything into memory"
   (ingest a URL/PDF into your vault).
6. **Statement band** (big, centered, lots of air): "Your AI relearns who you are
   ~~every single session.~~ DotAIOS gives it one folder to read instead — local, plain
   text, and yours."
7. **How it works** (3 steps, zero command line): 1) Tell an AI to set it up; 2) Every tool
   connects automatically; 3) Ask in plain English.
8. **Plugins & Skills directory** — see the dedicated section below.
9. **Trust** (4 items): Local by default; No account, no cloud; Sync is your own GitHub;
   Open source (MIT).
10. **Install band** — "Open your AI agent and paste this line." with the one-line prompt in
    a copy field + a `<details>` disclosure for the `npx dotaios setup` alternative.
11. **FAQ** (native `<details>` accordion): Do I need to be technical? Where does my data
    live? Which AI tools work? Can it follow me across devices? Is it free and open source?
    (Answer truthfully per the messaging above — pull exact answers from the current site.)
12. **Final CTA + footer** (Product / Docs / Project columns; GitHub link).

## Plugins & Skills directory (design now, CMS-wired later)
This is a future content section, but **design it now** so it's ready to wire to a CMS.

- **What it is:** a simple, browsable directory of **plugins and skills** people can add to
  their `~/aios/`. **Not an e-commerce store** — no carts, no prices, no checkout. Each entry
  is just: a name, a one-line description, an icon/tag, a short "what it does", a "how to
  plug it into DotAIOS" snippet (the one-line/agent prompt or `dotaios install` command), and
  a **download / source link** (which may point elsewhere, e.g. a GitHub repo).
- **On the landing page:** show a tasteful **preview grid** of ~6 cards (use realistic
  placeholder entries — e.g. "Calendar agenda", "Web → Markdown ingest", "Daily brief",
  "Close the day", "People & companies", "Weekly review") with a "Browse all" affordance.
  Each card opens a **detail view** (can be a separate static `plugin.html`-style template
  or an in-page modal/route) with the description + the "how to add it" snippet + download
  link.
- **Architecture note for me (include as an HTML comment block at the top of `index.html`,
  and a short paragraph in your reply):** structure the plugin/skill data so it can later be
  sourced from **Sanity** (a headless CMS). Define a clean content shape — e.g.
  `{ slug, name, summary, body (portable text), category: "plugin" | "skill", icon,
  installSnippet, downloadUrl, sourceUrl, author, updatedAt }` — and render the grid from a
  single JS array (`PLUGINS = [...]`) that mirrors that shape, so swapping the array for a
  Sanity fetch later is a one-function change. Briefly recommend how I'd wire Sanity (a
  Sanity Studio with that schema, GROQ query, served as static JSON at build, or fetched
  client-side) **without** adding a backend I have to run. Keep it KISS and static-first.

## Quality bar
- One orchestrated, **restrained** page-load reveal (staggered) + tasteful hover
  micro-interactions. Motion should feel intentional, never decorative-for-its-own-sake.
- System/Google fonts with `display=swap` + preconnect; no heavy assets; inline SVG favicon.
- Clean, commented CSS with custom properties for the palette + type scale so I can retune.
- Make it genuinely beautiful and distinctive. The test: it should look like it cost money
  and was made by someone with taste — calm, premium, and the graph makes people go "oh."

**Return:** the full `index.html` and `styles.css`, plus a short note covering (a) the
palette/font choices you committed to and why, and (b) your recommended Sanity wiring for
the plugins directory.
