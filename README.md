# Reorg change pipeline

FDE take-home (Agentic-Driven Reorgs). **Slice A is implemented:** one freeform Slack/email becomes a validated ChangeSet, or the pipeline asks a human. **It never touches a target system.** Slice B (dependency graph / orchestrator) is designed, not built — see [docs/design.md](docs/design.md).

## How it works

Gates run in order and stop on failure:

```
trust → redact → classify → extract → validate → emit
```

The model only returns **values** (forced-tool classify, then extract). Code decides **actions**. Compensation is never written here.

| Outcome | Meaning |
| --- | --- |
| **REJECTED** | Sender not allowed. No model call. |
| **ABSTAINED** | Allowed, but incomplete or unclear. Specific question. Pending record written. |
| **ROUTED_OUT** | Real change, wrong workflow (comp review). |
| **EMITTED** | Structural ChangeSet written under `out/changesets/`. |

Trust never reads `envelope.text`. Redact token maps never leave the process. Audit lines are `{ ts, message_id, step, status, reason? }` — not the email body, not salary, not a resume token.

On **ABSTAINED**, the run ends and a pending **record** is stored (`out/pending/`). That is state, not a parked Temporal execution. Resume re-enters at validate + emit; classify/extract are not re-run.

The argument, Slice B, and known gaps are in [docs/design.md](docs/design.md). Working log: [docs/decisions.md](docs/decisions.md).

## Setup

Node 20+. Classify and extract call Anthropic (`claude-sonnet-4-6`). Unauthorized fixtures do not.

```bash
cp .env.example .env   # set ANTHROPIC_API_KEY
npm install
```

## Run

```bash
node src/cli.js --all                                    # regression suite
node src/cli.js fixtures/envelopes/01-team-move-clean.json
node scripts/test-redact.js
```

`--all` compares each fixture’s outcome to its `expected_outcome`. A fixture that is *supposed* to be rejected matching is success.

### Missing date → human answers

```bash
node src/cli.js fixtures/envelopes/08-missing-date.json
node src/cli.js pending
node src/cli.js answer <change_id> --effective-date 2026-10-01
node src/cli.js pending
```

`pending` lists open clarifications. `answer` merges fields (kebab-case flags → snake_case) and re-runs only validate and emit.

Exit codes: `0` for EMITTED / ABSTAINED / ROUTED_OUT, `1` for REJECTED or unknown `change_id`.

## Fixtures

| File | Expected |
| --- | --- |
| `01-team-move-clean` | EMITTED |
| `02-unauthorized-sender` | REJECTED (0 model calls) |
| `03-ambiguous` | ABSTAINED at classify |
| `04-injection-embedded` | EMITTED (jailbreak ignored) |
| `05-injection-only` | ABSTAINED |
| `06-compensation-included` | EMITTED (salary mentioned, no comp change) |
| `07-comp-change` | ROUTED_OUT |
| `08-missing-date` | ABSTAINED at validate (`effective next quarter`) |
| `09-ambiguous-manager` | ABSTAINED (which Alex Rivera?) |
| `10-retroactive-date` | EMITTED + `retroactive_effective_date` flagged, not blocked |
| `11-model-timeout` | ABSTAINED (forced timeout; no half ChangeSet) |

Allowlist: `fixtures/reference/authorized_submitters.json` (Priya Nair HRBP, Sam Okonkwo legal_ops).

## On disk (`out/`, gitignored)

| Path | What |
| --- | --- |
| `out/audit.jsonl` | Step trail. Not a notification. |
| `out/pending/<change_id>.json` | Parked clarification. No `envelope.text`. |
| `out/changesets/<change_id>.json` | Emitted ChangeSet. Idempotent: same `message_id` does not write a second file. |

`change_id` is `chg_` + first 8 hex chars of `sha256(message_id)`.
