import Anthropic from "@anthropic-ai/sdk";

let callCount = 0;
let client;
let forcedError = null;
let callsThisRun = 0;

function getClient() {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

export function getModelCallCount() {
  return callCount;
}

export function resetModelCallCount() {
  callCount = 0;
}

/** Fixture-only: "timeout" fails the first model call; "extract_timeout" fails the second. */
export function setForcedModelError(kind) {
  forcedError = kind ?? null;
  callsThisRun = 0;
}

export function clearForcedModelError() {
  forcedError = null;
  callsThisRun = 0;
}

function timeoutError() {
  const err = new Error("Request timed out");
  err.name = "APIConnectionTimeoutError";
  return err;
}

export async function createMessage(params) {
  callCount += 1;
  callsThisRun += 1;

  if (forcedError === "timeout" && callsThisRun === 1) {
    throw timeoutError();
  }
  if (forcedError === "extract_timeout" && callsThisRun === 2) {
    throw timeoutError();
  }
  if (forcedError === "error") {
    throw new Error("simulated model failure");
  }

  return getClient().messages.create(params);
}
