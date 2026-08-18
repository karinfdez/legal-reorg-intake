import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PENDING_DIR = join(ROOT, "out", "pending");
const RESOLVED_DIR = join(PENDING_DIR, "resolved");

// TODO: pending records never time out or escalate. A silently stalled change
// is indistinguishable from one that was never submitted. Production needs an
// SLA (age-out, reminder, or named-owner escalation). This store is the seam
// a durable engine (Temporal, Step Functions) would replace later — we persist
// the STATE, not the EXECUTION.

function pendingPath(changeId) {
  return join(PENDING_DIR, `${changeId}.json`);
}

function resolvedPath(changeId) {
  return join(RESOLVED_DIR, `${changeId}.json`);
}

function sanitize(record) {
  return {
    change_id: record.change_id,
    status: "awaiting_clarification",
    type: record.type ?? null,
    missing: [...(record.missing ?? [])],
    question: record.question ?? null,
    asked_at: record.asked_at,
    received_at: record.received_at ?? null,
    correlation: {
      source: record.correlation?.source ?? null,
      sender: record.correlation?.sender ?? null,
      thread_id: record.correlation?.thread_id ?? null,
      message_id: record.correlation?.message_id ?? null,
    },
    partial_extraction: {
      fields: { ...(record.partial_extraction?.fields ?? {}) },
      missing: [...(record.partial_extraction?.missing ?? [])],
      notes: [...(record.partial_extraction?.notes ?? [])],
    },
  };
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writePending(record) {
  const safe = sanitize(record);
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(pendingPath(safe.change_id), `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  return safe;
}

export function readPending(changeId) {
  return readJsonIfExists(pendingPath(changeId));
}

export function isResolved(changeId) {
  return existsSync(resolvedPath(changeId));
}

export function listPending() {
  if (!existsSync(PENDING_DIR)) return [];
  return readdirSync(PENDING_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonIfExists(join(PENDING_DIR, name)))
    .filter(Boolean)
    .sort((a, b) => String(a.asked_at ?? "").localeCompare(String(b.asked_at ?? "")));
}

export function resolvePending(changeId) {
  const from = pendingPath(changeId);
  if (!existsSync(from)) {
    return null;
  }
  mkdirSync(RESOLVED_DIR, { recursive: true });
  const to = resolvedPath(changeId);
  if (existsSync(to)) {
    unlinkSync(to);
  }
  renameSync(from, to);
  return readJsonIfExists(to);
}
