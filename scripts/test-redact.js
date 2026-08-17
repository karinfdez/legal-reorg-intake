import { redact } from "../src/steps/02-redact.js";

let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

const protectedSample =
  "Please move the Platform Analytics team of 6 from Jordan Hale to Maya Chen, effective October 1 (2026-10-01). They are moving from CC-4100 to CC-4200. Worker W-4471 reports to M-315. Headcount 20 to 14.";

{
  const original = protectedSample;
  const { redacted, tokens } = redact(original);
  check("input is not mutated", original === protectedSample, original);
  for (const fragment of [
    "CC-4100",
    "CC-4200",
    "team of 6",
    "October 1",
    "W-4471",
    "Jordan Hale",
    "Platform Analytics",
    "Maya Chen",
    "M-315",
    "2026-10-01",
    "20 to 14",
  ]) {
    check(`${JSON.stringify(fragment)} survives`, redacted.includes(fragment), redacted);
  }
  check("no tokens for protected fields", Object.keys(tokens).length === 0, JSON.stringify(tokens));
}

{
  const { redacted, tokens } = redact("Compensation is $195,000 this year.");
  const salaryTokens = Object.keys(tokens).filter((key) => key.startsWith("[SALARY_"));
  check("$195,000 becomes a [SALARY_n] token", salaryTokens.length === 1, redacted);
  check(
    "$195,000 is stored in the reverse map",
    salaryTokens.length === 1 && tokens[salaryTokens[0]] === "$195,000",
    JSON.stringify(tokens)
  );
  check("redacted text no longer contains $195,000", !redacted.includes("$195,000"), redacted);
}

{
  const { redacted, tokens } = redact(
    "Also $195k, USD 195,000, and 195,000 USD."
  );
  check("$195k redacted", Object.values(tokens).includes("$195k"), JSON.stringify(tokens));
  check("USD 195,000 redacted", Object.values(tokens).includes("USD 195,000"), JSON.stringify(tokens));
  check("195,000 USD redacted", Object.values(tokens).includes("195,000 USD"), JSON.stringify(tokens));
  check("currency forms removed from text", !/\$195k|USD 195,000|195,000 USD/.test(redacted), redacted);
}

{
  const { tokens } = redact(
    "Notes: comp of 195000, base 210k, salary to 220,000, bonus 15%."
  );
  check("comp of 195000 redacted", Object.values(tokens).includes("195000"), JSON.stringify(tokens));
  check("base 210k redacted", Object.values(tokens).includes("210k"), JSON.stringify(tokens));
  check("salary to 220,000 redacted", Object.values(tokens).includes("220,000"), JSON.stringify(tokens));
  check("bonus 15% redacted", Object.values(tokens).includes("15%"), JSON.stringify(tokens));
}

{
  const { redacted, tokens } = redact("SSN 123-45-6789 is on file.");
  check("123-45-6789 becomes [SSN_1]", tokens["[SSN_1]"] === "123-45-6789", JSON.stringify(tokens));
  check(
    "SSN is not an account token",
    !Object.keys(tokens).some((key) => key.startsWith("[ACCOUNT_")),
    JSON.stringify(tokens)
  );
  check("redacted text uses [SSN_1]", redacted.includes("[SSN_1]"), redacted);
}

{
  const { redacted, tokens } = redact("Pay $195,000 now and still $195,000 later.");
  const salaryTokens = Object.keys(tokens).filter((key) => key.startsWith("[SALARY_"));
  const occurrences = redacted.match(/\[SALARY_\d+\]/g) ?? [];
  check("same salary figure twice yields one token", salaryTokens.length === 1, JSON.stringify(tokens));
  check("that token is reused twice in the text", occurrences.length === 2, redacted);
}

{
  const { redacted, tokens } = redact(
    "Reach me at a@b.co or 555-123-4567. Acct 12345678."
  );
  check("email redacted", Object.values(tokens).includes("a@b.co"), JSON.stringify(tokens));
  check("phone redacted", Object.values(tokens).includes("555-123-4567"), JSON.stringify(tokens));
  check("account redacted", Object.values(tokens).includes("12345678"), JSON.stringify(tokens));
  check("email removed from text", !redacted.includes("a@b.co"), redacted);
  check("phone removed from text", !redacted.includes("555-123-4567"), redacted);
  check("account removed from text", !redacted.includes("12345678"), redacted);
}

if (failed > 0) {
  console.log(`\n${failed} failed`);
  process.exitCode = 1;
} else {
  console.log("\nall checks passed");
}
