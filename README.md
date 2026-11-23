# mend

`mend` is a command-line tool that applies the edits AI models write, in four
formats, to a tree of text files — to one written specification (`SPEC.md`).

    node main.ts [options] [PATCH]

- **Unified diffs** — `diff --git`, `---`/`+++` sections and `@@` hunks, even with
  wrong line numbers.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`.
- **V4A patches** — `*** Begin Patch` / `*** Add File:` / `*** Update File:` /
  `*** Delete File:` / `*** End Patch`.
- **JSON edits** — one JSON array of edit objects, or JSON Lines, with the
  commands `create`, `str_replace` and `insert`.

Old lines are found at the first of three matching tiers where they occur:
exact (tier 0), trailing whitespace ignored (tier 1), leading and trailing
whitespace ignored (tier 2, with re-indentation). `--strict` matches exactly
(tier 0 only). Every edit is applied to the tree in patch order; a failed edit
changes nothing and every failure is reported; when any edit fails no file is
written, and when none fails every change is written — or, with `--check`,
none is.

Node 22 and its standard library alone. No install step, no dependencies.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of the
  tree). When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Output, one line per changed path in byte order, then `ok: <n> files`:

- `A <path>` a file that did not exist and now does;
- `D <path>` a file that existed and now does not;
- `M <path>` a file that existed and still does, with other bytes;
- `R <old> -> <new>` a file moved by a move edit.

On failure, one `error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits` (exit 1). Parse, format, usage and unreadable-patch
errors print one `error: ...` line and exit 2.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the trial runner (kept as the kit has it; it runs the checks
  when `MAKEFUN_ENV_URL` is set).
- `SPEC.md` — the whole specification.
- `LICENSE` — MIT.

## Practice score

100 of 100 practice checks pass (practice score 1000) with Node 22, run with
the kit's `check.ts` against `program/generator/practice.json`.

Built for the make.fun bounty "Build mend, one patch tool for every AI edit
format" (hidden-spec-cli-01-run-20261122).

Built with an AI agent, with the referral link: https://make.fun/r/17z8e469
