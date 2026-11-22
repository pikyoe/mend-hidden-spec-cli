# mend-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/pikyoe/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/pikyoe/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in four formats —
unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A
patches and JSON tool calls — to a tree of text files, to the specification in
SPEC.md. It finds the lines an edit names even when the model drifted their
whitespace or indentation, and changes every file or none.

Built for make.fun's
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
bounty.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH is the patch file, or standard input when absent or `-`. `--format`
picks one format (`unified`, `search-replace`, `v4a`, `json`); `auto` (the
default) detects it. `--check` reports what would change without writing
anything. `--strict` matches lines exactly.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's runner, unchanged. In a trial it reads the checks
  from the environment and runs `main.ts` on each one.
- `check.ts`: runs the kit's 100 practice checks against `main.ts` locally:

```sh
node check.ts ../program/generator/practice.json
```

- `SPEC.md`: the specification this tool implements.
- `LICENSE`: MIT.
