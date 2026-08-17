#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

import { runPipeline } from "./pipeline.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENVELOPES_DIR = join(ROOT, "fixtures", "envelopes");
const AUTH_PATH = join(ROOT, "fixtures", "reference", "authorized_submitters.json");

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function printResult(result) {
  for (const entry of result.trace) {
    const step = entry.step.padEnd(10);
    const status = entry.status.padEnd(9);
    console.log(`[${entry.n}] ${step} ${status} ${entry.detail ?? ""}`);
  }

  if (result.outcome === "EMITTED") {
    console.log(`--> EMITTED ${result.id}`);
  } else if (result.outcome === "ABSTAINED") {
    console.log(`--> ABSTAINED "${result.question}"`);
  } else {
    console.log(`--> REJECTED ${result.reason ?? ""}`);
  }
}

async function runOne(envelopePath, authorizedSubmitters) {
  const envelope = await loadJson(envelopePath);
  const result = await runPipeline(envelope, { authorizedSubmitters });
  return { envelope, result };
}

async function listEnvelopePaths() {
  const names = (await readdir(ENVELOPES_DIR))
    .filter((name) => name.endsWith(".json"))
    .sort();
  return names.map((name) => ({ name, path: join(ENVELOPES_DIR, name) }));
}

function printUsage() {
  console.error("Usage:");
  console.error("  node src/cli.js <envelope.json>");
  console.error("  node src/cli.js --all");
}

// --all doubles as the regression suite. Each fixture declares the outcome it
// should produce; a fixture that is *supposed* to be rejected passing the check
// is a success, not a failure. Only a mismatch fails the run.
async function runAll(authorizedSubmitters) {
  const fixtures = await listEnvelopePaths();
  let mismatches = 0;

  for (const fixture of fixtures) {
    const { envelope, result } = await runOne(fixture.path, authorizedSubmitters);
    const expected = envelope.expected_outcome;
    const matched = expected === undefined || expected === result.outcome;
    if (!matched) mismatches += 1;

    const verdict = expected === undefined ? "" : matched ? "  ok" : `  MISMATCH (expected ${expected})`;
    console.log(`== ${fixture.name} ==${verdict}`);
    printResult(result);
    console.log("");
  }

  console.log(
    mismatches === 0
      ? `${fixtures.length} fixtures, all matched their expected outcome`
      : `${fixtures.length} fixtures, ${mismatches} mismatched`
  );

  return mismatches === 0 ? 0 : 1;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const authorizedSubmitters = await loadJson(AUTH_PATH);

  if (arg === "--all") {
    process.exitCode = await runAll(authorizedSubmitters);
    return;
  }

  const { result } = await runOne(resolve(arg), authorizedSubmitters);
  printResult(result);
  process.exitCode = result.outcome === "REJECTED" ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});