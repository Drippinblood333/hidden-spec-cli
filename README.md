# hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Drippinblood333/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Drippinblood333/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies AI-written edits — unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls — atomically (all files or none), with three-tier fuzzy line matching so drifted whitespace and wrong line numbers still apply. See SPEC.md for the full specification.

## Run it

```sh
node main.ts [options] [PATCH]
```

`node main.ts --format=unified patch.diff`, `node main.ts --check patch.txt` to dry-run, `node main.ts --strict` for exact-only matching. With no PATCH argument (or `-`) the patch is read from standard input. `check.ts` runs the public practice set: `node check.ts practice.json` (practice file not shipped in this repo).

---

<sub>Entered on [make.fun](https://make.fun/?ref=z7x74cra&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
