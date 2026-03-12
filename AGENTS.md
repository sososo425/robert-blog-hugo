# AGENTS.md

## Cursor Cloud specific instructions

### Project Overview

This is a Hugo static blog (`robert-blog-hugo`) using the PaperMod theme. No databases or external services are required for local development. See `README.md` for full documentation.

### Key Commands

| Action | Command |
|--------|---------|
| Dev server | `hugo server -D` (serves at `http://localhost:1313`) |
| Build | `hugo --gc --minify` |
| New post | `hugo new content <section>/<slug>.md` |

### Non-obvious Notes

- Hugo v0.142.0 extended edition is required (installed via `.deb` from GitHub Releases for linux-amd64).
- The PaperMod theme is committed directly into `themes/PaperMod/` (not as a git submodule despite what `README.md` says), so no `git submodule init/update` is needed.
- The `-D` flag in `hugo server -D` is important: it includes draft posts. Without it, drafts won't appear.
- The Kimi AI chat assistant (`api/chat.js`) is a Vercel Edge Function and does **not** run locally. It requires `KIMI_API_KEY` only in Vercel production/preview environments.
- There is no linter or test suite configured for this project. Validation is done by running `hugo` (build) and checking for errors.
- The `public/` directory is the build output and is gitignored.
