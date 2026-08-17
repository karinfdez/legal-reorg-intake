import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "out");
const AUDIT_PATH = join(OUT_DIR, "audit.jsonl");

/**
 * Append one audit event as a JSON line.
 * Only { ts, message_id, step, status, reason? } are written —
 * never envelope.text or any other raw payload.
 */
export function append(event) {
  const line = {
    ts: event.ts,
    message_id: event.message_id,
    step: event.step,
    status: event.status,
  };
  if (event.reason != null) {
    line.reason = event.reason;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(AUDIT_PATH, `${JSON.stringify(line)}\n`, "utf8");
}
