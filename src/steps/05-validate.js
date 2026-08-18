import { createHash } from "node:crypto";

const REQUIRED = {
  team_move: [
    "team_name",
    "worker_count",
    "manager_from_name",
    "manager_to_name",
    "cost_center_from",
    "cost_center_to",
    "effective_date",
    "comp_change",
  ],
  manager_change: [
    "worker_names",
    "manager_from_name",
    "manager_to_name",
    "effective_date",
    "comp_change",
  ],
  cost_center_split: [
    "cost_center_source",
    "cost_centers_target",
    "split_basis",
    "effective_date",
    "comp_change",
  ],
};

const FIELD_LABELS = {
  team_name: "team name",
  worker_count: "headcount",
  manager_from_name: "current manager",
  manager_to_name: "new manager",
  cost_center_from: "source cost centre",
  cost_center_to: "destination cost centre",
  cost_center_source: "source cost centre",
  cost_centers_target: "target cost centres",
  split_basis: "split basis",
  effective_date: "effective date",
  worker_names: "worker names",
  worker_ids: "worker IDs",
  comp_change: "whether compensation is changing",
};

export function changeIdFor(messageId) {
  const hash = createHash("sha256")
    .update(String(messageId ?? ""))
    .digest("hex")
    .slice(0, 8);
  return `chg_${hash}`;
}

export function validate(
  extraction,
  { type, receivedAt, messageId, managers = [], costCenters = [] } = {}
) {
  const fields = { ...(extraction?.fields ?? {}) };
  const notes = [...(extraction?.notes ?? [])];

  // Presence wins over the model's missing[] report. If the model listed a
  // field as missing but also emitted a value, trust the value. If it forgot
  // to report a gap, required-field presence still catches it.
  const missing = collectMissing(type, fields, extraction?.missing ?? []);

  if (missing.length > 0) {
    return failResult(type, fields, notes, missing, buildQuestion(type, fields, missing));
  }

  const dateProblem = applyEffectiveDate(fields.effective_date, receivedAt, notes);
  if (dateProblem) {
    return failResult(type, fields, notes, ["effective_date"], dateProblem);
  }

  const resolved = { ...fields };
  const nameFields = nameFieldsFor(type);
  for (const field of nameFields) {
    const result = resolveManager(fields[field], managers);
    if (!result.ok) {
      return failResult(type, fields, notes, [field], result.question);
    }
    resolved[idField(field)] = result.id;
  }

  const ccFields = costCenterFieldsFor(type, fields);
  for (const { field, value } of ccFields) {
    const result = resolveCostCenter(value, costCenters);
    if (!result.ok) {
      return failResult(type, fields, notes, [field], result.question);
    }
    if (field === "cost_centers_target") {
      resolved.cost_centers_target_ids = [
        ...(resolved.cost_centers_target_ids ?? []),
        result.id,
      ];
    } else {
      resolved[idField(field)] = result.id;
    }
  }

  return {
    ok: true,
    missing: [],
    question: null,
    changeset: {
      id: changeIdFor(messageId),
      type,
      ...resolved,
      notes,
    },
  };
}

function failResult(type, fields, notes, missing, question) {
  return {
    ok: false,
    type: type ?? null,
    fields: { ...fields },
    notes: [...notes],
    missing,
    question,
  };
}

function collectMissing(type, fields, reported) {
  const required = REQUIRED[type] ?? [];
  const missing = [];
  const seen = new Set();
  for (const name of [...reported, ...required]) {
    if (seen.has(name)) continue;
    if (name === "*") {
      missing.push("*");
      seen.add("*");
      continue;
    }
    if (!(name in fields) || fields[name] === undefined || fields[name] === "") {
      missing.push(name);
      seen.add(name);
    }
  }
  return missing;
}

function nameFieldsFor(type) {
  if (type === "cost_center_split") return [];
  return ["manager_from_name", "manager_to_name"];
}

function costCenterFieldsFor(type, fields) {
  if (type === "team_move") {
    return [
      { field: "cost_center_from", value: fields.cost_center_from },
      { field: "cost_center_to", value: fields.cost_center_to },
    ];
  }
  if (type === "cost_center_split") {
    const targets = Array.isArray(fields.cost_centers_target)
      ? fields.cost_centers_target.map((value, i) => ({
          field: "cost_centers_target",
          value,
          index: i,
        }))
      : [];
    return [{ field: "cost_center_source", value: fields.cost_center_source }, ...targets];
  }
  return [];
}

function idField(name) {
  if (name.endsWith("_name")) return `${name.slice(0, -5)}_id`;
  return `${name}_id`;
}

function normalizeName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function resolveManager(name, managers) {
  const key = normalizeName(name);
  const matches = managers.filter(
    (entry) => entry && normalizeName(entry.name) === key
  );
  if (matches.length === 0) {
    return {
      ok: false,
      question: `I could not resolve manager "${name}" to a known person. Who is that?`,
    };
  }
  if (matches.length > 1) {
    const ids = matches.map((entry) => entry.id).join(" or ");
    return {
      ok: false,
      question: `Which "${name}" did you mean (${ids})?`,
    };
  }
  return { ok: true, id: matches[0].id };
}

function resolveCostCenter(code, costCenters) {
  const key = String(code ?? "")
    .trim()
    .toUpperCase();
  const matches = costCenters.filter(
    (entry) => entry && String(entry.code).trim().toUpperCase() === key
  );
  if (matches.length === 0) {
    return {
      ok: false,
      question: `I could not resolve cost centre "${code}". Which cost centre is that?`,
    };
  }
  if (matches.length > 1) {
    const ids = matches.map((entry) => entry.id ?? entry.code).join(" or ");
    return {
      ok: false,
      question: `Which cost centre "${code}" did you mean (${ids})?`,
    };
  }
  if (matches[0].active === false) {
    return {
      ok: false,
      question: `Cost centre ${code} is not active. Which active cost centre should we use?`,
    };
  }
  return { ok: true, id: matches[0].id ?? matches[0].code };
}

function applyEffectiveDate(value, receivedAt, notes) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return "What is the effective date (YYYY-MM-DD)?";
  }
  const effective = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(effective.getTime())) {
    return `The effective date ${value} is not a valid calendar date. What is the correct date?`;
  }
  const received = new Date(receivedAt);
  if (Number.isNaN(received.getTime())) {
    return null;
  }

  // Past dates are flagged, not blocked. Whether they are allowed depends on
  // the close calendar and a Controllership rule this prototype does not have.
  const receivedDay = received.toISOString().slice(0, 10);
  if (value < receivedDay) {
    notes.push("retroactive_effective_date");
  }

  const max = new Date(received);
  max.setUTCMonth(max.getUTCMonth() + 24);
  if (effective > max) {
    return `The effective date ${value} is more than 24 months from the request date. Please confirm the date.`;
  }
  return null;
}

function buildQuestion(type, fields, missing) {
  if (missing.includes("*")) {
    return "Could not extract this change. Please restate the team, managers, cost centres, and effective date.";
  }
  const subject = fields.team_name
    ? `the ${fields.team_name} team move`
    : `this ${String(type ?? "change").replaceAll("_", " ")}`;
  if (missing.length === 1) {
    const label = FIELD_LABELS[missing[0]] ?? missing[0];
    return `What is the ${label} for ${subject}?`;
  }
  const labels = missing.map((name) => FIELD_LABELS[name] ?? name).join(", ");
  return `${subject} is missing: ${labels}. Please provide these.`;
}
