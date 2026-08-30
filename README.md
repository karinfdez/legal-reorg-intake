# Reorg change pipeline

FDE take-home (Agentic-Driven Reorgs). **Slice A** turns one freeform Slack/email into a validated ChangeSet, or asks a human. **Slice B** walks a declared graph of stub writes and human gates. Slice B is deterministic code — **no model call**. Stub adapters log the payload they would send; they never make HTTP. See [docs/design.md](docs/design.md).

## How it works

Gates run in order and stop on failure:

```
trust → redact → classify → extract → validate → emit
```

End-to-end picture: [Figure 1](docs/design.md#31-end-to-end-path).

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
npm test   # redact checks + Slice B graph walk + full fixture suite, in order
```

`out/` accumulates emitted ChangeSets and step state across runs, so once you have worked through the `answer` or `propagate` walkthroughs below, a redelivered message short-circuits to `already emitted` rather than re-running. That is correct behaviour, but it makes a *repeat* `--all` report the resolved fixtures as `EMITTED` instead of `ABSTAINED`. To start clean (e.g. between demos), wipe the regenerable state first — `out/` is gitignored, nothing else is touched:

```bash
npm run reset   # rm -rf out
```

Or step through it:

```bash
# Slice A — needs ANTHROPIC_API_KEY (unauthorized fixtures do not call the model)
node scripts/test-redact.js
node src/cli.js --all
node src/cli.js fixtures/envelopes/01-team-move-clean.json   # → chg_e81290fd

# Slice A — human fills a missing field (after 08 has abstained)
node src/cli.js pending
node src/cli.js answer chg_60b3eb89 --effective-date 2026-10-01

# Slice B — no model. test-slice-b.js does not need an emitted ChangeSet.
node scripts/test-slice-b.js
node src/cli.js propagate chg_e81290fd
node src/cli.js attest chg_e81290fd update_headcount_plan --by dana.wu
node src/cli.js approve chg_e81290fd update_allocation_rules --by dana.wu     # rejected (fpna)
node src/cli.js approve chg_e81290fd update_allocation_rules --by aisha.rahman
node src/cli.js status chg_e81290fd
```

`propagate` needs `out/changesets/chg_e81290fd.json` from fixture **01**. `test-slice-b.js` writes its own ChangeSet and checks the same sequence. Full walkthroughs are below.

**All cases live in [`fixtures/envelopes/`](fixtures/envelopes/).** Each JSON file is one inbound message plus an `expected_outcome`. `--all` runs them in filename order and checks that field. To try the next one yourself:

```bash
node src/cli.js fixtures/envelopes/<file>.json
```

| File | message_id | What it shows | Expected |
| --- | --- | --- | --- |
| [`01-team-move-clean.json`](fixtures/envelopes/01-team-move-clean.json) | `msg_001` | Happy path: authorized team move | EMITTED |
| [`02-unauthorized-sender.json`](fixtures/envelopes/02-unauthorized-sender.json) | `msg_002` | Not on the allowlist; no model call | REJECTED |
| [`03-ambiguous.json`](fixtures/envelopes/03-ambiguous.json) | `msg_003` | Hedged / details to follow | ABSTAINED |
| [`04-injection-embedded.json`](fixtures/envelopes/04-injection-embedded.json) | `msg_004` | Real reorg + “skip approval” | EMITTED |
| [`05-injection-only.json`](fixtures/envelopes/05-injection-only.json) | `msg_005` | Jailbreak, no reorg | ABSTAINED |
| [`06-compensation-included.json`](fixtures/envelopes/06-compensation-included.json) | `msg_006` | Salary mentioned, no comp change | EMITTED |
| [`07-comp-change.json`](fixtures/envelopes/07-comp-change.json) | `msg_007` | Salary increases → wrong workflow | ROUTED_OUT |
| [`08-missing-date.json`](fixtures/envelopes/08-missing-date.json) | `msg_008` | Complete move except “next quarter” | ABSTAINED |
| [`09-ambiguous-manager.json`](fixtures/envelopes/09-ambiguous-manager.json) | `msg_009` | Two Alex Riveras | ABSTAINED |
| [`10-retroactive-date.json`](fixtures/envelopes/10-retroactive-date.json) | `msg_010` | Past date: flag, do not block | EMITTED |
| [`11-model-timeout.json`](fixtures/envelopes/11-model-timeout.json) | `msg_011` | Forced timeout; no half ChangeSet | ABSTAINED |
| [`12-inactive-cost-center.json`](fixtures/envelopes/12-inactive-cost-center.json) | `msg_012` | Destination **CC-4300** is in the list but `active: false` (validate, not Slice B) | ABSTAINED |
| [`13-manager-change-clean.json`](fixtures/envelopes/13-manager-change-clean.json) | `msg_013` | Second change type: reporting-line change, no team/CC | EMITTED |
| [`14-cost-center-split-clean.json`](fixtures/envelopes/14-cost-center-split-clean.json) | `msg_014` | Third change type: split CC-4400 → CC-4500 + CC-4600 | EMITTED |

Fixtures **01–12** are all `team_move` (the fully worked type — happy path plus every abstention edge). **13** and **14** are the other two in-scope types, `manager_change` and `cost_center_split`. They emit through the **same pipeline with no new code** — only new fixtures, reference rows, and a graph per type — which is the point: the model returns values, code decides actions, and the graph is data. Each has its own Slice B graph ([`graph/manager_change.json`](graph/manager_change.json), [`graph/cost_center_split.json`](graph/cost_center_split.json)); `cost_center_split` carries a `finance_owner` approval gate, `manager_change` deliberately carries none (approval is per-step policy, not a hardcoded stage).

Allowlist used by trust: [`fixtures/reference/authorized_submitters.json`](fixtures/reference/authorized_submitters.json) (Priya Nair HRBP, Sam Okonkwo legal_ops). Slice B also reads roles from that file (Dana Wu `fpna` attests; Aisha Rahman `finance_owner` approves). Those two cannot submit Slice A (`can_submit: false`).

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

1. chg_60b3eb89  msg_008  (team_move, waiting 0d)
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
--> EMITTED chg_60b3eb89  msg_008 (resolved from pending)
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

## Propagate a ChangeSet (Slice B)

No model. Order comes from [`graph/team_move.json`](graph/team_move.json). After Slice A has written a ChangeSet (fixture **01** → `chg_e81290fd`):

```bash
node src/cli.js propagate chg_e81290fd
node src/cli.js propagate chg_e81290fd   # idempotent: no adapter re-runs
node src/cli.js attest chg_e81290fd update_headcount_plan --by dana.wu
node src/cli.js approve chg_e81290fd update_allocation_rules --by dana.wu
# rejected, wrong role (fpna ≠ finance_owner)
node src/cli.js approve chg_e81290fd update_allocation_rules --by aisha.rahman
node src/cli.js status chg_e81290fd
```

First `propagate` completes the two API steps (GL mapping, HR assignment), prints a work order for the planning tool, and leaves allocation **blocked**. Attest completes the manual step; allocation then waits for a `finance_owner`. Dana is rejected; Aisha completes it.

## On disk (`out/`, gitignored)

| Path | What |
| --- | --- |
| `out/audit.jsonl` | Step trail. Not a notification. Slice B status lines add `change_id`, `step_id`, `from_status`, `to_status`. Approvals are `event: "approval_recorded"`, not a fake status. |
| `out/pending/<change_id>.json` | Parked clarification. No `envelope.text`. |
| `out/changesets/<change_id>.json` | Emitted ChangeSet. Idempotent: same `message_id` does not write a second file. |
| `out/state/<change_id>.json` | Slice B per-step status. A completed step is never re-run. |

`change_id` is `chg_` + first 8 hex chars of `sha256(message_id)`. The filename is that id, not the fixture name (`01-team-move-clean.json`). Open the JSON and read `source.message_id` (changesets) or `correlation.message_id` (pending) to match it to an envelope.
