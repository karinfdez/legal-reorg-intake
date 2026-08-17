# Decisions

Running log kept during the build. Raw material for the design doc — not the doc itself.

---

## Design

- **Two slices, not one.** Slice A = capture → validated ChangeSet ("what changed").
  Slice B = declarative dependency graph + orchestrator ("what must happen, in what
  order"). Slice A alone is a text parser; the company's problem is that the order lives
  in one person's memory, and that's Slice B.

- **Routing + prompt chaining, not an autonomous agent.** Orchestrator-workers and
  tool-loop agents exist for when the steps can't be enumerated in advance. Here the steps
  *can* be enumerated — extracting them from human memory is the deliverable. Using a model
  to re-derive a known checklist per run trades auditability for nothing.

- **The model produces values; code produces actions.** Every model call returns data that
  a `switch` or an `if` acts on. No model call in this system has a tool with a side effect.

- **Cheap deterministic gates run before expensive model calls.** Trust check is first.
  Two reasons: an unauthorized message costs nothing to reject, and unauthorized content
  should never enter the system's context or logs in the first place.

- **Envelope metadata is trusted for authorization; payload text is trusted for nothing.**
  `checkTrust` never reads `envelope.text`. A legitimate HR partner can forward an email
  containing anything.

- **Classify and extract are separate calls.** The three change types have schemas that
  don't merge cleanly — a union with all-optional fields makes `required` meaningless and
  moves validation into hand-written conditionals. Separate calls also let classification
  accuracy be measured in isolation. Cost/latency of the extra call is irrelevant at tens
  of reorgs per quarter.

- **Forced tool use, not "return JSON".** Prompting for JSON is a request; `tool_choice`
  is a constraint enforced at generation time. The enum means downstream code can't fall
  through to a category the model invented.

- **Temperature 0 for reproducibility, not accuracy.** Determinism is what makes the
  fixture suite a regression suite — otherwise a failing test could be sampling noise.
  Accuracy is guarded separately by the enum, the abstain path, and the validation gap.

- **Three outcomes, not two: EMITTED / ABSTAINED / REJECTED.** "You are not authorized"
  and "I understood most of this but the effective date is missing, here is my question"
  are different events and belong in different branches.

- **Abstain is a first-class output.** Never infer or default an effective date. When a
  required field is missing, return a specific question, not a generic failure.

- **Prompt injection is handled architecturally, not by detection.** The classify and
  extract calls have a closed schema and zero tools with side effects, so injected
  instructions have no reachable action surface — there is no field that means "approve".

- **`--all` reads `expected_outcome` from each fixture.** Makes the fixture set a
  regression suite. A fixture that is *supposed* to be rejected passing the check is a
  success, not a failure.

- **Policy lives as data, code enforces it.** Approvers are a field on the graph step, not
  a branch in the orchestrator. An FP&A owner can change an approver without touching code.

- **The graph's *contents* are not engineering knowledge.** They come from structured
  interviews with the FP&A and HR Ops owners who currently hold the sequence in memory.
  The engineering deliverable is the schema, the orchestrator, and the gating semantics.

- **Attestation is one state transition, exposed however.** `awaiting_attestation →
  completed`, recorded with actor and timestamp. CLI in the prototype; Slack interactive
  message in production, because that's where the approvers already work. Whatever
  collects the click must authenticate the actor — an attestation is an authorization
  event, not a notification acknowledgement.

- **Attestation is a claim, not proof.** It unblocks the pipeline; a reconciliation
  read-back verifies the change actually landed. Two separate mechanisms, both needed.

- **Write absolute values, never deltas.** `setHeadcount(org, 16)` is idempotent;
  `adjustHeadcount(org, +6)` silently corrupts on retry. Same business change, opposite
  safety properties.

- **Prefer loud failures over silent ones.** Where a transient inconsistency is
  unavoidable, choose the direction that's detectable — double-counted headcount shows up
  in any rollup; orphaned headcount looks perfectly plausible until close.

- **No UI.** Human touchpoints render as text work orders showing field-level values, the
  owner, and which downstream steps are blocked. A CLI trace exposes the gating logic more
  legibly to a reviewer than a form would.

---

## AI: shaped / overridden

- **Shaped:** used Claude throughout to work from the problem statement to the
  code-vs-model decision table (which decisions could be written down in advance → code;
  which require reading meaning → model). That table is what produced the architecture.

- **Overridden:** the generated pipeline collapsed validation failure into `REJECTED`.
  Split it into `ABSTAINED` with a specific question. "Not authorized" and "missing
  effective date" are different events, and collapsing them loses the most useful behavior
  in Slice A.

- **Overridden:** `checkTrust` authorized the sender and the pipeline then looked the same
  submitter up again for the role — two implementations of one lookup, which drift. Had
  `checkTrust` return what it found and deleted the duplicate.

- **Overridden:** email comparison was case-sensitive, so `Priya.Nair@…` would fail
  authorization. Normalized both sides.

- **Overridden:** `--all` exit code was "fail if everything was rejected", which treats an
  intentionally-rejected fixture as a failure. Replaced with per-fixture
  `expected_outcome` matching.

- **Considered and rejected (AI suggestion):** letting the model determine propagation
  order. Rejected — ordering is a correctness constraint with a physical basis (a cost
  centre must exist in the GL before the HR system can reference it), and a
  nondeterministic executor can't be gated or audited.

- **Considered and rejected:** using the model's self-reported confidence as the gate.
  Replaced with deterministic required-field checks — self-reported confidence isn't
  auditable and can't be regression-tested.

---

## Approach — Slice A: capture to validated ChangeSet

A reorg change arrives as freeform text and is normalized into an **envelope** before it
enters the pipeline:

```
{ message_id, source, sender, received_at, text }
```

The envelope has two trust levels, and the split is load-bearing. `sender`, `source`, and
`received_at` come from the platform (Slack, the mail server) and are trusted for
authorization. `text` is written by a person and is trusted for nothing — a legitimate HR
partner can forward a message containing anything.

Slice A runs six gates in a fixed order. Ordering principle: **cheap deterministic checks
run before expensive model calls.** Each gate can stop the pipeline, and the gap between
gates is where inspection, logging, and human hand-off live.

| # | Gate | Owner | On failure |
|---|------|-------|-----------|
| 1 | trust | code | `REJECTED` — no further steps, no model call |
| 2 | redact | code | `REJECTED` — malformed envelope |
| 3 | classify | model | `ABSTAINED` — type is `unclear` |
| 4 | extract | model | `ABSTAINED` — required field not present in the text |
| 5 | validate | code | `ABSTAINED` — with a specific question |
| 6 | emit | code | writes the ChangeSet |

**1. Trust — code.** Checks `sender` against the authorized-submitter list, `source`
against an allowed set, and that `received_at` parses. It never reads `envelope.text`. It
makes no model call: authorization is not a judgment call. Two reasons this runs first —
an unauthorized message costs nothing to reject, and unauthorized content should never
enter the system's context or its logs at all. On failure the pipeline returns immediately
with zero model calls, which is asserted in the fixture suite.

**2. Redact — code.** Compensation figures, salary references, and other sensitive
identifiers are replaced with tokens before any text reaches a model. Reorg-relevant
content (team names, managers, cost centers) is preserved, or extraction has nothing to
work with. Redaction is positioned here, before the first model call, so PII never enters
the model context or the prompt history.

**3. Classify — model.** One call, forced tool use, closed enum:
`team_move | cost_center_split | manager_change | unclear`. Temperature 0. This is a
routing decision — the change type determines which extraction schema applies, which step
graph Slice B uses, and which approvers are required, so it must resolve before extraction
runs. `unclear` is a valid answer; the model is instructed to return it rather than force a
hedged or incomplete message into a category.

**4. Extract — model.** A second call with the schema for the classified type. The three
types have field sets that do not merge cleanly; a single union schema with all-optional
fields would make `required` meaningless and push validation into hand-written
conditionals. Separate calls also let classification accuracy be measured in isolation.
At tens of reorgs per quarter, the extra call's cost and latency are irrelevant.

The extraction tool requires only `missing`, `notes`, and `comp_change`. Everything else
is optional so the model can omit unstated fields instead of being forced to invent them.
Marking every field `required` is what makes models hallucinate values; this schema is
what makes abstention possible.

**5. Validate — code.** Required fields present, manager names and cost centres resolve
against reference data (`name`/`id`, `code`/`id`/`active`), effective date parses.
`collectMissing` re-derives gaps from presence, not from the model's `missing[]` report:
if the model listed a field as missing but also emitted a value, code trusts the value;
if it forgot to report a gap, presence still catches it. That is deterministic verification
of a model self-report — the same principle as not gating on self-reported confidence.

Change IDs are `chg_` plus a short hash of `message_id`, so reprocessing the same message
is idempotent. Slice B's key is `${change_id}:${step_id}`; colliding `chg_001` across
reorgs would mark the wrong steps complete.

Effective dates in the past are **flagged** (`retroactive_effective_date`), not blocked.
Whether they are allowed depends on the close calendar and a Controllership rule this
slice does not have. In production that flag routes to a finance approval path.

`comp_change === true` is not a validation failure. After validate succeeds, the pipeline
**routes out** — compensation has a separate approval chain.

**6. Emit — code.** Writes a validated ChangeSet, or returns an abstention.

### Three outcomes, not two

- **`REJECTED`** — the submission is not authorized. Nothing further happens.
- **`ABSTAINED`** — the submitter is authorized and the message was mostly understood, but
  something required is missing or ambiguous. Returns a **specific question**
  ("What is the effective date for the Payments team move?"), not a generic failure.
- **`EMITTED`** — a validated ChangeSet, ready for Slice B.

Collapsing abstain into reject was the first thing corrected during the build. "You are not
authorized" and "I understood this but need the effective date" are different events with
different recipients and different next actions.

### Prompt injection

Input is untrusted by design. Injection is handled architecturally rather than by
detection, and no detector was built.

The classify and extract calls read text and return values. Neither defines a tool with a
side effect, and neither runs a tool loop — there is no `tool_result` and no follow-up
call, so nothing the model writes is executed. Forced tool use (`tool_choice`) bounds the
output to a fixed schema, so the only thing either call can produce is a value from an
enum. There is no field that means "approved" and no code path that acts on model output
directly. The orchestrator in Slice B, which does act, never sees the original text — only
the validated ChangeSet.

A detector was deliberately not built. Detection on natural language is unreliable in both
directions, and a fixture in the suite demonstrates why it would be harmful: a legitimate
reorg from an authorized HR partner with a fake "system note" appended emits correctly and
the injected instruction produces nothing. A detector that rejected that message would drop
real work because of text someone pasted into a thread.

The limit is worth stating: structure prevents malformed *actions*, not wrong *values*.
Text asserting a false effective date produces a well-formed ChangeSet with a wrong date.
That is what gate 5 and the human confirmation gate are for.

### Fixture suite

`node src/cli.js --all` runs every fixture and compares the outcome against an
`expected_outcome` field declared on the envelope. A fixture that is *supposed* to be
rejected passing the check is a success, not a failure. This is the regression suite for
the non-deterministic steps, and it exists because the pipeline has gaps between gates
rather than being one opaque call. Temperature 0 is what makes it meaningful — without
reproducibility, a failing case could be a real regression or sampling noise.

Current fixtures: clean team move (`EMITTED`), unauthorized sender (`REJECTED`, asserted
zero model calls), hedged "details to follow" message (`ABSTAINED`), legitimate reorg with
embedded injection (`EMITTED`, injection inert), injection-only message with no reorg
content (`ABSTAINED`).

---

## Open questions

- **Retroactive reorgs into a closed period.** Detected and flagged
  (`retroactive_effective_date`), not blocked and not silently accepted. Whether they are
  allowed depends on the close calendar and a Controllership rule. Production should route
  that flag to a finance approval path.

- **Concurrent changes to the same cost centre.** Two reorgs in flight touching CC-4200 —
  the JSONL state store is last-write-wins and has no locking. Fine at prototype volume,
  not at scale.

- **Entity resolution.** "Priya's team" → worker IDs is a real matching problem with a real
  failure mode. Prototype resolves against a fixture reference table; production needs a
  documented match strategy and a no-match path.

- **Who owns the graph in six months?** Named per-step owners are in the schema, but the
  ownership of the file itself — review, approval of changes, drift detection — is a
  process question, not a code question.

- **Which gate gets removed first.** The extraction-confirmation gate is the candidate once
  there's accuracy data. Approval gates on GL-touching steps stay, because those are
  controls rather than efficiency measures.

- **Detecting out-of-band steps.** If someone does a step manually outside the system, the
  graph can't prevent it — only detect it after the fact via reconciliation. Needs a
  read-back capability that doesn't exist yet.


- **What to say about 04 in the review**

"This one is the interesting case. Authorized sender, real reorg, plus an instruction block telling the processor to skip the approval gate. It emits correctly and the instruction does nothing — and notice I didn't build a detector. If I rejected this message I'd be dropping a legitimate reorg because of text someone pasted into a thread. The containment is that the call has no tool with a side effect, so noticing the injection was never necessary."