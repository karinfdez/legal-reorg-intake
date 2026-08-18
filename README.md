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

On **ABSTAINED**, the tool stops and writes a question to `out/pending/` so a person can fill in the blank. See **If the tool asks a question** below.

The argument, Slice B, and known gaps are in [docs/design.md](docs/design.md). Working log: [docs/decisions.md](docs/decisions.md).

## Setup

Node 20+. Classify and extract call Anthropic (`claude-sonnet-4-6`). Unauthorized fixtures do not.

```bash
cp .env.example .env   # set ANTHROPIC_API_KEY
npm install
```

## Run

```bash
node src/cli.js --all                                    # every case in fixtures/envelopes/
node src/cli.js fixtures/envelopes/01-team-move-clean.json
node scripts/test-redact.js
```

**All cases live in [`fixtures/envelopes/`](fixtures/envelopes/).** Each JSON file is one inbound message plus an `expected_outcome`. `--all` runs them in filename order and checks that field. To try the next one yourself:

```bash
node src/cli.js fixtures/envelopes/<file>.json
```

| File | What it shows | Expected |
| --- | --- | --- |
| [`01-team-move-clean.json`](fixtures/envelopes/01-team-move-clean.json) | Happy path: authorized team move | EMITTED |
| [`02-unauthorized-sender.json`](fixtures/envelopes/02-unauthorized-sender.json) | Not on the allowlist; no model call | REJECTED |
| [`03-ambiguous.json`](fixtures/envelopes/03-ambiguous.json) | Hedged / details to follow | ABSTAINED |
| [`04-injection-embedded.json`](fixtures/envelopes/04-injection-embedded.json) | Real reorg + “skip approval” | EMITTED |
| [`05-injection-only.json`](fixtures/envelopes/05-injection-only.json) | Jailbreak, no reorg | ABSTAINED |
| [`06-compensation-included.json`](fixtures/envelopes/06-compensation-included.json) | Salary mentioned, no comp change | EMITTED |
| [`07-comp-change.json`](fixtures/envelopes/07-comp-change.json) | Salary increases → wrong workflow | ROUTED_OUT |
| [`08-missing-date.json`](fixtures/envelopes/08-missing-date.json) | Complete move except “next quarter” | ABSTAINED |
| [`09-ambiguous-manager.json`](fixtures/envelopes/09-ambiguous-manager.json) | Two Alex Riveras | ABSTAINED |
| [`10-retroactive-date.json`](fixtures/envelopes/10-retroactive-date.json) | Past date: flag, do not block | EMITTED |
| [`11-model-timeout.json`](fixtures/envelopes/11-model-timeout.json) | Forced timeout; no half ChangeSet | ABSTAINED |
| [`12-inactive-cost-center.json`](fixtures/envelopes/12-inactive-cost-center.json) | Destination **CC-4300** is in the list but `active: false` (validate, not Slice B) | ABSTAINED |

Allowlist used by trust: [`fixtures/reference/authorized_submitters.json`](fixtures/reference/authorized_submitters.json) (Priya Nair HRBP, Sam Okonkwo legal_ops).

`--all` compares each file’s outcome to `expected_outcome`. A fixture that is *supposed* to be rejected matching is success.

Exit codes: `0` for EMITTED / ABSTAINED / ROUTED_OUT, `1` for REJECTED or unknown `change_id`.

## If the tool asks a question (`pending` / `answer`)

You do not need Slack, a UI, or Temporal to try this. Three commands, three jobs:

| You type | In plain English |
| --- | --- |
| `node src/cli.js fixtures/envelopes/08-missing-date.json` | “Process this email.” |
| `node src/cli.js pending` | “What questions am I supposed to answer?” |
| `node src/cli.js answer chg_60b3eb89 --effective-date 2026-10-01` | “The date is October 1, 2026 — finish that one.” |

What actually happened:

1. Priya (HR) sent an email. The date was “next quarter,” not a calendar day.
2. The tool understood the team move. It **refused to invent a date**. It stopped. That is **ABSTAINED**.
3. It did **not** email Priya. It saved a sticky note as a file: `out/pending/chg_60b3eb89.json`.
4. `pending` just **prints those sticky notes**. The table/list is terminal output, not a web page.
5. In real life you would ping Priya in Slack, get “October 1,” then type `answer`. You are filling in one blank on a form the tool already started. It does not re-read the email or call the model again.
6. After `answer` succeeds, the sticky note is moved to `out/pending/resolved/` and the finished form is `out/changesets/chg_60b3eb89.json`.

`--effective-date` is the missing field `effective_date`. Other blanks work the same way: `--manager-to-name "Maya Chen"`.

## Worked example: missing date → human answers

After `--all` or `01`, **08** is the interesting next run: a complete team move except the date is “next quarter.” The pipeline must not invent a calendar date. `change_id` is derived from `message_id` (`msg_008` → `chg_60b3eb89`). The other files in `fixtures/envelopes/` run the same way (`node src/cli.js fixtures/envelopes/02-unauthorized-sender.json`, and so on).

```bash
node src/cli.js fixtures/envelopes/08-missing-date.json
```

```
[1] trust      PASS      sender=priya.nair@example.com role=hr_business_partner
[2] redact     PASS      no PII detected
[3] classify   PASS      type=team_move confidence=clear
[4] extract    PASS      missing: effective_date
[5] validate   ABSTAIN   missing: effective_date
--> ABSTAINED chg_60b3eb89 "What is the effective date for the Platform Analytics team move?"

The run stopped. The question is saved on disk (not Slack).
  See open questions:  node src/cli.js pending
  Answer this one:     node src/cli.js answer chg_60b3eb89 --effective-date 2026-10-01
```

Nothing is written under `out/changesets/`. The question is a file: `out/pending/chg_60b3eb89.json`.

```bash
node src/cli.js pending
```

```
Open questions — the tool stopped and is waiting for a person.
Saved as files in out/pending/ (not Slack). Copy the command under a question to answer it.

1. chg_60b3eb89  (team_move, waiting 0d)
   The tool asked: What is the effective date for the Platform Analytics team move?
   Missing: effective_date
   Type this (replace the placeholder with the real value):

     node src/cli.js answer chg_60b3eb89 --effective-date 2026-10-01
```

The ops owner gets the date from the submitter and patches the field. Classify and extract are **not** re-run.

```bash
node src/cli.js answer chg_60b3eb89 --effective-date 2026-10-01
```

```
[5] validate   PASS      resolved
[6] emit       PASS      wrote chg_60b3eb89
--> EMITTED chg_60b3eb89 (resolved from pending)
```

```bash
node src/cli.js pending
```

```
No open questions.
When a message is incomplete, the tool saves a question as a file in out/pending/.
This list is that folder — not Slack, not email.
```

The ChangeSet is now in `out/changesets/chg_60b3eb89.json` (no email body). Re-running the same inbound message returns **EMITTED** with `(already emitted)` and does not rewrite the file.

## On disk (`out/`, gitignored)

| Path | What |
| --- | --- |
| `out/audit.jsonl` | Step trail. Not a notification. |
| `out/pending/<change_id>.json` | Parked clarification. No `envelope.text`. |
| `out/changesets/<change_id>.json` | Emitted ChangeSet. Idempotent: same `message_id` does not write a second file. |

`change_id` is `chg_` + first 8 hex chars of `sha256(message_id)`.
