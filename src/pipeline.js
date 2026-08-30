import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { append } from "./lib/audit.js";
import { clearForcedModelError, setForcedModelError } from "./lib/model.js";
import {
  isResolved,
  readPending,
  resolvePending,
  writePending,
} from "./lib/pending.js";
import { checkTrust } from "./steps/01-trust.js";
import { redact } from "./steps/02-redact.js";
import { classify } from "./steps/03-classify.js";
import { extract } from "./steps/04-extract.js";
import { changeIdFor, validate } from "./steps/05-validate.js";
import { emit, readExisting } from "./steps/06-emit.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadReference(name) {
  return JSON.parse(
    readFileSync(join(ROOT, "fixtures", "reference", name), "utf8")
  );
}

function auditStep(messageId, step, status, reason) {
  append({
    ts: new Date().toISOString(),
    message_id: messageId,
    step,
    status,
    ...(reason ? { reason } : {}),
  });
}

function fail(trace, n, step, reason, messageId) {
  auditStep(messageId, step, "fail", reason);
  trace.push({ n, step, status: "FAIL", detail: reason });
  return { outcome: "REJECTED", reason, trace };
}

function pass(trace, n, step, detail, messageId) {
  auditStep(messageId, step, "pass");
  trace.push({ n, step, status: "PASS", detail });
}

function persistAbstain(envelope, { type, missing, question, extraction }) {
  const changeId = changeIdFor(envelope.message_id);
  writePending({
    change_id: changeId,
    status: "awaiting_clarification",
    type: type ?? null,
    missing,
    question,
    asked_at: new Date().toISOString(),
    received_at: envelope.received_at,
    correlation: {
      source: envelope.source,
      sender: envelope.sender,
      thread_id: envelope.thread_id ?? null,
      message_id: envelope.message_id,
    },
    partial_extraction: {
      fields: { ...(extraction?.fields ?? {}) },
      missing: extraction?.missing ?? missing,
      notes: [...(extraction?.notes ?? [])],
    },
  });
  auditStep(
    envelope.message_id,
    "pending",
    "awaiting_clarification",
    changeId
  );
  return changeId;
}

export async function runPipeline(envelope, { authorizedSubmitters } = {}) {
  if (envelope.simulate_model_error) {
    setForcedModelError(envelope.simulate_model_error);
  }
  try {
    return await runPipelineInner(envelope, { authorizedSubmitters });
  } finally {
    clearForcedModelError();
  }
}

async function runPipelineInner(envelope, { authorizedSubmitters } = {}) {
  const trace = [];
  const messageId = envelope.message_id;

  const trust = checkTrust(envelope, { authorizedSubmitters });
  if (!trust.ok) {
    return fail(trace, 1, "trust", trust.reason, messageId);
  }
  pass(
    trace,
    1,
    "trust",
    `sender=${envelope.sender} role=${trust.submitter.role}`,
    messageId
  );

  // A redelivery of a message that already produced a ChangeSet (including
  // one originally ABSTAINED and later resolved via `answer`) must not
  // re-run classify/extract/validate: the changeset already exists and the
  // original text hasn't changed. Checked by change_id, not by content.
  const changeId = changeIdFor(messageId);
  const existingChangeset = readExisting(changeId);
  if (existingChangeset) {
    auditStep(messageId, "emit", "already_emitted", changeId);
    trace.push({
      n: 2,
      step: "emit",
      status: "PASS",
      detail: `already emitted ${changeId} (redelivered message)`,
    });
    return {
      outcome: "EMITTED",
      id: changeId,
      change_id: changeId,
      changeset: {
        ...existingChangeset,
        notes: [...(existingChangeset.notes ?? []), "already_emitted"],
      },
      already_emitted: true,
      trace,
    };
  }

  // Pass only `redacted` downstream. Never send `tokens` to the model or audit.
  const { redacted, tokens } = redact(envelope.text);
  const tokenCount = Object.keys(tokens).length;
  pass(
    trace,
    2,
    "redact",
    tokenCount === 0 ? "no PII detected" : `${tokenCount} tokens replaced`,
    messageId
  );

  const classification = await classify(redacted);
  if (classification.type === "unclear") {
    const isError = Boolean(classification.error);
    const reason =
      classification.error ?? classification.reason ?? "unclear";
    auditStep(messageId, "classify", isError ? "fail" : "abstain", reason);
    trace.push({
      n: 3,
      step: "classify",
      status: isError ? "FAIL" : "ABSTAIN",
      detail: isError
        ? reason
        : `type=unclear confidence=${classification.confidence}`,
    });
    const question = classification.error
      ? "Could not classify this message. Please restate the reorg change (team move, cost center split, or manager change)."
      : (classification.reason ??
        "The message does not clearly describe a team move, cost center split, or manager change. What change should we record?");
    const missing = ["type"];
    const changeId = persistAbstain(envelope, {
      type: classification.type,
      missing,
      question,
    });
    return {
      outcome: "ABSTAINED",
      question,
      missing,
      change_id: changeId,
      trace,
    };
  }
  pass(
    trace,
    3,
    "classify",
    `type=${classification.type} confidence=${classification.confidence}`,
    messageId
  );

  const extraction = await extract(redacted, classification);
  if (extraction.missing?.includes("*")) {
    const reason = extraction.notes?.[0] ?? "extract_failed";
    auditStep(messageId, "extract", "fail", reason);
    trace.push({
      n: 4,
      step: "extract",
      status: "FAIL",
      detail: reason,
    });
    const question =
      "Could not extract this change (the model call failed or timed out). Please resubmit the request; nothing was written.";
    const missing = ["*"];
    const changeId = persistAbstain(envelope, {
      type: classification.type,
      missing,
      question,
      extraction,
    });
    return {
      outcome: "ABSTAINED",
      question,
      missing,
      change_id: changeId,
      trace,
    };
  }
  const extractDetail =
    extraction.missing?.length > 0
      ? `missing: ${extraction.missing.join(", ")}`
      : `comp_change=${extraction.fields?.comp_change === true}`;
  pass(trace, 4, "extract", extractDetail, messageId);

  const validation = validate(extraction, {
    type: classification.type,
    receivedAt: envelope.received_at,
    messageId: envelope.message_id,
    managers: loadReference("managers.json"),
    costCenters: loadReference("cost_centers.json"),
  });
  if (!validation.ok) {
    const missing = validation.missing ?? [];
    auditStep(messageId, "validate", "abstain", missing.join(","));
    trace.push({
      n: 5,
      step: "validate",
      status: "ABSTAIN",
      detail: `missing: ${missing.join(", ")}`,
    });
    const emitted = emit(validation, envelope, { changeId });
    auditStep(messageId, "pending", "awaiting_clarification", emitted.id);
    return {
      outcome: "ABSTAINED",
      question: emitted.question,
      missing: emitted.missing,
      id: emitted.id,
      change_id: emitted.id,
      trace,
    };
  }
  const changeset = validation.changeset;
  pass(
    trace,
    5,
    "validate",
    (changeset.notes ?? []).includes("retroactive_effective_date")
      ? "resolved retroactive_effective_date"
      : "resolved",
    messageId
  );

  if (changeset.comp_change === true) {
    auditStep(messageId, "route", "routed_out", "comp_change");
    trace.push({
      n: 6,
      step: "route",
      status: "ROUTED",
      detail: "comp_change=true",
    });
    return {
      outcome: "ROUTED_OUT",
      reason: "comp_change_requires_separate_workflow",
      question:
        "This request includes compensation changes, which go through comp review rather than this pipeline. I can process the structural move on its own — confirm and I'll continue.",
      changeset,
      id: changeId,
      change_id: changeId,
      trace,
    };
  }

  const emitted = emit(validation, envelope, { changeId });
  pass(
    trace,
    6,
    "emit",
    emitted.already_emitted ? "already emitted" : `wrote ${emitted.id}`,
    messageId
  );

  return {
    outcome: "EMITTED",
    id: emitted.id,
    change_id: emitted.id,
    changeset: emitted.changeset,
    already_emitted: emitted.already_emitted,
    trace,
  };
}

/**
 * Resume an ABSTAINED change from persisted state. Re-enters at validate
 * (gate 5) then emit (gate 6). Does not re-run trust, redact, classify, or
 * extract — those already ran against the original (redacted) text.
 */
export function answerPending(changeId, fieldUpdates = {}, { actor } = {}) {
  const record = readPending(changeId);
  if (!record) {
    const error = new Error(
      isResolved(changeId)
        ? `Change ${changeId} is already resolved.`
        : `Unknown change_id '${changeId}'.`
    );
    error.code = isResolved(changeId) ? "ALREADY_RESOLVED" : "UNKNOWN_CHANGE";
    throw error;
  }

  const fields = {
    ...(record.partial_extraction?.fields ?? {}),
    ...fieldUpdates,
  };
  const extraction = {
    fields,
    missing: (record.partial_extraction?.missing ?? record.missing ?? []).filter(
      (name) => !(name in fieldUpdates)
    ),
    notes: [...(record.partial_extraction?.notes ?? [])],
  };

  const trace = [];
  const messageId = record.correlation?.message_id;
  const envelope = {
    message_id: messageId,
    sender: record.correlation?.sender,
    source: record.correlation?.source,
    received_at: record.received_at,
    thread_id: record.correlation?.thread_id,
  };
  const validation = validate(extraction, {
    type: record.type,
    receivedAt: record.received_at,
    messageId,
    managers: loadReference("managers.json"),
    costCenters: loadReference("cost_centers.json"),
  });

  if (!validation.ok) {
    auditStep(messageId, "validate", "abstain", (validation.missing ?? []).join(","));
    trace.push({
      n: 5,
      step: "validate",
      status: "ABSTAIN",
      detail: `missing: ${(validation.missing ?? []).join(", ")}`,
    });
    const emitted = emit(validation, envelope, { changeId });
    return {
      outcome: "ABSTAINED",
      question: emitted.question,
      missing: emitted.missing,
      id: emitted.id,
      change_id: emitted.id,
      trace,
    };
  }

  const changeset = validation.changeset;
  const validateDetail = (changeset.notes ?? []).includes(
    "retroactive_effective_date"
  )
    ? "resolved retroactive_effective_date"
    : "resolved";
  pass(trace, 5, "validate", validateDetail, messageId);

  if (changeset.comp_change === true) {
    auditStep(messageId, "route", "routed_out", "comp_change");
    trace.push({
      n: 6,
      step: "route",
      status: "ROUTED",
      detail: "comp_change=true",
    });
    writePending({
      ...record,
      missing: [],
      question:
        "This request includes compensation changes, which go through comp review rather than this pipeline. I can process the structural move on its own — confirm and I'll continue.",
      partial_extraction: {
        fields,
        missing: [],
        notes: extraction.notes,
      },
    });
    return {
      outcome: "ROUTED_OUT",
      reason: "comp_change_requires_separate_workflow",
      question:
        "This request includes compensation changes, which go through comp review rather than this pipeline. I can process the structural move on its own — confirm and I'll continue.",
      changeset,
      change_id: changeId,
      trace,
    };
  }

  const emitted = emit(validation, envelope, { changeId });
  pass(
    trace,
    6,
    "emit",
    emitted.already_emitted ? "already emitted" : `wrote ${emitted.id}`,
    messageId
  );
  resolvePending(changeId);
  append({
    ts: new Date().toISOString(),
    message_id: messageId,
    step: "pending",
    status: "resolved_from_pending",
    reason: changeId,
    ...(actor ? { actor } : {}),
  });

  return {
    outcome: "EMITTED",
    id: emitted.id,
    change_id: changeId,
    changeset: emitted.changeset,
    already_emitted: emitted.already_emitted,
    resolved_from_pending: true,
    trace,
  };
}
