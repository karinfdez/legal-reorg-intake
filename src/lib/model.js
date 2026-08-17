import Anthropic from "@anthropic-ai/sdk";

let callCount = 0;
let client;

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

export async function createMessage(params) {
  callCount += 1;
  return getClient().messages.create(params);
}
