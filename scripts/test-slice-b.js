import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  approveStep,
  attestStep,
  propagate,
  topoSort,
} from "../src/slice-b/orchestrator.js";
import { loadState } from "../src/lib/state.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ID = "chg_sliceb01";
const CHANGESET_PATH = join(ROOT, "out", "changesets", `${ID}.json`);
const STATE_PATH = join(ROOT, "out", "state", `${ID}.json`);

let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function statuses() {
  const state = loadState(ID);
  return Object.fromEntries(
    Object.entries(state.steps).map(([id, rec]) => [id, rec.status])
  );
}

{
  const cycle = topoSort.bind(null, [
    { id: "a", depends_on: ["b"] },
    { id: "b", depends_on: ["a"] },
  ]);
  let threw = false;
  try {
    cycle();
  } catch (err) {
    threw = /cycle/i.test(err.message);
  }
  check("topoSort throws on a cycle", threw);
}

mkdirSync(join(ROOT, "out", "changesets"), { recursive: true });
writeFileSync(
  CHANGESET_PATH,
  `${JSON.stringify(
    {
      change_id: ID,
      type: "team_move",
      team_name: "Platform Analytics",
      worker_count: 6,
      manager_from_id: "M-315",
      manager_to_id: "M-201",
      cost_center_from_id: "CC-4100",
      cost_center_to_id: "CC-4200",
      worker_ids: ["W-4471"],
      effective_date: "2026-10-01",
      source: { message_id: "msg_sliceb" },
    },
    null,
    2
  )}\n`
);
rmSync(STATE_PATH, { force: true });
const auditPath = join(ROOT, "out", "audit.jsonl");
const auditOffset = existsSync(auditPath) ? readFileSync(auditPath, "utf8").length : 0;

const first = propagate(ID);
const s1 = statuses();
check(
  "first propagate: 1 and 2 completed",
  s1.create_cost_centre_mapping === "completed" &&
    s1.update_worker_assignment === "completed",
  JSON.stringify(s1)
);
check(
  "first propagate: 3 awaiting_attestation",
  s1.update_headcount_plan === "awaiting_attestation",
  s1.update_headcount_plan
);
check(
  "first propagate: 4 blocked",
  s1.update_allocation_rules === "blocked",
  s1.update_allocation_rules
);
check("first propagate prints a work order", first.workOrders.length === 1);

const refsAfterFirst = {
  gl: loadState(ID).steps.create_cost_centre_mapping.ref,
  hr: loadState(ID).steps.update_worker_assignment.ref,
};
const second = propagate(ID);
const s2 = statuses();
check("second propagate is unchanged", JSON.stringify(s2) === JSON.stringify(s1));
check("second propagate prints no new work order", second.workOrders.length === 0);
check(
  "second propagate does not change refs",
  loadState(ID).steps.create_cost_centre_mapping.ref === refsAfterFirst.gl &&
    loadState(ID).steps.update_worker_assignment.ref === refsAfterFirst.hr
);

attestStep(ID, "update_headcount_plan", { actor: "dana.wu" });
const s3 = statuses();
check(
  "attest completes step 3",
  s3.update_headcount_plan === "completed",
  s3.update_headcount_plan
);
check(
  "attest unblocks step 4 to awaiting_approval",
  s3.update_allocation_rules === "awaiting_approval",
  s3.update_allocation_rules
);

let wrongRole = false;
try {
  approveStep(ID, "update_allocation_rules", { actor: "dana.wu" });
} catch (err) {
  wrongRole = err.code === "WRONG_ROLE";
}
check("approve by dana.wu is rejected (wrong role)", wrongRole);
check(
  "wrong-role approve leaves step 4 awaiting_approval",
  statuses().update_allocation_rules === "awaiting_approval"
);

approveStep(ID, "update_allocation_rules", { actor: "aisha.rahman" });
const s4 = statuses();
check(
  "approve by finance_owner completes step 4",
  s4.update_allocation_rules === "completed",
  s4.update_allocation_rules
);
check(
  "all steps completed",
  Object.values(s4).every((status) => status === "completed"),
  JSON.stringify(s4)
);

const auditLines = readFileSync(auditPath, "utf8")
  .slice(auditOffset)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((line) => line.change_id === ID && line.step_id === "update_allocation_rules");
const recorded = auditLines.filter((line) => line.event === "approval_recorded");
const fakeApproved = auditLines.filter(
  (line) => line.from_status === "awaiting_approval" && line.to_status === "approved"
);
const completed = auditLines.filter(
  (line) => line.from_status === "awaiting_approval" && line.to_status === "completed"
);
check("approval is logged as event approval_recorded", recorded.length === 1);
check("audit has no fake awaiting_approval → approved", fakeApproved.length === 0);
check("status change is awaiting_approval → completed", completed.length === 1);

if (failed > 0) {
  console.log(`\n${failed} failed`);
  process.exitCode = 1;
} else {
  console.log("\nall slice-b checks passed");
}
