import "dotenv/config";
import { readFileSync } from "node:fs";
import { runPipeline } from "../src/pipeline.js";
import { auditPath } from "../src/lib/audit.js";

const envelope = JSON.parse(
  readFileSync(
    new URL("../fixtures/envelopes/11-model-timeout.json", import.meta.url),
    "utf8"
  )
);
const authorizedSubmitters = JSON.parse(
  readFileSync(
    new URL("../fixtures/reference/authorized_submitters.json", import.meta.url),
    "utf8"
  )
);

const result = await runPipeline(envelope, { authorizedSubmitters });
const raw = readFileSync(auditPath(), "utf8");
const lines = raw
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .filter((event) => event.message_id === envelope.message_id);

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

check("outcome is ABSTAINED, not EMITTED", result.outcome === "ABSTAINED", result.outcome);
check("no ChangeSet id was emitted", result.id == null, result.id);
check(
  "classify is logged as fail",
  lines.some((event) => event.step === "classify" && event.status === "fail"),
  JSON.stringify(lines)
);
check(
  "timeout is in the audit reason",
  lines.some(
    (event) =>
      event.step === "classify" &&
      String(event.reason ?? "").toLowerCase().includes("timed out")
  ),
  JSON.stringify(lines)
);
check("extract never ran", !lines.some((event) => event.step === "extract"));
const thisRun = lines.map((event) => JSON.stringify(event)).join("\n");
check(
  "audit has no email body",
  !thisRun.includes("Please move the Platform Analytics") &&
    !thisRun.includes(envelope.text),
  "payload leaked into audit.jsonl"
);
check(
  "audit has no resume token or salary",
  !thisRun.includes("[SALARY_") &&
    !thisRun.includes("$195") &&
    !thisRun.toLowerCase().includes("resume"),
  "sensitive or resume data leaked"
);
check(
  "audit lines only have ts, message_id, step, status, reason",
  lines.every((event) => {
    const keys = Object.keys(event).sort().join(",");
    return keys === "message_id,status,step,ts" || keys === "message_id,reason,status,step,ts";
  }),
  JSON.stringify(lines)
);

console.log("\n--- audit.jsonl for msg_011 ---");
for (const event of lines) {
  console.log(JSON.stringify(event));
}
console.log(`\n--> ${result.outcome} "${result.question}"`);

if (failed > 0) {
  console.log(`\n${failed} failed`);
  process.exitCode = 1;
} else {
  console.log("\nall checks passed");
}
