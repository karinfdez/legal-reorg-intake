#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

import { listPending } from "./lib/pending.js";
import { answerPending, runPipeline } from "./pipeline.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENVELOPES_DIR = join(ROOT, "fixtures", "envelopes");
const AUTH_PATH = join(ROOT, "fixtures", "reference", "authorized_submitters.json");

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function printResult(result) {
  for (const entry of result.trace ?? []) {
    const step = entry.step.padEnd(10);
    const status = entry.status.padEnd(9);
    console.log(`[${entry.n}] ${step} ${status} ${entry.detail ?? ""}`);
  }

  if (result.outcome === "EMITTED") {
    const suffix = result.already_emitted
      ? " (already emitted)"
      : result.resolved_from_pending
        ? " (resolved from pending)"
        : "";
    console.log(`--> EMITTED ${result.id}${suffix}`);
  } else if (result.outcome === "ABSTAINED") {
    const id = result.change_id ? `${result.change_id} ` : "";
    console.log(`--> ABSTAINED ${id}"${result.question}"`);
  } else if (result.outcome === "ROUTED_OUT") {
    console.log(`--> ROUTED_OUT "${result.question}"`);
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
  console.error("  node src/cli.js pending");
  console.error(
    "  node src/cli.js answer <change_id> --field value [--field value ...]"
  );
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

function ageDays(askedAt) {
  const t = new Date(askedAt).getTime();
  if (Number.isNaN(t)) return "?";
  return `${Math.floor((Date.now() - t) / 86_400_000)}d`;
}

function printPendingTable() {
  const records = listPending();
  if (records.length === 0) {
    console.log("(no pending clarifications)");
    return;
  }

  const rows = records.map((record) => ({
    change_id: record.change_id ?? "",
    type: record.type ?? "",
    missing: (record.missing ?? []).join(","),
    asked_at: record.asked_at ?? "",
    age: ageDays(record.asked_at),
  }));
  const headers = ["change_id", "type", "missing", "asked_at", "age"];
  const widths = Object.fromEntries(
    headers.map((header) => [
      header,
      Math.max(header.length, ...rows.map((row) => String(row[header]).length)),
    ])
  );
  console.log(headers.map((header) => header.padEnd(widths[header])).join("  "));
  for (const row of rows) {
    console.log(
      headers.map((header) => String(row[header]).padEnd(widths[header])).join("  ")
    );
  }
}

function kebabToSnake(name) {
  return name.replaceAll("-", "_");
}

function coerceValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

function parseAnswerArgs(argv) {
  const changeId = argv[0];
  if (!changeId || changeId.startsWith("--")) {
    throw new Error(
      "Usage: node src/cli.js answer <change_id> --field value [--field value ...]"
    );
  }

  const fields = {};
  let actor;
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument '${token}'. Expected a --flag value.`);
    }

    let flag = token.slice(2);
    let value;
    const eq = flag.indexOf("=");
    if (eq >= 0) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    } else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Flag --${flag} requires a value.`);
      }
      i += 1;
    }

    const key = kebabToSnake(flag);
    if (key === "actor") {
      actor = value;
    } else {
      fields[key] = coerceValue(value);
    }
  }

  return { changeId, fields, actor };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (arg === "pending") {
    printPendingTable();
    return;
  }

  if (arg === "answer") {
    const { changeId, fields, actor } = parseAnswerArgs(process.argv.slice(3));
    const result = answerPending(changeId, fields, { actor });
    printResult(result);
    process.exitCode = result.outcome === "REJECTED" ? 1 : 0;
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
  console.error(err.message ?? err);
  process.exitCode = 1;
});
