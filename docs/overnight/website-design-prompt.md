# Website design prompt — hand to Claude (design / artifacts)

Paste everything below the line into Claude. If you can, also attach a screenshot of
https://www.hyperspell.com as the visual reference. Claude will return a complete,
self-contained landing page you can drop into `website/` (replace `index.html` and
`styles.css`).

---

You are a senior product designer + front-end engineer. Design and build a **complete, production-grade marketing landing page** for a product called **DotAIOS**. Return a single self-contained `index.html` plus one `styles.css` (and at most ~1 KB of vanilla JS inline). **No framework, no build step, no React, no Tailwind** — just clean semantic HTML and modern CSS, so it deploys as static files and loads instantly.

## What DotAIOS is
DotAIOS is **one plain-text folder on your computer** — `~/aios/` — that holds your context, your memory, and the skills you want your AI to run. Every AI coding agent on your machine (Claude Code, Cursor, Codex, Gemini CLI, OpenCode, and anything that reads an `AGENTS.md` file) reads from that same folder. You tell your AI who you are, what you're working on, and how you like to work **once**, and every tool knows. It's local-first, open source (MIT), free, and has no server and no account.

## Audience (do not drift)
**Non-technical people.** The onboarding is agent-led: you paste one sentence into an AI agent and it does the entire install for you — you never open a terminal. The tone must be warm, plain, and confident. Avoid jargon. This is NOT an enterprise "book a demo" product.

## Messaging truths to keep (never invent cloud/SaaS claims)
- Local-first. Plain Markdown/JSON files you own and can read in any editor.
- No account, no server we run, no cloud database.
- Optional sync is to the user's **own private GitHub repo** (opt-in).
- Open source, MIT, free.
- The hero idea: `.gitconfig` makes Git know your name; `~/aios/` makes every AI know your life.
- Primary call to action is **copy a one-line prompt**, not "book a demo".

The one-line install prompt (must appear, with a copy button):
`Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.`
Secondary, for terminal users: `npx dotaios setup`.

## Aesthetic direction
Modern **Silicon-Valley dev-tool** style, like hyperspell.com: **dark, near-black background**, high contrast, generous vertical rhythm, a **vibrant gradient-mesh “aurora” glow** behind the hero (warm coral + magenta + violet + a touch of blue/amber), and a single **warm coral/orange accent** (~`#ff7a4d`) for buttons, links, and micro-labels. Headlines in a refined **editorial serif** (e.g. Fraunces) — large, tight, with select words in italic accent color. Body in a clean grotesk (e.g. Hanken Grotesk). Code/monospace in IBM Plex Mono. Dark bordered cards (`~#141417` on `~#0a0a0b`) with subtle hover lift and brightening borders. Small uppercase letter-spaced eyebrow labels in coral. One signature visual: a **rendered `~/aios/` folder tree** in a terminal-style card that visually "reads into" the agent names.

Avoid generic AI-slop: no purple-on-white gradients, no Inter/Roboto, no stock hero illustration. Make it feel intentional and premium.

## Page structure (use this content)
1. **Sticky top nav** — wordmark "DotAIOS" + small coral logo square; links: Features, How it works, FAQ, GitHub; a pill "Get started" CTA.
2. **Hero** (gradient-mesh aurora) — eyebrow "Open source · local-first · no account"; headline "The memory & context layer your AI agents *already read.*"; a one-paragraph lede explaining the one-folder idea; two buttons (coral "Get started free" → #install, ghost "View on GitHub"); the folder-tree terminal card showing `context/identity.md`, `work.md`, `priorities.md`, `memory/`, `vault/`, `skills/`, `AGENTS.md` with short annotations, and a "reads into → Claude Code · Cursor · Gemini · Codex" row.
3. **Agent cloud** — "Works with the agents you already use": Claude Code, Cursor, Codex, Gemini CLI, OpenCode, Antigravity, "+ anything that reads AGENTS.md".
4. **Features** (3 cards, each with a tiny monospace diagram): "One folder, every agent" (shared context); "Continuity between sessions" (a compact working-memory digest injected at session start); "Turn anything into memory" (ingest a URL/PDF into your vault).
5. **Statement band** (big, centered): "Your AI relearns who you are ~~every single session.~~" then a sub-line: "DotAIOS gives it one folder to read instead — local, plain text, and yours."
6. **How it works** (3 steps, no command line): 1) Tell an AI to set it up (paste one line); 2) Every tool gets connected automatically; 3) Ask in plain English ("/plan-today", "/ingest", "/closeday").
7. **Trust** (4 items): Local by default; No account, no cloud; Sync is your own GitHub; Open source (MIT).
8. **Install band** (aurora glow) — "Open your AI agent and paste this line." with the one-line prompt in a copy-to-clipboard field, plus a `details` disclosure with the `npx dotaios setup` alternative.
9. **FAQ** (native `<details>` accordion): Do I need to be technical? Where does my data live? Which AI tools work? Can it follow me across devices? Is it free and open source? (Answer each truthfully per the messaging above.)
10. **Final CTA** + footer (Product / Docs / Project link columns; GitHub: https://github.com/filocosta46/dotaios).

## Technical + quality bar
- Single `index.html` + `styles.css`; inline `<script>` only for copy buttons and a scroll-reveal (IntersectionObserver). Content must be fully visible if JS doesn't run (gate any "hide for animation" CSS behind an `html.js` class set before paint).
- Responsive: elegant down to 360px (cards stack, nav collapses).
- Accessible: semantic landmarks, a skip link, visible focus states, sufficient contrast on the dark theme, and a `prefers-reduced-motion` path that disables the mesh animation and reveals.
- Fast: system/Google fonts with `display=swap` + preconnect; no heavy assets; inline SVG favicon.
- One orchestrated page-load reveal (staggered) + tasteful hover micro-interactions. Don't overdo motion.

Return the full `index.html` and `styles.css`. Make it genuinely beautiful and distinctive — something a YC-backed dev tool would ship.
