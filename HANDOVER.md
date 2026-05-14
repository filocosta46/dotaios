# DotAIOS Project State & Handover

> **Date:** 2026-05-12
> **Latest Release:** `v1.9.0` (Live on npm and GitHub)

This document is meant to be read by the next AI Agent that resumes work on the DotAIOS project. It contains the exact state of the repository, recent architectural decisions, and the immediate next steps.

---

## 1. Current State of the Codebase

- **Core CLI (`packages/cli/`)**: The CLI is stable at `v1.9.0`. It now supports installing plugins from local folders AND directly from external URLs (`git clone ...`). It also supports installing "raw skills" (folders with just a `SKILL.md` and no manifest).
- **Documentation (`README.md`)**: The README has been completely rewritten to be non-technical and ICP-friendly. All dashes and hyphens have been removed from the prose to ensure it reads cleanly as plain English text. Markdown tables have been replaced with bulleted lists.
- **Website (`website/`)**: A modern, static React-based landing page has been integrated directly into the monorepo under the `website/` directory.

## 2. Vercel Deployment Architecture

The DotAIOS landing page is successfully deployed to Vercel. 
**Crucial Context for Agents:**
- We **do not** use a `vercel.json` file in the repo root.
- We **do not** use a fake `build` script in `package.json`.
- The Vercel project is configured entirely via the Vercel Dashboard:
  - **Framework Preset**: `Other`
  - **Root Directory**: `website`
- **Workflow**: Any changes made to the `website/` directory and pushed to the `main` branch will automatically trigger a clean, static deployment on Vercel without attempting to install the CLI's npm dependencies. 
- To test the website locally, run: `npx serve website` from the repo root.

## 3. What Was Just Completed

1. **Vercel Troubleshooting:** Resolved a 404 NOT_FOUND error by correcting the Vercel Dashboard settings to point the Root Directory to `website/` instead of overriding it via `vercel.json`.
2. **README Polish:** Stripped all technical artifacts (dashes, complex tables) from the public-facing documentation.
3. **v1.9.0 Release:** Bumped the version, updated the `CHANGELOG.md`, tagged the release on GitHub, and published the package to the npm registry.

## 4. Next Steps / Future Roadmap

*(Add your immediate thoughts or tasks here before your next session)*

- [ ] Delete the experimental `filocosta46/dotaios-web` GitHub repository (it is redundant since the website is now hosted in the main CLI repo).
- [ ] Monitor the Vercel deployment for any caching or CDN issues.
- [ ] Continue building out the plugin ecosystem and marketplace (which can now be installed via raw URLs thanks to the v1.9.0 updates).
