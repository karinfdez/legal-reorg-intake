import { append } from "./lib/audit.js";
import { checkTrust } from "./steps/01-trust.js";
import { redact } from "./steps/02-redact.js";
import { classify } from "./steps/03-classify.js";
import { extract } from "./steps/04-extract.js";
import { validate } from "./steps/05-validate.js";
import { emit } from "./steps/06-emit.js";

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

export async function runPipeline(envelope, { authorizedSubmitters } = {}) {
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

  const { redacted } = redact(envelope.text);
  pass(trace, 2, "redact", "(stub)", messageId);

  const classification = await classify(redacted);
  if (classification.type === "unclear") {
    const reason =
      classification.error ?? classification.reason ?? "unclear";
    auditStep(messageId, "classify", "abstain", reason);
    trace.push({
      n: 3,
      step: "classify",
      status: "ABSTAIN",
      detail: `type=unclear confidence=${classification.confidence}`,
    });
    return {
      outcome: "ABSTAINED",
      question: classification.error
        ? "Could not classify this message. Please restate the reorg change (team move, cost center split, or manager change)."
        : (classification.reason ??
          "The message does not clearly describe a team move, cost center split, or manager change. What change should we record?"),
      missing: ["type"],
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

  const changeset = await extract(redacted, classification);
  pass(trace, 4, "extract", "(stub)", messageId);

  const validation = validate(changeset);
  if (!validation.ok) {
    const missing = validation.missing ?? [];
    auditStep(messageId, "validate", "abstain", missing.join(","));
    trace.push({
      n: 5,
      step: "validate",
      status: "ABSTAIN",
      detail: `missing: ${missing.join(", ")}`,
    });
    return {
      outcome: "ABSTAINED",
      question: validation.question,
      missing,
      trace,
    };
  }
  pass(trace, 5, "validate", "(stub)", messageId);

  const emitted = emit(changeset);
  pass(trace, 6, "emit", "(stub)", messageId);

  return {
    outcome: "EMITTED",
    id: emitted.id,
    changeset,
    trace,
  };
}
