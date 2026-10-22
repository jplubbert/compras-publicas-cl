# scripts/autopilot.sh configuration for compras-publicas-cl. The orchestrator loads it with `source` if it exists
# (or the path in AUTOPILOT_CONFIG). Everything is optional: without changes, the orchestrator uses autopilot.sh's
# defaults. Plain bash; don't put secrets here (this file is in git).

# Task the orchestrator commits its LOG.md summary with. With a "kind": "tooling" task (e.g. the one that
# built the orchestrator) the commits carry `Req: N/A`; with `none`, `Req: none`.
# AUTOPILOT_TASK=T-NN

# Text appended to the implementer's prompt: how to run the tests that need an environment, what not to do.
# AUTOPILOT_IMPL_PROMPT_EXTRA='Run `<comando>` (acceptance) without environment prefixes: the orchestrator already sets the credentials.'

# Extra implementer permissions and extra denials (`claude --allowedTools/--disallowedTools` syntax).
# Deny the deploy commands and the project's cloud or provider CLIs here.
# AUTOPILOT_IMPL_ALLOWED_EXTRA=("Bash(tsx *)")
# AUTOPILOT_IMPL_DENIED_EXTRA=("Bash(<comando de despliegue>*)" "Bash(<cli de la nube> *)")

# Read-only commands the reviewer may run, and how they're listed in its prompt.
# AUTOPILOT_REVIEW_ALLOWED_EXTRA=("Bash(npx vitest*)" "Bash(npx tsc*)")
# AUTOPILOT_REVIEW_COMMANDS='`npm test`, `npm run lint`, `npm run typecheck`, `node scripts/check-spec.mjs`'

# Command the user deploys with; it only appears in the summary's "Pendiente deploy" line.
# AUTOPILOT_DEPLOY_CMD='<comando de despliegue>'

# Push after review (DEC-004 point 1; off while AUTOPILOT_PUSH_REMOTE is empty). Once an approved verdict is committed
# (status reviewed), the orchestrator runs `git push <remote> HEAD:<branch>` without --force from its own environment;
# the implementer and the reviewer still cannot push. AUTOPILOT_PUSH_BRANCH defaults to the branch the run started on.
# A rejected push (not a fast-forward, network) undoes nothing: it is logged, there are no more pushes in the run and
# the notice asks for intervention.
# WARNING: do not enable it on a branch that deploys to production when it receives a push: what it pushes is
# reviewed, not accepted, so that push would be a production deploy.
# AUTOPILOT_PUSH_REMOTE=origin
# AUTOPILOT_PUSH_BRANCH=autopilot-reviewed

# Demo deploy (DEC-004 point 2; off while AUTOPILOT_DEMO_DEPLOY_CMD is empty). When the implementer leaves a task
# in_progress with "Pendiente deploy", the orchestrator, in a subshell of its own, runs autopilot_deploy_env and
# autopilot_deploy_identity; only if the printed identity is one of AUTOPILOT_DEMO_ACCOUNTS it runs the deploy command,
# then the post-deploy command (optional, e.g. acceptance against the demo), and relaunches the implementer on the same
# task with the result (exit codes and the last 40 lines of the post-deploy output) in its prompt. At most once per
# task and run. A missing hook, an empty or unlisted identity, or a failed deploy → "Pendiente deploy" for the user.
# The guard is the checked identity and the scoped role, not the word "demo": the hooks must give the credentials of a
# role that can only touch the demo account, never production ones. Don't print secrets in the commands' output: the
# post-deploy tail reaches the implementer. The implementer still cannot deploy: deny the commands above.
# AUTOPILOT_DEMO_DEPLOY_CMD='<comando de despliegue a la cuenta demo>'
# AUTOPILOT_DEMO_POSTDEPLOY_CMD='<comando posterior, p. ej. la aceptación contra la demo>'
# Credentials of the demo account's scoped role, exported (the commands run in `bash -c`). They only live in that
# subshell: they never reach the implementer or the reviewer.
# autopilot_deploy_env() {
#   export <VARIABLE>=<demo role credential>
# }
# Prints the effective identity, asked to the provider with those credentials (not taken from a variable).
# autopilot_deploy_identity() { <cli de la nube> <consulta de identidad>; }
# The allowed identities go in the local configuration (~/.config/autopilot/autopilot.config.sh, outside git), never
# here: `AUTOPILOT_DEMO_ACCOUNTS=("<identidad demo>")`.

# Reviewer approval of additive acceptance diffs (DEC-004 point 3; off unless AUTOPILOT_ACCEPTANCE_REVIEW=additive).
# When a "kind": "spec" task stays in_progress with commits (it waits for the user to approve its tests/acceptance/
# diff), the orchestrator checks with `git diff --raw`/`--numstat` that under tests/acceptance/ there are only new files
# or added lines (0 deleted lines; no deletion, rename or mode change) and that no test-runner configuration
# (AUTOPILOT_ACCEPTANCE_RUNNER_FILES) changed outside it. If so, the independent reviewer checks that every new test
# matches an example of a cited REQ and none is trivially true or skipped/focused; approved → the verdict goes to the
# task (acceptance_review) and the implementer is relaunched as if the user had approved (once per task and run).
# Not additive or rejected → it waits for the user. Any deletion or change of an existing test stays the user's.
# AUTOPILOT_ACCEPTANCE_REVIEW=additive
# The defaults cover common runners (package.json, jest/vitest/playwright/cypress configs, pytest.ini, pyproject.toml,
# conftest.py, Makefile, tsconfig*.json, .github/workflows/*, this file…). Globs without "/" match the file name
# anywhere; with "/", the whole path. Append the files your acceptance command depends on:
# AUTOPILOT_ACCEPTANCE_RUNNER_FILES+=('<archivo de configuración de la aceptación>')

# Researcher (DEC-005; off unless AUTOPILOT_RESEARCH=web or deep). On the second failure of the same task in a run
# (scope and authority violations excluded), the orchestrator, never the implementer, launches the researcher role's
# agent read-only with web access (deep also allows parallel sub-searches). It gets a concrete question, the task with its
# REQ/DEC, the diff and errors of the failed attempts and the run's log paths, and may only write research/<ID>.md
# (Causa probable, Evidencia, Fuentes, Recomendación, "Acción sugerida" and "Confianza"); any other change stops the
# run. The orchestrator commits the report and decides: reintentar → one more attempt with the report's path in the
# prompt; recortar → the split-off work becomes a new specified task; escalar, low confidence, an invalid report or an
# exceeded cap → the task is blocked by a new Q-NN in spec/SPEC.md for you. A researched retry that fails again is
# escalated. At most one research per task and run.
# AUTOPILOT_RESEARCH=web
# Hard caps per invocation: past either one it is cut off and the task is escalated. Time is also capped by what the
# run has left.
# AUTOPILOT_RESEARCH_WEB_SECONDS=900
# AUTOPILOT_RESEARCH_WEB_MAX_USD=2
# AUTOPILOT_RESEARCH_DEEP_SECONDS=2700
# AUTOPILOT_RESEARCH_DEEP_MAX_USD=10

# Test-author (DEC-006; off unless AUTOPILOT_TEST_AUTHOR=on). Before the implementer of a task with REQ that is
# neither spec nor tooling and has no tests/acceptance/<ID>* yet, the test-author role's agent writes them from
# spec/SPEC.md and spec/contracts/ only (it may read only spec/ and tests/acceptance/ and write only
# tests/acceptance/<ID>.*, <ID>-*, <ID>_* or <ID>/). The orchestrator runs AUTOPILOT_ACCEPTANCE_CMD <file> on each:
# all must fail (red), or the task goes to you. It commits them (Test-Author: autopilot) and the implementer starts
# only once they are approved: by the reviewer if AUTOPILOT_ACCEPTANCE_REVIEW=additive and the diff is additive,
# otherwise by you (node scripts/lib/autopilot-tasks.mjs approve-tests T-NN --by <name>). The implementer may read the
# tests but not touch them (the run stops); it may dispute one (blocked + test_dispute) and the researcher or you
# decide; its verified_auto/done result is applied only if they pass (green). Spec tasks keep working as today.
# AUTOPILOT_TEST_AUTHOR=on
# The acceptance command; it receives the path of one test file (e.g. "npx vitest run", "npx playwright test").
# AUTOPILOT_ACCEPTANCE_CMD='<comando de aceptación>'
# Conventions of your acceptance tests, for the test-author's prompt (framework, helpers, file naming).
# AUTOPILOT_TEST_AUTHOR_PROMPT_EXTRA='<convenciones>'

# Plan critique gate (DEC-010; off unless AUTOPILOT_PLAN_GATE=on). Before the implementer of every task that is not a
# spec task, the planner role's agent writes plans/<ID>.md (Objetivo, Pasos, Archivos, Supuestos, Riesgos,
# Verificación and nothing else; it reads the repository, no network) and the critic role's agent, with clean context
# (only spec/SPEC.md, spec/DECISIONS.md, spec/contracts/, the plan, research/<ID>* and the task's acceptance tests with
# their red output; never the planner's narrative), researches on the web the 3 to 5 riskiest assumptions and gives
# APROBAR, REVISAR or ESCALAR with findings P0-P3 backed by a source (URL), a file line or opinion. A P0/P1 with a source
# or a file line blocks; one that is only opinion does not, but you see it. REVISAR → the planner fixes it and the
# critic looks again with only the ids of its findings (at most 2 rounds; a repeated id or REVISAR after round 2 →
# escalated). It may ask the deep researcher up to 2 questions (deep caps below). The implementer starts only with
# APROBAR on the unchanged plan (plan_review in TASKS.json); the gate is enforced in bash, never by a hook.
# AUTOPILOT_PLAN_GATE=on
# Trace of every run (DEC-024): heartbeat period, and how long an agent may write nothing to live.log before it is cut
# (INT) and the run ends "stalled".
# AUTOPILOT_HEARTBEAT_SECONDS=30
# AUTOPILOT_STALL_SECONDS=1200

# Batch branch (DEC-033, on by default): runs integrate into this branch, never into the one they start on; when every
# task of the batch is reviewed and none is blocked, one full suite (record_evidence.py --batch) and you merge it.
# AUTOPILOT_BATCH=off
# AUTOPILOT_BATCH_BRANCH=autopilot/lote

# Queue policy (DEC-023, on by default): more than N tasks in verified_auto → the run only reviews; otherwise one review
# and one implementation. A review starts only if the time left covers its expected duration (median of the last 10).
# AUTOPILOT_QUEUE_POLICY=off
# AUTOPILOT_QUEUE_REVIEW_ONLY_ABOVE=4
# AUTOPILOT_REVIEW_EXPECTED_SECONDS=1200      # without history in .autopilot/
# AUTOPILOT_REVIEW_ONLY_BUDGET_SECONDS=28800  # --review-only

# With the gate on there is no start gate (DEC-022): when nothing is eligible, the orchestrator takes the first specified
# task (not spec, dependencies closed, its DECs accepted) to the critic and, with APROBAR, grants approved_for_impl itself;
# a task with a touch (or a tracked file under one) matching AUTOPILOT_SENSITIVE_GLOBS waits for you. Add your own zones:
# AUTOPILOT_SENSITIVE_GLOBS+=('*tenant*' 'src/billing/*')
# Caps per invocation: planner (seconds), critic (seconds and US$).
# AUTOPILOT_PLANNER_SECONDS=1200
# AUTOPILOT_CRITIC_SECONDS=1200
# AUTOPILOT_CRITIC_MAX_USD=3

# Coverage from acceptance (DEC-011): not configured here but in spec/COVERAGE.json (README, "Cobertura desde
# aceptación"). With it, a verified_auto/done result is applied only if every line the task added or changed is executed
# by an acceptance test citing a REQ; without it the repository is out of the rule and the summary keeps a task to
# enable it.

# What counts as integration in this project (DEC-019): an extended regular expression; a task's verify that matches it
# is rejected by check:spec (it goes to verify_integration, which runs only with the user's explicit approval) and the
# reverification never runs it. sdd-base knows no provider: each project declares its own (its cloud deploys, its
# acceptance against a deployed environment, a paid agent). sdd-base's own: the smoke tests against the real claude
# and the real decider. Keep it on one line, single-quoted: check:spec reads it without running this file.
AUTOPILOT_INTEGRATION_PATTERN='claude-smoke\.sh|jev-smoke\.sh|scripts/it/|terraform( -chdir=[^ ]+)? (plan|apply)|gcloud |bq |gsutil '

# Paths the access guard denies every agent besides its own private data (DEC-016), e.g. another agent's data that
# lives inside an allowed directory. Everything outside the task's worktree is denied anyway.
# AUTOPILOT_GUARD_DENY=(~/.otro-agente)

# Closed decisions of the loop (DEC-015) go to the decider scripts/agents/decider/<AUTOPILOT_DECIDER>.sh (jev by
# default), never to a generative LLM: the review verdict, the plan critique verdict and the severity of each of its
# blocking findings, the action after research and the cause of a failure. Under its threshold (0..1), with an error or no answer, the decision escalates to the user. The
# decider's key goes in ~/.config/autopilot/secrets.sh (`export TYPESAFE_API_KEY=…`; AUTOPILOT_SECRETS), never here;
# no agent receives it.
# Each decision is recorded in artifacts/decisions/<run>/.
# AUTOPILOT_DECIDER=jev
# AUTOPILOT_DECIDE_THRESHOLD_REVIEW_VERDICT=0.8
# AUTOPILOT_DECIDE_THRESHOLD_ACCEPTANCE_VERDICT=0.8
# AUTOPILOT_DECIDE_THRESHOLD_PLAN_VERDICT=0.8
# AUTOPILOT_DECIDE_THRESHOLD_FINDING_SEVERITY=0.8
# AUTOPILOT_DECIDE_THRESHOLD_RESEARCH_ACTION=0.8
# AUTOPILOT_DECIDE_THRESHOLD_FAILURE_CAUSE=0.8

# Agent of each role (DEC-008), through its adapter scripts/agents/<agent>.sh; claude by default. The run does not start
# if the agent of a role in use lacks an adapter, the role or a point of the isolation contract the role requires
# (new ephemeral session, prompt only on stdin, access to .autopilot/ and its private data prevented, auditable output,
# cost cap where needed). The extra permissions above are written in the syntax of the role's agent.
# AUTOPILOT_REVIEWER is deprecated: claude and auto mean claude; codex does not start (no codex adapter yet).
# The claude adapter passes every option explicitly and runs only the pinned Claude Code version. After a Claude Code
# update, run scripts/agents/claude-smoke.sh (in sdd-base) with the new version and, if it passes, move the pin:
# AUTOPILOT_CLAUDE_VERSION=2.1.295
# AUTOPILOT_IMPLEMENTER_AGENT=claude
# AUTOPILOT_REVIEWER_AGENT=claude
# AUTOPILOT_RESEARCHER_AGENT=claude
# AUTOPILOT_TEST_AUTHOR_AGENT=claude
# The critic is better from another model family than the planner, once another adapter exists (T-17):
# AUTOPILOT_PLANNER_AGENT=claude
# AUTOPILOT_CRITIC_AGENT=claude

# Monthly token cap (DEC-048): input + output + cache write the agents report (usage), summed over the calendar
# month in ${XDG_STATE_HOME:-~/.local/state}/autopilot/tokens.jsonl, shared by all the repositories of the machine;
# cache read does not count (it is reported apart). Once the month reaches the cap no agent is launched and the run
# stops with a high-priority notice. AUTOPILOT_MONTHLY_BUDGET_USD (DEC-009) is no longer used: set alone, no agent is
# launched until the cap is in tokens.
# AUTOPILOT_MONTHLY_BUDGET_TOKENS=50000000

# Hook: scopes the environment the agents and everything they launch inherit. Use it to give the tests a
# test identity with minimal permissions and remove any other credential (variables, profiles, files).
# Runs before any task, also in --dry-run.
# autopilot_env() {
#   unset <CREDENTIAL_VARIABLES>
#   export <VARIABLE>=<test value>
# }

# Hook: one line describing that environment in --dry-run (without printing secrets).
# autopilot_env_info() { echo "credentials: <test identity>"; }

# ntfy notice on stop: do NOT put NTFY_TOPIC here (it's a secret and this file is in git). It goes in the local
# configuration ~/.config/autopilot/autopilot.config.sh (or AUTOPILOT_LOCAL_CONFIG): `NTFY_TOPIC=<topic>`.

# --- compras-publicas-cl ---
AUTOPILOT_IMPL_PROMPT_EXTRA='Run scripts/setup.sh first if .tools/ is missing (it is the only step that uses the network). Never run scripts/it/, terraform plan/apply, gcloud, bq or gsutil: they touch GCP and only the user runs them.'
AUTOPILOT_IMPL_DENIED_EXTRA=("Bash(gcloud *)" "Bash(bq *)" "Bash(gsutil *)" "Bash(scripts/it/*)" "Bash(*terraform*apply*)" "Bash(*terraform*plan*)" "Bash(gh pr *)" "Bash(gh workflow run*)")
AUTOPILOT_REVIEW_ALLOWED_EXTRA=("Bash(npm run *)" "Bash(uv run pytest*)" "Bash(scripts/acceptance.sh *)")
AUTOPILOT_REVIEW_COMMANDS='`npm test`, `npm run lint`, `npm run check:repo`, `scripts/acceptance.sh <file>`, `node scripts/check-spec.mjs`'
AUTOPILOT_DEPLOY_CMD='merge to main (GitHub Actions applies infra/main); infra/bootstrap is applied by the user'
AUTOPILOT_PLAN_GATE=on
AUTOPILOT_RESEARCH=web
AUTOPILOT_TEST_AUTHOR=on
AUTOPILOT_ACCEPTANCE_CMD='scripts/acceptance.sh'
AUTOPILOT_TEST_AUTHOR_PROMPT_EXTRA='Local and offline only (DEC-005). Python: pytest (tests/acceptance/<ID>_*.py) with respx and in-memory fakes. Terraform: tests/acceptance/<ID>_*.tftest.hcl with mock_provider "google". Dataform and repo checks: node:test (tests/acceptance/<ID>_*.test.mjs) over `dataform compile --json` or the script output. One test per REQ example; examples marked "en ci" or "integración" are not written here.'
AUTOPILOT_ACCEPTANCE_RUNNER_FILES+=('scripts/acceptance.sh' 'pyproject.toml' 'uv.lock' 'dataform/package.json')
AUTOPILOT_SENSITIVE_GLOBS+=('infra/bootstrap/*' 'finops/*' '.github/workflows/*')
