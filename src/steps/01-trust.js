const ALLOWED_SOURCES = new Set(["slack", "email", "doc", "manual"]);

/**
 * Authorize an envelope from metadata only.
 *
 * Envelope metadata (sender, source, received_at) is trusted for
 * authorization. The payload text is trusted for nothing: this function
 * never reads envelope.text, never calls a model, and never regex-scans
 * or otherwise inspects the message body.
 */
export function checkTrust(envelope, { authorizedSubmitters } = {}) {
  const sender = envelope.sender;
  const source = envelope.source;
  const receivedAt = envelope.received_at;

  if (typeof sender !== "string" || sender.trim() === "") {
    return { ok: false, reason: "missing_sender" };
  }

  const senderKey = sender.trim().toLowerCase();
  const authorized = Array.isArray(authorizedSubmitters)
    ? authorizedSubmitters.find(
        (entry) =>
          entry &&
          typeof entry.email === "string" &&
          entry.email.trim().toLowerCase() === senderKey
      )
    : undefined;
  if (!authorized || authorized.can_submit === false) {
    return { ok: false, reason: "sender_not_authorized" };
  }

  if (!ALLOWED_SOURCES.has(source)) {
    return { ok: false, reason: "unknown_source" };
  }

  if (!isValidIsoDate(receivedAt)) {
    return { ok: false, reason: "malformed_timestamp" };
  }

  return { ok: true, submitter: authorized };
}

function isValidIsoDate(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  if (Number.isNaN(Date.parse(value))) {
    return false;
  }
  return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(
    value
  );
}
