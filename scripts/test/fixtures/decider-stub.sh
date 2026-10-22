#!/usr/bin/env bash
# Decider double for the scripts/autopilot.sh tests (port decide, DEC-015). It reads the question on stdin and, by
# default, answers what the LLM output in its state already says, with high confidence, so the existing behavior holds:
# research_action ← "Acción sugerida" and "Confianza" of the report (alta 0.95, media 0.85, baja 0.5); review_verdict
# and acceptance_verdict ← the reviewer's "verdict"; plan_verdict ← the critic's "verdict"; failure_cause ←
# implementation; finding_severity ← blocking (it is asked only about the critic's blocking findings).
# STUB_DECIDE_<ID>=answer:confidence overrides one
# (e.g. STUB_DECIDE_failure_cause=design:0.9); STUB_DECIDE_<ID>=error makes it fail. Each question goes to
# .autopilot/stub-decide-<ID>.json; what it sees of TYPESAFE_API_KEY to .autopilot/stub-decide-env.txt.
q=$(cat)
id=$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$q")
printf '%s' "$q" >".autopilot/stub-decide-$id.json"
echo "TYPESAFE_API_KEY=${TYPESAFE_API_KEY:-}" >.autopilot/stub-decide-env.txt   # the key reaches the decider
override_var="STUB_DECIDE_$id"
override=${!override_var:-}
if [ "$override" = error ]; then echo "stub decider: forced error" >&2; exit 1; fi
node -e '
  const [q, override] = process.argv.slice(1);
  const { id, state } = JSON.parse(q);
  const text = typeof state === "string" ? state : JSON.stringify(state);
  let answer, confidence = 0.95;
  if (override) { const [a, c] = override.split(":"); answer = a; confidence = Number(c); }
  else if (id === "research_action") {
    answer = (/Acción sugerida\s*:\s*(\w+)/.exec(text) ?? [])[1];
    confidence = { alta: 0.95, media: 0.85, baja: 0.5 }[(/Confianza\s*:\s*(\w+)/.exec(text) ?? [])[1]] ?? 0.95;
  } else if (id === "review_verdict" || id === "acceptance_verdict") answer = /"verdict"\s*:\s*"approved"/.test(text) ? "approved" : "rejected";
  else if (id === "plan_verdict") answer = (/"verdict"\s*:\s*"(APROBAR|REVISAR|ESCALAR)"/i.exec(text) ?? [])[1]?.toUpperCase() ?? "ESCALAR";
  else answer = { failure_cause: "implementation", finding_severity: "blocking" }[id];
  console.log(JSON.stringify({ answer, confidence }));' "$q" "$override"
