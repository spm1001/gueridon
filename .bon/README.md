# This is a bon board

This directory is a work tracker ("bon") used by human–AI partnerships.
It is the durable work memory for this repository: **outcomes** (desired
results) and **actions** (concrete steps), each carrying a brief —
why / what / done, plus optional how.

Everything an agent needs to work with it safely is below.
Tool and docs: https://github.com/spm1001/bon

## Reading (safe from any surface)

- `items.jsonl` — one self-describing JSON object per line. Key fields:
  `id`, `type` (outcome|action), `title`, `brief{why,how,what,done}`,
  `status` (open|done), `parent`, `waiting_for` (list of blocker ids).
- "Ready" = status open with empty/absent `waiting_for`.
- If `.bon/backend` contains `dolt`, items live in a shared database this
  clone can't reach — orient from prose instead (below); an items.jsonl
  here is a stale pre-migration ghost, not the board.
- Best orientation: read `understanding.md` and the newest handoff in
  `handoffs/` — each lives either in this directory or visibly at the
  repo/room root.

## Writing (through the tool, never by hand)

- With the CLI (`uv tool install git+https://github.com/spm1001/bon`):
  `bon list`, `bon show ID`, pipe JSON to `bon new`, `bon done ID --note`.
- Without the CLI: leave `items.jsonl` untouched. Append a `### Candidates`
  section to your session's handoff instead, proposing changes as
  provenance-tagged NEW/DONE/EDIT entries — the next tool-bearing session
  applies ("mints") them. Format:
  https://github.com/spm1001/bon/blob/main/docs/HANDOFF-CONTRACT.md
- Hand-edits break invariants the tool maintains: ID uniqueness, dedup,
  the blocker-release cascade, and merge semantics.
