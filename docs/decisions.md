# Decisions

Working log from the build. Raw material for `docs/design.md` — not the design doc.

## Design

**Architecture**
- **Two slices, not one.** Slice A is capture → ChangeSet (“what changed”); Slice B is a declared graph + orchestrator (“what must happen, in what order”). Slice A alone is a parser; the company’s problem is that the order lives in one person’s memory.
- **Prompt chaining and routing, not an autonomous agent.** The steps can be enumerated — pulling them out of human memory is the deliverable. A model re-deriving a known checklist per run trades auditability for nothing.
- **The model produces values; code produces actions.** Every model call returns data a `switch`/`if` acts on. No model call has a tool with a side effect.
- **Cheap deterministic gates before model calls.** Trust is first so unauthorized mail costs nothing and never enters context or logs.
- **Four outcomes, not two.** `REJECTED` / `ABSTAINED` / `ROUTED_OUT` / `EMITTED` — “not allowed,” “missing a date,” and “belongs in comp review” are different events.
- **Six gates, fixed order: trust → redact → classify → extract → validate → emit.** Each gate can stop the run; the gaps are where logging and human hand-off live.
- **Envelope splits trust.** `sender` / `source` / `received_at` are platform-stamped and used for authorization; `text` is trusted for nothing.

**Trust and security**
- **`checkTrust` never reads `envelope.text`.** A legitimate HR partner can forward anything; authorization is who sent it, not what the body claims.
- **No injection detector.** Classify/extract have a closed schema and no side-effect tools, so there is no field that means “approve.” A detector would have dropped fixture 04 (real reorg + pasted jailbreak).
- **Redact is regex, not a model.** Salary, SSN, account, email, phone become process-local tokens (`[SALARY_1]`); the map is never audited, persisted, or sent to a model. Names, CC codes, dates, headcount, worker IDs must survive or extract has nothing to work with.
- **Audit is `{ ts, message_id, step, status, reason? }` only.** No email body, no salary, no resume token — it is not a notification.
- **Structure stops malformed actions, not wrong values.** A false date still yields a well-formed ChangeSet; that is what validate and human confirmation are for.

**Model calls**
- **Classify then extract, not one union schema.** The three types don’t merge; all-optional `required` is meaningless. Separate calls also let classify accuracy be measured alone; cost is irrelevant at tens of reorgs per quarter.
- **Forced `tool_choice`, not “please return JSON”.** Prompting is a request; `tool_choice` is a generation-time constraint so code cannot fall through to an invented type.
- **Temperature 0 is for reproducibility, not accuracy.** Accuracy is the enum, abstain, and required-field checks. Without determinism, `--all` cannot tell a regression from sampling noise.
- **Extract `required` is only `missing`, `notes`, `comp_change`.** Forcing every field required is what makes models invent values; optional fields are what makes abstention possible.
- **Extract copies names and CC codes as written, never guessed IDs.** Guessing `M-201` is a silent wrong person; `validate` resolves against `managers.json` / `cost_centers.json`.
- **`collectMissing` trusts presence, not the model’s `missing[]`.** If the model listed a field as missing but emitted a value, code keeps the value; if it forgot a gap, presence still catches it.
- **Classify `unclear` or a failed/timed-out model call is `ABSTAINED`, not a crash or a half ChangeSet.** Fixture 11 forces a timeout after trust/redact to prove that path.

**State and resumption**
- **`ABSTAINED` writes `out/pending/<change_id>.json` and exits.** Fields, question, correlation — no `envelope.text`, no token map, no resume token. `answer` re-enters at validate then emit; classify/extract are not re-run (wasted spend and non-deterministic).
- **Pending is state, not durable execution.** Temporal / Step Functions would replace the files, not the transitions. Designed as the seam; the JSON files are what is built.
- **`change_id` is `chg_` + first 8 hex of `sha256(message_id)`.** Same inbound message → same id. Slice B will key `${change_id}:${step_id}`; a hardcoded `chg_001` would attribute the wrong reorg’s steps.
- **Emit is idempotent.** If `out/changesets/<change_id>.json` exists, do not rewrite it. On `validation.ok === false`, write pending and write no changeset.
- **Redelivery is checked by `change_id` right after trust, before any model call — not only inside `emit`.** Found by testing: resolve an abstained change via `answer`, then redeliver the original (still-incomplete) message. Before this fix, the existing-changeset check only lived inside `emit()`, reached only when validation succeeds — so the redelivered original re-ran classify/extract/validate, abstained again on the same missing field, and recreated a stale `out/pending/<change_id>.json` for a change that was already emitted. Now `readExisting(changeId)` short-circuits to `EMITTED (already_emitted)` immediately after trust, so classify/extract/validate never run a second time.
- **`--all` matches per-fixture `expected_outcome`.** A fixture that is supposed to be rejected matching is success. The suite exists because the pipeline has gaps between gates, not one opaque call.
- **Past effective dates get `retroactive_effective_date` on the ChangeSet, not a block.** Whether they are allowed is a close-calendar / Controllership rule this slice does not have.

**Slice B / propagation**
- **Policy lives as data on the step.** Approvers are a field, not an orchestrator branch, so FP&A can change an owner without a deploy. `approve` checks `approval.role` against `authorized_submitters.json`.
- **Graph *contents* are not engineering knowledge.** They live in `graph/<change_type>.json` from FP&A / HR Ops interviews; engineering owns schema, orchestrator, and gating.
- **Approval is an event, not a status.** `approve` writes `event: "approval_recorded"` (actor + ts) and `approved_at`. The status change is `awaiting_approval → completed` when the write runs. `approved` is not in the status enum.
- **Attestation is `awaiting_attestation → completed` with actor and timestamp.** Prototype: `attest --by`. Production: authenticated Slack click — an authorization event, not a notification ack.
- **Attestation is a claim, not proof.** It unblocks; reconciliation read-back (not built) would check the value landed.
- **Write absolute values, never deltas.** Adapter payloads copy ChangeSet fields; they do not compute `+6`.
- **Atomicity inside a manual step is instructed, not enforced.** The planning tool has no API; `instructions` tell the human not to split the decrement/increment. No `atomic_with` field — we cannot observe what they type.
- **Prefer loud failure.** Double-counted headcount shows up in a rollup; orphaned headcount looks fine until close.
- **No model call in Slice B.** `topoSort` + `walk` are deterministic code. Stubs in `src/lib/adapters.js` log the payload they would send; real integrations replace that file only.
- **Idempotency is the `completed` guard.** `execution_key` records which `${change_id}:${step_id}` ran; it is not a second skip check.

**Scope**
- **This pipeline never writes compensation.** `comp_change` is a boolean, never an amount; `true` → `ROUTED_OUT` after validate. Tokenize-and-discard only works if salary is never a write here.
- **No UI.** CLI traces and text work orders are more reviewable in the time box than a form.
- **Connectors are not built.** Fixtures pretend Slack/email already stamped `source` and `sender`.
- **Real HTTP, retries, timeouts, escalation, parallel walks, and rollback are not built.** Stub adapters and a serial `walk` are enough to show gating; each is a one-line TODO on the orchestrator.

## AI: shaped / overridden

- **A code-vs-model table (what can be written down in advance → code; what needs meaning → model)** → kept as the architecture: trust/redact/validate/graph in code; classify/extract as constrained model calls.
- **Pipeline treated validation failure as `REJECTED`** → split `ABSTAINED` with a specific question, because “not allowed” and “missing the date” are different events.
- **Compensation folded into reject or abstain** → fourth outcome `ROUTED_OUT`; it is a real change on the wrong workflow.
- **`checkTrust` then a second submitter lookup for role** → `checkTrust` returns what it found; two implementations of one lookup drift.
- **Case-sensitive email match** → `.trim().toLowerCase()` on both sides, or `Priya.Nair@…` fails authorization.
- **`--all` failed if everything was rejected** → per-fixture `expected_outcome`; an intentionally rejected fixture matching is success.

## Open questions

- **Pending records have no timeout, reminder, or escalation.** A stalled clarification is indistinguishable from never-submitted — same gap as unattested Slice B manual steps.
- **Retroactive dates into a closed period.** Flagged, not blocked; needs the close calendar and a Controllership path.
- **Concurrent reorgs on the same cost centre.** Prototype store is last-write-wins; no locking.
- **Entity resolution beyond the fixture table.** “Priya’s team” → worker IDs needs a documented match strategy and a no-match path.
- **Who owns the graph file in six months.** Per-step owners are in the schema; review, change-control, and drift detection are process, not code.
- **Which gate comes off first.** Extraction-confirmation is the candidate once there is accuracy data; GL approval gates stay (controls).
- **Out-of-band manual steps.** The graph cannot prevent them — only detect after reconciliation read-back, which is not built.

## Considered and rejected

- **Model chooses propagation order (AI suggestion).** Order is physically constrained (CC must exist in GL before HR can reference it); a nondeterministic executor cannot be gated or audited.
- **Model self-reported confidence as the gate.** Not auditable and not fixture-testable; gate on required fields instead.
- **Build an injection detector.** Unreliable both ways; fixture 04 would be dropped as a false positive. Contain the call instead.
- **One model call that “handles the reorg.”** Mixes authorization, PII, classification, extraction, and side effects; injection gets an action surface.
- **Union extract schema with all-optional fields.** Makes `required` meaningless and pushes validation into hand-written conditionals.
- **Park Slice A as a durable Temporal/Step Functions execution.** Right for Slice B attestation; for intake we persist a pending *record* and re-enter at validate.
- **Persistent token vault.** New secrets store plus `[SALARY_1]` correlation across runs for data this workflow never writes.
- **Write compensation in this pipeline.** Requires cleartext salary in memory and a second approval chain; tokenize-and-discard only works if we never write it.
