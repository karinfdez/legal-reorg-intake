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
    if (result.change_id) {
      console.log("");
      console.log("The run stopped. The question is saved on disk (not Slack).");
      console.log("  See open questions:  node src/cli.js pending");
      console.log(
        `  Answer this one:     ${suggestAnswerCommand(result.change_id, result.missing)}`
      );
    }
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
  console.error("  node src/cli.js <envelope.json>   Process one email/Slack message");
  console.error("  node src/cli.js --all             Process every file in fixtures/envelopes/");
  console.error("  node src/cli.js pending           Show questions the tool is waiting on");
  console.error(
    "  node src/cli.js answer <id> --effective-date 2026-10-01"
  );
  console.error("                                 Fill in a missing field and finish that change");
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

function snakeToKebab(name) {
  return String(name).replaceAll("_", "-");
}

function suggestAnswerCommand(changeId, missing = []) {
  const fields = missing.filter((name) => name && name !== "*" && name !== "type");
  if (fields.length === 0) {
    return `node src/cli.js answer ${changeId} --effective-date 2026-10-01`;
  }
  const flags = fields
    .map((name) => {
      const flag = snakeToKebab(name);
      if (name === "effective_date") return `--${flag} 2026-10-01`;
      return `--${flag} VALUE`;
    })
    .join(" ");
  return `node src/cli.js answer ${changeId} ${flags}`;
}

function printPendingTable() {
  const records = listPending();
  if (records.length === 0) {
    console.log("No open questions.");
    console.log(
      "When a message is incomplete, the tool saves a question as a file in out/pending/."
    );
    console.log("This list is that folder — not Slack, not email.");
    return;
  }

  console.log("Open questions — the tool stopped and is waiting for a person.");
  console.log("Saved as files in out/pending/ (not Slack). Copy the command under a question to answer it.");
  console.log("");

  records.forEach((record, index) => {
    const id = record.change_id ?? "";
    const missing = record.missing ?? [];
    const age = ageDays(record.asked_at);
    console.log(`${index + 1}. ${id}  (${record.type ?? "change"}, waiting ${age})`);
    console.log(`   The tool asked: ${record.question ?? "(no question stored)"}`);
    console.log(`   Missing: ${missing.join(", ") || "(none)"}`);
    console.log("   Type this (replace the placeholder with the real value):");
    console.log("");
    console.log(`     ${suggestAnswerCommand(id, missing)}`);
    console.log("");
  });
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
