import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readPending, writePending } from "../lib/pending.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHANGESET_DIR = join(ROOT, "out", "changesets");

const FORBIDDEN_KEYS = new Set([
  "text",
  "tokens",
  "id",
  "envelope",
  "expected_outcome",
  "simulate_model_error",
]);

function changesetPath(changeId) {
  return join(CHANGESET_DIR, `${changeId}.json`);
}

function sourceFromEnvelope(envelope = {}) {
  return {
    message_id: envelope.message_id ?? null,
    sender: envelope.sender ?? null,
    source: envelope.source ?? null,
    received_at: envelope.received_at ?? null,
  };
}

function documentFrom(changeId, changeset, envelope) {
  const fields = {};
  for (const [key, value] of Object.entries(changeset ?? {})) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    fields[key] = value;
  }
  return {
    change_id: changeId,
    ...fields,
    notes: [...(changeset?.notes ?? [])],
    source: sourceFromEnvelope(envelope),
    created_at: new Date().toISOString(),
  };
}

export function readExisting(changeId) {
  const path = changesetPath(changeId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Persist a validated ChangeSet, or park an incomplete one as pending.
 * Never writes envelope.text or the redaction token map.
 * Does not touch a target system.
 */
export function emit(validation, envelope, { changeId } = {}) {
  const id = changeId ?? validation?.changeset?.id;
  if (!id) {
    throw new Error("emit requires a changeId");
  }

  if (!validation?.ok) {
    const existingPending = readPending(id);
    writePending({
      change_id: id,
      type: validation?.type ?? null,
      missing: validation?.missing ?? [],
      question: validation?.question ?? null,
      asked_at: existingPending?.asked_at ?? new Date().toISOString(),
      received_at: envelope?.received_at ?? null,
      correlation: {
        source: envelope?.source ?? null,
        sender: envelope?.sender ?? null,
        thread_id: envelope?.thread_id ?? null,
        message_id: envelope?.message_id ?? null,
      },
      partial_extraction: {
        fields: { ...(validation?.fields ?? {}) },
        missing: validation?.missing ?? [],
        notes: [...(validation?.notes ?? [])],
      },
    });
    return {
      outcome: "ABSTAINED",
      id,
      question: validation?.question ?? null,
      missing: validation?.missing ?? [],
    };
  }

  const existing = readExisting(id);
  if (existing) {
    return {
      outcome: "EMITTED",
      id,
      changeset: {
        ...existing,
        notes: [...(existing.notes ?? []), "already_emitted"],
      },
      already_emitted: true,
    };
  }

  const changeset = documentFrom(id, validation.changeset, envelope);
  mkdirSync(CHANGESET_DIR, { recursive: true });
  writeFileSync(changesetPath(id), `${JSON.stringify(changeset, null, 2)}\n`, "utf8");

  return {
    outcome: "EMITTED",
    id,
    changeset,
  };
}
