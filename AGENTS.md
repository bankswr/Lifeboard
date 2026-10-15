# Lifeboard — instructions for AI agents

These instructions apply to any LLM agent (Claude, Codex, Copilot, Cursor, etc.)
working in this repository.

## Scope
`docs/PLAN.md` defines the project's scope, architecture, and phases. Check work against it;
do not build features outside it without the user's agreement, and record agreed changes there.

## Agent notes
`agent-notes/` is a shared reference folder for agents. Before starting work, read
`agent-notes/INDEX.md` and any relevant notes. When you make a non-obvious decision,
finish an investigation, or leave work in progress, record it there following the
conventions in `agent-notes/README.md`, and update the index.

## Coding standards
- **Reuse before writing.** Prefer existing code over new custom code, as far as is
  reasonable, in this order: code already in this repo, code from the related projects
  `../FitApp` (stack/skeleton) and `../FitThing` (health logic; see
  `agent-notes/2026-10-15-fitthing-reuse-source.md`), the standard
  library, then a well-maintained third-party package. Write custom code only when none
  of these fit, and say why in the commit or an agent note.
- **Readability first.** Favor clear, plain code over clever or compact code: descriptive
  names, small single-purpose functions, straightforward control flow, and comments that
  explain *why* rather than *what*. Choose the readable version when it costs little in
  performance.
