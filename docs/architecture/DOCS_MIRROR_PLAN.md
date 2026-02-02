# OpenClaw Docs → Local MD Mirror (Plan)

Date: 2026-02-01  
Owner: Platform/Docs  
Audience: Architect #2, Maintainers

## Goal
Provide an always-fresh, local, Markdown-formatted mirror of https://docs.openclaw.ai
for fast offline help inside the project. Updates should be automated (daily) and
should track upstream changes with diffs and versioned snapshots.

## Constraints
- Respect upstream license, robots.txt, and rate limits.
- Do not scrape gated/private content.
- Keep mirror size manageable (opt-in sections; configurable).
- Avoid breaking local references when upstream paths change.

## Architecture (High Level)

### 1) Fetch Layer
- Uses a crawler (e.g., `linkedom` + `undici`) to fetch HTML pages.
- Reads sitemap if available; otherwise uses site navigation + internal link discovery.
- Respects `robots.txt` and throttles requests (e.g., 1–2 rps).

### 2) Normalize Layer
- Converts HTML → Markdown (e.g., `turndown` + custom rules).
- Fixes relative links, removes global nav/footer, and preserves code blocks.
- Extracts frontmatter:
  - `title`
  - `source_url`
  - `last_crawled_at`
  - optional `section`

### 3) Storage Layer
- Writes into repo under `docs/external/openclaw/`.
- Path mirrors URL structure, e.g.:
  - `https://docs.openclaw.ai/tools/skills`
  - → `docs/external/openclaw/tools/skills.md`
- Keeps an index file (`docs/external/openclaw/INDEX.md`) with ToC + last update.

### 4) Diff + Update Layer
- Daily job compares hash of fetched HTML or generated Markdown.
- Stores diffs in `docs/external/openclaw/CHANGELOG.md`.
- Optional: keeps last 7 snapshots (compressed) for rollback.

### 5) Consumer Layer
- Add entry in main docs index pointing to the mirror.
- Provide a short “How to use offline docs” section in `docs/README.md`.

## Update Strategy (Daily)
- `scripts/docs-mirror-openclaw.sh`:
  - Crawl → normalize → write md
  - Update INDEX.md
  - Append CHANGELOG.md entries
- Cron job (daily at 03:30) using existing launchd/cron framework.

## CLI / Usage
```
./scripts/docs-mirror-openclaw.sh --scope tools,gateway --max-pages 200
```

## Risks + Mitigations
- **Robots/License**: check `robots.txt` + license before first run.
- **Breaking changes**: use stable selectors + snapshot testing.
- **Large pages**: max-size guard (skip > X MB).

## Time Estimate
- Prototype crawler + converter: 0.5–1 day
- Normalization + index: 0.5 day
- Diff + scheduler: 0.5 day
- Docs wiring + tests: 0.5 day
**Total: ~2–3 days**

## Acceptance Criteria
- Mirror created under `docs/external/openclaw/` with ToC index.
- Daily job updates and logs changes.
- At least 20 core pages mirrored (Start Here, Wizard, Gateway, Skills, Tools).
- No more than 1 request/sec average.

