/**
 * Redact secrets and PII from untrusted message text.
 *
 * The token map is process-local. It is never written to the audit log,
 * never persisted, and never sent to a model. It is discarded when the run ends.
 */
export function redact(text) {
  const intern = makeInterner();

  let redacted = text == null ? "" : String(text);

  // SSN and phone before the 8+ digit account pattern, or those digit runs
  // get classified as account numbers.
  redacted = replaceAll(redacted, /\b\d{3}-\d{2}-\d{4}\b/g, "SSN", intern);
  redacted = replaceAll(redacted, phonePattern(), "PHONE", intern);
  redacted = replaceAll(
    redacted,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "EMAIL",
    intern
  );
  redacted = replaceAll(redacted, accountPattern(), "ACCOUNT", intern);
  redacted = replaceCapture(redacted, salaryPhrasePattern(), "SALARY", intern);
  redacted = replaceAll(redacted, currencyPattern(), "SALARY", intern);

  return { redacted, tokens: intern.tokens };
}

function makeInterner() {
  const counts = Object.create(null);
  const valueToToken = new Map();
  const tokens = {};

  function intern(type, value) {
    const key = `${type}:${value}`;
    const existing = valueToToken.get(key);
    if (existing) return existing;
    counts[type] = (counts[type] ?? 0) + 1;
    const token = `[${type}_${counts[type]}]`;
    valueToToken.set(key, token);
    tokens[token] = value;
    return token;
  }

  intern.tokens = tokens;
  return intern;
}

function replaceAll(input, pattern, type, intern) {
  return input.replace(pattern, (match) => intern(type, match));
}

function replaceCapture(input, pattern, type, intern) {
  return input.replace(pattern, (full, amount) => {
    const token = intern(type, amount);
    const at = full.lastIndexOf(amount);
    return `${full.slice(0, at)}${token}${full.slice(at + amount.length)}`;
  });
}

function phonePattern() {
  return /(?:\+1[-.\s]*)?(?:\(?\d{3}\)?[-.\s]*)\d{3}[-.\s]*\d{4}\b/g;
}

// Standalone 8+ digit runs. Must not match CC-4100, W-4471, M-315.
function accountPattern() {
  return /(?<![A-Za-z]-)\b\d{8,}\b/g;
}

function salaryPhrasePattern() {
  const amount =
    "\\$?\\d{1,3}(?:,\\d{3})+(?:\\.\\d{2})?|\\$?\\d+(?:\\.\\d+)?[kK]|\\d+(?:\\.\\d+)?%|\\d{5,}";
  return new RegExp(
    `\\b(?:compensation|comp|salary|base|bonus)\\s+(?:of\\s+|to\\s+)?(${amount})`,
    "gi"
  );
}

function currencyPattern() {
  return /\$\s*\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\$\s*\d+(?:\.\d+)?[kK]\b|\bUSD\s+\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\bUSD\s+\d+[kK]\b|\d{1,3}(?:,\d{3})+(?:\.\d{2})?\s+USD\b|\d+[kK]\s+USD\b|\$\s*\d{4,}(?:\.\d{2})?/g;
}
