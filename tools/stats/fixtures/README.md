# Fixtures

Real captures from the GitHub API and from real job logs. The tests run entirely against
them, so the suite needs no token, no network and no rate limit, and cannot go red because
a fork was deleted or a log passed its 90 day retention.

They are real rather than synthetic on purpose. Every one of them encodes a behaviour that
was discovered by reading actual output and that a hand-written fixture would have been
written to *not* have:

| File | What it pins down |
|---|---|
| `jobs-34473576823.json` | The whole reason this tool is not a one-liner: 3 attempts, **138 job rows for 51 real jobs** — 50 campaign executions and the prep job. The carried-over rows have new ids and relabelled attempt numbers but original timestamps. Every row is kept, because the count is the assertion |
| `jobs-24509737743.json` | The older job-name generation, `test (<campaign>, <branch>)`, which is where the version comes from once logs have expired |
| `jobs-32371081746.json` | The prebuilt-shop naming, `<caller> / <inner>`, including `Sanity campaign / Test` whose inner name carries no campaign |
| `jobs-21282045781.json` | The security naming. `pr_security_test_one.yml` gives its matrix job the display name `Security PR test`, so every row arrives as `Security PR test (audit, 9.0.x)`. Requiring a name to start with `test (` dropped all 44, which left the run with no executions and therefore filed it as aborted: a run that worked, counted as a run that never started |
| `log-current-failure.txt` | The inputs and resolved-version blocks, a mocha failure, a 10 KB assertion diff that mocha truncates at 8 KB, **and the 144 real lines that follow the report** — artifact upload, git cleanup, `##[endgroup]` markers. The failure scan runs from the report to the end of the log, so that tail is in range and has to stay in the fixture |
| `log-current-pass.txt` | A green campaign: a summary and no failure |
| `log-legacy.txt` | An older log printing `branch_key (matrix key): develop` on a run whose pull request targeted 9.2.x. Trusting that field would file those runs under the wrong version |

They are trimmed to what the parsers read. The logs keep the inputs block and the mocha
report with a marker where the docker output was cut; successful jobs keep no `steps`, since
they can only ever yield `failure_kind: none`, and `jobs-21282045781.json` keeps only the
fields the parsers read because 44 whole rows are mostly fields nothing looks at. Nothing
else is edited: the rows and lines are exactly what the API returned.

Nothing synthetic lives here. The one case that needs invented input — teardown output shaped
like a mocha failure block, which no real log in this repository happens to print — is built
inline in `parse-log.test.js`, where it is visible as a construction rather than passing for a
capture.

Scanned for credentials before committing. What is left is GitHub's own `***` masking and
the API client secret that is already hard-coded in three workflow files in this repository.
