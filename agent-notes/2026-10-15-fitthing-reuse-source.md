# FitThing as the reuse source for Lifeboard

2026-10-15, agent (Claude). Project setup note.

The user named `../FitThing` (`/home/willis/Desktop/Projects/FitThing`) as the project
with work already done that Lifeboard will build on. Prefer reusing or adapting its code
over rewriting (see the coding standards in `AGENTS.md`).

## What FitThing contains (as of its commit 158925f, 2026-10-07)

Python 3.11+ CLI package `fitthing` (published to GitHub as HealthLoader), `src/` layout,
setuptools, pytest + `responses`, ~2.8k lines across:

- `auth.py`, `client.py`, `export.py`, `datatypes.py`, `windows.py` — Google Health API
  OAuth sign-in, paced/incremental export of 30+ data types to raw JSON.
- `cronometer/` — automated Cronometer login (GWT-RPC) and daily nutrition CSV export/parse.
- `aggregate.py` — day-level `daily.csv`: merges sources, dedupes overlapping windows,
  gap-fills, target deltas, configurable columns.
- `sync.py` — runs both pulls with per-source failure isolation, then rebuilds the CSV.
- `dashboard.py` + `dashboard_template.html` — self-contained offline HTML charts
  (inline SVG, no CDN).
- `config.py` — TOML config (`config.example.toml` committed, `config.toml` gitignored).

Its own `agent-notes/` (14 notes) documents decisions and gotchas, e.g. Google rate
limits, a suspected 7-day refresh-token expiry while the OAuth app is in Testing,
Cronometer charset mojibake. Read those before reusing the corresponding code.

## Carried over at setup
- `agent-notes/README.md` conventions (copied verbatim).
- `.gitignore` base (generic sections; FitThing-specific health-data rules not copied
  yet, since Lifeboard's scope isn't defined).

## Open
- Lifeboard's purpose and scope have not been stated yet, so no code has been copied.
  Decide per module whether to copy, vendor, or depend on `fitthing` as a package.
