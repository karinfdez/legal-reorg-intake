export function redact(text) {
  return { redacted: text, tokens: [] }; // TODO: strip secrets / PII; record replacement tokens
}
