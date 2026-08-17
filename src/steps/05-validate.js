export function validate(changeset) {
  // TODO: if required fields are missing, return
  // { ok: false, missing: ["effective_date"], question: "What is the effective date ...?" }
  // That is an abstain, not a reject.
  return { ok: true, missing: [], question: null };
}
