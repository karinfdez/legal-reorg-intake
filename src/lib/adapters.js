/**
 * Stub adapters — one per downstream system.
 *
 * Real integrations replace this file only. The orchestrator calls
 * `dispatch(system, stepId, payload)` and records `{ ok, ref }`.
 * Nothing here makes HTTP; it logs the payload it WOULD send.
 */

const SYSTEMS = {
  gl_accounting: stub("gl_accounting"),
  hris: stub("hris"),
  planning_tool: stub("planning_tool"),
};

function stub(system) {
  return (stepId, payload, changeId) => {
    const ref = `${system}:${stepId}:${changeId}`;
    console.log(
      `[adapter:${system}] would send ${JSON.stringify({ step_id: stepId, payload })}`
    );
    return { ok: true, ref };
  };
}

export function dispatch(system, stepId, payload, changeId) {
  const adapter = SYSTEMS[system];
  if (!adapter) {
    return { ok: false, ref: null, error: `no adapter for system '${system}'` };
  }
  return adapter(stepId, payload, changeId);
}
