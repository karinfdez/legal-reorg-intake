import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { append } from "../lib/audit.js";
import { dispatch } from "../lib/adapters.js";
import { ensureStep, initState, loadState, saveState } from "../lib/state.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHANGESET_DIR = join(ROOT, "out", "changesets");
const GRAPH_DIR = join(ROOT, "graph");
const ACTORS_PATH = join(ROOT, "fixtures", "reference", "authorized_submitters.json");

// TODO: retries — a real GL/HR write can 500; stubs never fail, so there is nothing to retry.
// TODO: timeouts — a hung HTTP call would need a deadline; stubs return immediately.
// TODO: escalation — awaiting_attestation / awaiting_approval have no SLA, same gap as Slice A pending.
// TODO: parallel execution — independent roots could run together; this walk is serial so the trace is readable.
// TODO: rollback — a later failure does not undo completed writes; that would be a compensating graph, not a rewind.

const FORBIDDEN_FIELDS = new Set([
  "text",
  "tokens",
  "notes",
  "sender",
  "source",
  "envelope",
  "salary",
  "compensation",
  "comp_change",
  "ssn",
  "phone",
  "email",
]);

export function topoSort(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const ids = new Set(list.map((step) => step.id));
  const incoming = new Map(list.map((step) => [step.id, 0]));
  const edges = new Map(list.map((step) => [step.id, []]));

  for (const step of list) {
    for (const dep of step.depends_on ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`Step '${step.id}' depends on unknown step '${dep}'`);
      }
      incoming.set(step.id, incoming.get(step.id) + 1);
      edges.get(dep).push(step.id);
    }
  }

  const queue = list.filter((step) => incoming.get(step.id) === 0).map((step) => step.id);
  const orderedIds = [];

  while (queue.length > 0) {
    const id = queue.shift();
    orderedIds.push(id);
    for (const next of edges.get(id) ?? []) {
      incoming.set(next, incoming.get(next) - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }

  if (orderedIds.length !== list.length) {
    const cyclic = list
      .map((step) => step.id)
      .filter((id) => !orderedIds.includes(id));
    throw new Error(`Graph has a cycle involving: ${cyclic.join(", ")}`);
  }

  const byId = new Map(list.map((step) => [step.id, step]));
  return orderedIds.map((id) => byId.get(id));
}

export function loadChangeSet(changeId) {
  const path = join(CHANGESET_DIR, `${changeId}.json`);
  if (!existsSync(path)) {
    const error = new Error(
      `No ChangeSet at out/changesets/${changeId}.json. Emit one with Slice A first.`
    );
    error.code = "UNKNOWN_CHANGESET";
    throw error;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadGraph(changeType) {
  if (!changeType) {
    throw new Error("ChangeSet is missing type; cannot choose a graph.");
  }
  const path = join(GRAPH_DIR, `${changeType}.json`);
  if (!existsSync(path)) {
    throw new Error(`No graph for change type '${changeType}' (expected ${path}).`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadActors() {
  return JSON.parse(readFileSync(ACTORS_PATH, "utf8"));
}

export function lookupActor(raw) {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  const actors = loadActors();
  return (
    actors.find((entry) => {
      const email = String(entry?.email ?? "")
        .trim()
        .toLowerCase();
      if (!email) return false;
      const local = email.split("@")[0];
      return email === key || local === key;
    }) ?? null
  );
}

function now() {
  return new Date().toISOString();
}

function auditTransition({
  changeId,
  messageId,
  stepId,
  fromStatus,
  toStatus,
  actor,
}) {
  const line = {
    ts: now(),
    change_id: changeId,
    step_id: stepId,
    from_status: fromStatus,
    to_status: toStatus,
  };
  if (messageId != null) line.message_id = messageId;
  if (actor != null) line.actor = actor;
  append(line);
}

function auditEvent({ changeId, messageId, stepId, event, actor }) {
  const line = {
    ts: now(),
    event,
    change_id: changeId,
    step_id: stepId,
  };
  if (messageId != null) line.message_id = messageId;
  if (actor != null) line.actor = actor;
  append(line);
}

function transition(state, stepId, toStatus, extra = {}, { actor, messageId } = {}) {
  const rec = ensureStep(state, stepId);
  const fromStatus = rec.status;
  Object.assign(rec, extra);
  if (fromStatus === toStatus) return false;
  rec.status = toStatus;
  auditTransition({
    changeId: state.change_id,
    messageId,
    stepId,
    fromStatus,
    toStatus,
    actor: actor ?? rec.actor,
  });
  return true;
}

export function pickFields(changeSet, fieldNames = []) {
  const payload = {};
  for (const name of fieldNames) {
    if (FORBIDDEN_FIELDS.has(name)) continue;
    if (!Object.hasOwn(changeSet, name)) continue;
    payload[name] = changeSet[name];
  }
  return payload;
}

function dependentsOf(steps, stepId) {
  return steps.filter((step) => (step.depends_on ?? []).includes(stepId));
}

export function formatWorkOrder(changeSet, graph, step) {
  const fields = pickFields(changeSet, step.fields ?? []);
  const blocked = dependentsOf(graph.steps, step.id);
  const lines = [
    "WORK ORDER",
    "----------",
    `change_id:     ${changeSet.change_id}`,
    `step:          ${step.label} (${step.id})`,
    `system:        ${step.system}`,
    `owner:         ${step.owner}`,
    `effective:     ${changeSet.effective_date ?? "(not on ChangeSet)"}`,
    "",
    "Enter these values (absolute, not deltas):",
  ];

  const names = step.fields ?? [];
  if (names.length === 0) {
    lines.push("  (no fields listed on this step)");
  } else {
    for (const name of names) {
      if (FORBIDDEN_FIELDS.has(name)) continue;
      const value = fields[name];
      lines.push(`  ${name}:  ${formatFieldValue(value)}`);
    }
  }

  if (step.instructions) {
    lines.push("", "Instructions:", `  ${step.instructions}`);
  }

  lines.push("", "Blocked until this is attested:");
  if (blocked.length === 0) {
    lines.push("  (none)");
  } else {
    for (const dep of blocked) {
      lines.push(`  ${dep.id}  (${dep.label})`);
    }
  }

  lines.push(
    "",
    "When done, attest:",
    `  node src/cli.js attest ${changeSet.change_id} ${step.id} --by <actor>`
  );
  return lines.join("\n");
}

function formatFieldValue(value) {
  if (value === undefined) return "(not on ChangeSet)";
  if (Array.isArray(value)) return value.join(", ");
  if (value === null) return "null";
  return String(value);
}

function countStatuses(state, order) {
  const summary = {
    completed: 0,
    blocked: 0,
    awaiting: 0,
    failed: 0,
    pending: 0,
  };
  for (const step of order) {
    const status = state.steps[step.id]?.status ?? "pending";
    if (status === "completed") summary.completed += 1;
    else if (status === "blocked") summary.blocked += 1;
    else if (status === "failed") summary.failed += 1;
    else if (status === "pending") summary.pending += 1;
    else summary.awaiting += 1;
  }
  return summary;
}

function messageIdOf(changeSet) {
  return changeSet?.source?.message_id ?? null;
}

/**
 * Walk the graph in dependency order. Safe to call repeatedly:
 * a completed step is never re-run. `execution_key` is evidence of which
 * `${change_id}:${step_id}` ran, not a second guard.
 */
export function walk(changeSet, graph, state) {
  const order = topoSort(graph.steps);
  const workOrders = [];
  const ctx = { messageId: messageIdOf(changeSet) };

  for (const step of order) {
    const rec = ensureStep(state, step.id);
    const executionKey = `${changeSet.change_id}:${step.id}`;

    if (rec.status === "completed") continue;
    if (rec.status === "failed") continue;

    const unmet = (step.depends_on ?? []).filter(
      (id) => state.steps[id]?.status !== "completed"
    );
    if (unmet.length > 0) {
      if (!rec.started_at) rec.started_at = now();
      rec.note = `waiting on ${unmet.join(", ")}`;
      transition(state, step.id, "blocked", {}, ctx);
      continue;
    }

    if (step.approval && !rec.approved_at) {
      if (!rec.started_at) rec.started_at = now();
      rec.note = rec.note && rec.status === "awaiting_approval" ? rec.note : null;
      transition(state, step.id, "awaiting_approval", {}, ctx);
      continue;
    }

    if (step.mode === "manual_entry") {
      if (!rec.started_at) rec.started_at = now();
      const firstTime = rec.status !== "awaiting_attestation";
      transition(state, step.id, "awaiting_attestation", { note: null }, ctx);
      if (firstTime) workOrders.push(formatWorkOrder(changeSet, graph, step));
      continue;
    }

    if (step.mode === "api") {
      if (!rec.started_at) rec.started_at = now();
      const payload = pickFields(changeSet, step.fields ?? []);
      const result = dispatch(step.system, step.id, payload, changeSet.change_id);
      if (!result.ok) {
        transition(
          state,
          step.id,
          "failed",
          { note: result.error ?? "adapter_failed" },
          ctx
        );
        continue;
      }
      transition(
        state,
        step.id,
        "completed",
        {
          completed_at: now(),
          ref: result.ref,
          execution_key: executionKey,
          note: null,
        },
        ctx
      );
      continue;
    }

    transition(
      state,
      step.id,
      "failed",
      { note: `unknown mode '${step.mode}'` },
      ctx
    );
  }

  saveState(state);
  return {
    changeSet,
    graph,
    state,
    summary: countStatuses(state, order),
    workOrders,
  };
}

export function loadBundle(changeId) {
  const changeSet = loadChangeSet(changeId);
  const graph = loadGraph(changeSet.type);
  return { changeSet, graph };
}

export function propagate(changeId) {
  const { changeSet, graph } = loadBundle(changeId);
  let state = loadState(changeId);
  if (!state) {
    state = initState(changeSet, graph);
    saveState(state);
  }
  return walk(changeSet, graph, state);
}

export function statusOf(changeId) {
  const { changeSet, graph } = loadBundle(changeId);
  const state = loadState(changeId);
  if (!state) {
    const error = new Error(
      `No state for ${changeId}. Run: node src/cli.js propagate ${changeId}`
    );
    error.code = "NO_STATE";
    throw error;
  }
  return {
    changeSet,
    graph,
    state,
    summary: countStatuses(state, topoSort(graph.steps)),
    workOrders: [],
  };
}

export function attestStep(changeId, stepId, { actor, note } = {}) {
  if (!actor) {
    const error = new Error("attest requires --by <actor>");
    error.code = "MISSING_ACTOR";
    throw error;
  }

  const { changeSet, graph } = loadBundle(changeId);
  const state = loadState(changeId);
  if (!state) {
    const error = new Error(
      `No state for ${changeId}. Run: node src/cli.js propagate ${changeId}`
    );
    error.code = "NO_STATE";
    throw error;
  }

  const step = graph.steps.find((entry) => entry.id === stepId);
  if (!step) {
    const error = new Error(`Unknown step '${stepId}' on ${changeId}.`);
    error.code = "UNKNOWN_STEP";
    throw error;
  }

  const rec = ensureStep(state, stepId);
  if (rec.status !== "awaiting_attestation") {
    const error = new Error(
      `Step ${stepId} is '${rec.status}', not awaiting_attestation.`
    );
    error.code = "NOT_AWAITING_ATTESTATION";
    throw error;
  }

  const person = lookupActor(actor);
  const recordedActor = person?.email ?? actor;
  const executionKey = `${changeId}:${stepId}`;
  transition(
    state,
    stepId,
    "completed",
    {
      completed_at: now(),
      actor: recordedActor,
      ref: `attest:${executionKey}`,
      execution_key: executionKey,
      note: note ?? null,
    },
    { actor: recordedActor, messageId: messageIdOf(changeSet) }
  );
  saveState(state);
  return walk(changeSet, graph, state);
}

export function approveStep(changeId, stepId, { actor } = {}) {
  if (!actor) {
    const error = new Error("approve requires --by <actor>");
    error.code = "MISSING_ACTOR";
    throw error;
  }

  const { changeSet, graph } = loadBundle(changeId);
  const state = loadState(changeId);
  if (!state) {
    const error = new Error(
      `No state for ${changeId}. Run: node src/cli.js propagate ${changeId}`
    );
    error.code = "NO_STATE";
    throw error;
  }

  const step = graph.steps.find((entry) => entry.id === stepId);
  if (!step) {
    const error = new Error(`Unknown step '${stepId}' on ${changeId}.`);
    error.code = "UNKNOWN_STEP";
    throw error;
  }
  if (!step.approval) {
    const error = new Error(`Step ${stepId} does not require approval.`);
    error.code = "NO_APPROVAL";
    throw error;
  }

  const rec = ensureStep(state, stepId);
  if (rec.status !== "awaiting_approval") {
    const error = new Error(
      `Step ${stepId} is '${rec.status}', not awaiting_approval.`
    );
    error.code = "NOT_AWAITING_APPROVAL";
    throw error;
  }

  const person = lookupActor(actor);
  const required = step.approval.role;
  const actualRole = person?.role ?? null;
  if (!person || actualRole !== required) {
    const error = new Error(
      actualRole
        ? `rejected, wrong role: ${actor} is ${actualRole}, step requires ${required}`
        : `rejected, unknown actor '${actor}' (not in authorized_submitters.json)`
    );
    error.code = "WRONG_ROLE";
    error.result = {
      ok: false,
      error: error.message,
      changeSet,
      graph,
      state,
      summary: countStatuses(state, topoSort(graph.steps)),
      workOrders: [],
    };
    throw error;
  }

  rec.actor = person.email;
  rec.approved_at = now();
  rec.note = null;
  auditEvent({
    changeId,
    messageId: messageIdOf(changeSet),
    stepId,
    event: "approval_recorded",
    actor: person.email,
  });
  saveState(state);
  const result = walk(changeSet, graph, state);
  result.ok = true;
  return result;
}

export function formatStatusTable(graph, state) {
  const order = topoSort(graph.steps);
  const rows = order.map((step) => ({
    step: step.id,
    system: step.system,
    mode: step.mode === "manual_entry" ? "manual" : step.mode,
    status: state.steps[step.id]?.status ?? "pending",
  }));

  const headers = { step: "STEP", system: "SYSTEM", mode: "MODE", status: "STATUS" };
  const widths = {
    step: Math.max(headers.step.length, ...rows.map((row) => row.step.length)),
    system: Math.max(headers.system.length, ...rows.map((row) => row.system.length)),
    mode: Math.max(headers.mode.length, ...rows.map((row) => row.mode.length)),
    status: Math.max(headers.status.length, ...rows.map((row) => row.status.length)),
  };

  const line = (row) =>
    `${row.step.padEnd(widths.step)}  ${row.system.padEnd(widths.system)}  ${row.mode.padEnd(widths.mode)}  ${row.status}`;

  return [line(headers), ...rows.map(line)].join("\n");
}
