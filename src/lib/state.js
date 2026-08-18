import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_DIR = join(ROOT, "out", "state");

function statePath(changeId) {
  return join(STATE_DIR, `${changeId}.json`);
}

function emptyStep() {
  return {
    status: "pending",
    started_at: null,
    completed_at: null,
    actor: null,
    ref: null,
    note: null,
  };
}

export function loadState(changeId) {
  const path = statePath(changeId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveState(state) {
  if (!state?.change_id) {
    throw new Error("saveState requires state.change_id");
  }
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(state.change_id), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export function initState(changeSet, graph) {
  const steps = {};
  for (const step of graph?.steps ?? []) {
    steps[step.id] = emptyStep();
  }
  return {
    change_id: changeSet.change_id,
    change_type: changeSet.type ?? graph?.change_type ?? null,
    steps,
  };
}

export function ensureStep(state, stepId) {
  if (!state.steps[stepId]) {
    state.steps[stepId] = emptyStep();
  }
  return state.steps[stepId];
}
