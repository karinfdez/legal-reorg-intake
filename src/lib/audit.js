import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "out");
const AUDIT_PATH = join(OUT_DIR, "audit.jsonl");

/**
 * Append one audit event as a JSON line.
 * Slice A: { ts, message_id, step, status, reason? }
 * Slice B transitions: { ts, change_id, step_id, from_status, to_status, actor? }
 * Slice B events: { ts, event, change_id, step_id, actor? } — not a status change
 * Never envelope.text, salary, or any other raw payload.
 */
export function append(event) {
  const line = { ts: event.ts };
  if (event.event != null) line.event = event.event;
  if (event.message_id != null) line.message_id = event.message_id;
  if (event.change_id != null) line.change_id = event.change_id;
  if (event.step != null) line.step = event.step;
  if (event.step_id != null) line.step_id = event.step_id;
  if (event.status != null) line.status = event.status;
  if (event.from_status != null) line.from_status = event.from_status;
  if (event.to_status != null) line.to_status = event.to_status;
  if (event.reason != null) line.reason = event.reason;
  if (event.actor != null) line.actor = event.actor;

  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(AUDIT_PATH, `${JSON.stringify(line)}\n`, "utf8");
}

export function auditPath() {
  return AUDIT_PATH;
}
