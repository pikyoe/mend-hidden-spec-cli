# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/pikyoe/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/pikyoe/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

A single command that takes an AI-written patch and applies it to a tree of
text files. It understands four patch shapes: unified diffs whose line
numbers cannot be trusted, SEARCH/REPLACE blocks, V4A patches, and JSON tool
calls. When the model drifted the whitespace of the lines it names, mend
still finds them, and it writes every change or none at all. The full
contract lives in SPEC.md.

Made for make.fun's
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
bounty.

## Use

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH names the patch file; leave it out, or pass `-`, to read standard
input. `--format` picks one shape (`unified`, `search-replace`, `v4a`,
`json`); the default `auto` works it out from the text. `--check` prints
what would change and writes nothing. `--strict` turns off fuzzy matching
and requires lines to match exactly.

## Layout

- `main.ts` — the whole tool. Node 22, standard library only.
- `runner.ts` — the kit's runner, untouched. During a trial it pulls the
  checks from the environment and runs `main.ts` against each one.
- `check.ts` — runs the kit's 100 practice checks against `main.ts` here:

```sh
node check.ts ../program/generator/practice.json
```

- `SPEC.md` — the specification the tool implements.
- `LICENSE` — MIT.
