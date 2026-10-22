#!/usr/bin/env python3
"""Port record_evidence (DEC-014, DEC-013, DEC-017): evidence and status come from the real output of a task's verify,
never from an agent. Standard library only.

  python3 scripts/record_evidence.py [--root DIR] [--task T-NN]
      runs the verify of the task (default: the only one in_progress in spec/TASKS.json), keeps its raw stdout+stderr
      in artifacts/<ID>/verify.log, counts passed/failed/total from it and writes to the task, atomically:
      evidence {command, exit_code, passed, failed, total, log_path, log_sha256, commit, timestamp, result} and status
      verified_auto, or implemented if exit_code != 0 or failed > 0 (never done).
  ... --batch T-NN,T-MM,…
      one run of the verify the tasks share (a batch's full suite, run once before its last commit) is the evidence of
      every task of the batch: the same log (artifacts/batch-<ids>/verify.log), sha256 and commit in each, with
      "batch": the ids, and each status from it (T-57); with --keep-status (the close of a batch branch, DEC-033)
      a pass leaves each status as it is and a failure leaves them implemented
  ... --report-only --log-dir DIR
      the same run, but the log goes to DIR/verify.log and the evidence to DIR/evidence.json (and stdout); spec/ and
      artifacts/ are not touched (the Stop hook of an agent session, and reverification).
  ... --check REPORT
      does the log a report points to still have its sha256 and its counts? (an altered log or report fails)
  ... --tasks FILE        read the task's verify from another TASKS.json (reverification in a worktree, T-32)
  ... --command CMD --report-only --log-dir DIR
                          the same run for a command with no task (a repository's full suite)
  ... --task T-NN --integration --approved-by NAME
      runs the task's verify_integration (what the project declares as integration, DEC-019) only with the user's
      explicit approval; its
      log goes to artifacts/<ID>/integration.log and its result to evidence.integration; the status does not change
  ... --task T-NN --at COMMIT
      runs the verify in COMMIT (a temporary worktree) instead of the working tree: the first commit where a task whose
      own commit was not self-consistent passes (DEC-020); evidence.commit stays the task's, evidence.verified_at_commit
      is COMMIT
  ... --mark T-NN --verdict coincide|pasa_comando_nuevo|mismatch|no_reproducible|skipped_cost --report PATH [--reason TEXT]
      records a reverification verdict in the task's evidence (evidence.reverification); mismatch also leaves the
      task blocked by evidence_mismatch, no_reproducible marks the evidence unverified (Q-02: a mark, not a status)

Exit: 0 verified; 2 verify failed or a test failed (status implemented); 3 cannot record (no task, no verify, an
output it cannot count); 1 --check found a mismatch.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

# node:test ("ℹ tests 55"), vitest ("Tests  2 failed | 145 passed (147)") and jest ("Tests: 1 failed, 172 passed,
# 173 total"). Several runs in one verify add up.
NODE_RE = re.compile(r"^ℹ (tests|pass|fail) (\d+)\s*$", re.M)
VITEST_RE = re.compile(r"^\s*Tests\s+(?:(\d+) failed \| )?(?:(\d+) passed)?.*?\((\d+)\)\s*$", re.M)
JEST_RE = re.compile(r"^Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:(\d+) passed, )?(\d+) total\s*$", re.M)
# Terminal colors (CSI and OSC sequences): a colored summary must count the same as a plain one (T-85).
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


def counts(log):
    """(passed, failed, total) summed over every recognized summary, or None."""
    log = ANSI_RE.sub("", log)
    found = False
    passed = failed = total = 0
    node = {}
    for kind, n in NODE_RE.findall(log):
        node.setdefault(kind, []).append(int(n))
    if node.get("tests"):
        found = True
        total += sum(node["tests"])
        passed += sum(node.get("pass", []))
        failed += sum(node.get("fail", []))
    for f, p, t in VITEST_RE.findall(log):
        found = True
        failed += int(f or 0)
        passed += int(p or 0)
        total += int(t)
    for f, p, t in JEST_RE.findall(log):
        found = True
        failed += int(f or 0)
        passed += int(p or 0)
        total += int(t)
    return (passed, failed, total) if found else None


def sha256(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def set_status(task, to, reason):
    """DEC-028: every status change leaves its status_log entry; record_evidence.py is one of the scripts that write it."""
    if task.get("status") == to:
        return
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    task["status_log"] = list(task.get("status_log") or []) + [
        {"from": task.get("status"), "to": to, "by": "record_evidence.py", "at": now, "reason": reason}]
    task["status"] = to


def fail(msg, code=3):
    sys.stderr.write(f"record_evidence: {msg}\n")
    sys.exit(code)


def write_atomic(path, text):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-", suffix=os.path.basename(path))
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def check(report_path):
    with open(report_path, encoding="utf-8") as fh:
        r = json.load(fh)
    log = r.get("log_path", "")
    if not os.path.isfile(log):
        fail(f"the log {log} of {report_path} does not exist", 1)
    if sha256(log) != r.get("log_sha256"):
        fail(f"the sha256 of {log} does not match the report {report_path}", 1)
    with open(log, encoding="utf-8", errors="replace") as fh:
        c = counts(fh.read())
    if c != (r.get("passed"), r.get("failed"), r.get("total")):
        fail(f"the counts in {log} ({c}) do not match the report {report_path}", 1)
    return 0


# coincide: same command and same counts as the declared evidence; pasa_comando_nuevo: the current verify is another
# command and only passing or failing could be compared (DEC-020)
VERDICTS = ["coincide", "pasa_comando_nuevo", "mismatch", "no_reproducible", "skipped_cost"]


def mark(tasks_path, tid, verdict, report, reason):
    if verdict not in VERDICTS:
        fail(f"--verdict must be one of {', '.join(VERDICTS)}")
    with open(tasks_path, encoding="utf-8") as fh:
        data = json.load(fh)
    task = next((t for t in data["tasks"] if t.get("id") == tid), None)
    if task is None or not isinstance(task.get("evidence"), dict):
        fail(f"{tid} does not exist or has no evidence to mark")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    task["evidence"]["reverification"] = {"verdict": verdict, "date": now, "report": report, **({"reason": reason} if reason else {})}
    if verdict in ("coincide", "pasa_comando_nuevo"):
        task["evidence"].pop("unverified", None)
    if verdict == "no_reproducible":
        task["evidence"]["unverified"] = {"reason": reason or "no se pudo reproducir", "date": now, "report": report}
    if verdict == "mismatch":
        set_status(task, "blocked", "reverificación: mismatch")
        task["blocked_by"] = "evidence_mismatch"
    write_atomic(tasks_path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap.add_argument("--task")
    ap.add_argument("--report-only", action="store_true")
    ap.add_argument("--log-dir")
    ap.add_argument("--check")
    ap.add_argument("--timeout", type=int, default=0)
    ap.add_argument("--tasks")
    ap.add_argument("--command")
    ap.add_argument("--mark")
    ap.add_argument("--verdict")
    ap.add_argument("--report", default="")
    ap.add_argument("--reason", default="")
    ap.add_argument("--integration", action="store_true")
    ap.add_argument("--approved-by", default="")
    ap.add_argument("--at")
    ap.add_argument("--batch")
    ap.add_argument("--keep-status", action="store_true")
    a = ap.parse_args()
    if a.check:
        return check(a.check)
    root = os.path.abspath(a.root)
    tasks_path = os.path.abspath(a.tasks) if a.tasks else os.path.join(root, "spec", "TASKS.json")
    if a.mark:
        return mark(tasks_path, a.mark, a.verdict, a.report, a.reason)
    with open(tasks_path, encoding="utf-8") as fh:
        data = json.load(fh)
    if a.command is not None:
        if not a.report_only:
            fail("--command needs --report-only (it has no task to write to)")
        task = {"id": "suite", "verify": a.command}
    elif a.batch is not None:
        if a.task or a.report_only or a.integration or a.at:
            fail("--batch goes alone: no --task, --report-only, --integration or --at")
        ids = [x.strip() for x in a.batch.split(",") if x.strip()]
        if not ids:
            fail("--batch needs the ids of its tasks (T-NN,T-MM,…)")
        batch = []
        for bid in ids:
            t = next((t for t in data["tasks"] if t.get("id") == bid), None)
            if t is None:
                fail(f"{bid} does not exist in spec/TASKS.json")
            batch.append(t)
        if len({t.get("verify") for t in batch}) != 1:
            fail("the tasks of a batch must share one verify: " + "; ".join(f"{t['id']}: {t.get('verify')!r}" for t in batch))
        task = {"id": "batch-" + "_".join(ids), "verify": batch[0].get("verify")}
    elif a.task:
        task = next((t for t in data["tasks"] if t.get("id") == a.task), None)
        if task is None:
            fail(f"{a.task} does not exist in spec/TASKS.json")
    else:
        active = [t for t in data["tasks"] if t.get("status") == "in_progress"]
        if not active:
            fail("no task is in_progress (or pass --task)")
        if len(active) > 1:
            fail(f"more than one task is in_progress ({', '.join(t['id'] for t in active)}); pass --task")
        task = active[0]
    tid = task["id"]
    if a.integration:
        if not a.approved_by.strip():
            fail("--integration runs the task's verify_integration: it needs --approved-by NAME (the user's explicit approval, DEC-019)")
        command = task.get("verify_integration")
        if not isinstance(command, str) or not command.strip():
            fail(f"{tid} has no verify_integration")
    else:
        command = task.get("verify")
        if not isinstance(command, str) or not command.strip():
            fail(f"{tid} has no verify")
    if a.report_only:
        if not a.log_dir:
            fail("--report-only needs --log-dir")
        log_dir = os.path.abspath(a.log_dir)
    else:
        log_dir = os.path.join(root, "artifacts", tid)
    os.makedirs(log_dir, exist_ok=True)
    log_file = os.path.join(log_dir, "integration.log" if a.integration else "verify.log")
    run_dir, worktree = root, None
    if a.at:
        worktree = tempfile.mkdtemp(prefix=f"record-evidence-{tid}-")
        os.rmdir(worktree)
        if subprocess.run(["git", "-C", root, "worktree", "add", "--detach", "-q", worktree, a.at]).returncode != 0:
            fail(f"cannot check out {a.at} in a worktree")
        run_dir = worktree
    try:
        # Without colors, whatever the caller's terminal (T-85): the same verify must print the same summary everywhere.
        env = {k: v for k, v in os.environ.items() if k != "FORCE_COLOR"}
        env["NO_COLOR"] = "1"
        proc = subprocess.run(["bash", "-c", command], cwd=run_dir, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              stdin=subprocess.DEVNULL, timeout=a.timeout or None, env=env)
        out, code = proc.stdout, proc.returncode
    except subprocess.TimeoutExpired as e:
        out, code = (e.stdout or b"") + b"\nrecord_evidence: verify timed out\n", 124
    finally:
        if worktree:
            subprocess.run(["git", "-C", root, "worktree", "remove", "--force", worktree], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(log_file, "wb") as fh:
        fh.write(out)
    c = counts(out.decode("utf-8", errors="replace"))
    if c is None:
        fail(f"cannot parse a test count (passed/failed/total) from the output of {tid}'s verify; see {log_file}")
    passed, failed, total = c
    commit = subprocess.run(["git", "-C", root, "rev-parse", a.at or "HEAD"], stdout=subprocess.PIPE, text=True).stdout.strip()
    rel = os.path.relpath(log_file, root) if not a.report_only else log_file
    evidence = {
        "command": command, "exit_code": code, "passed": passed, "failed": failed, "total": total,
        "log_path": rel, "log_sha256": sha256(log_file), "commit": commit,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        # the one sentence spec/ shows; written from the counts above, in Spanish like the rest of spec/
        "result": f"{passed}/{total} pasan, {failed} fallan (código {code}; registrado por record_evidence.py desde {rel})",
    }
    if a.at:
        # the task's own commit stays as declared; the evidence says where it was actually verified (DEC-020)
        old = task.get("evidence") if isinstance(task.get("evidence"), dict) else {}
        evidence["verified_at_commit"] = commit
        evidence["commit"] = old.get("commit") or commit
    ok = code == 0 and failed == 0
    if a.integration and not a.report_only:
        evidence["approved_by"] = a.approved_by.strip()
        if not isinstance(task.get("evidence"), dict):
            task["evidence"] = {}
        task["evidence"]["integration"] = evidence   # never changes the status: it does not block the local close
        if ok:
            task["evidence"].pop("unverified", None)  # verified, with the user's approval, where it can be verified
        write_atomic(tasks_path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        if not ok:
            sys.stderr.write(f"record_evidence: {tid}: verify_integration failed (exit {code}); log: {log_file}\n")
        return 0 if ok else 2
    if a.report_only:
        write_atomic(os.path.join(log_dir, "evidence.json"), json.dumps(evidence, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(evidence, ensure_ascii=False))
    else:
        # evidence is overwritten whole: what the implementer declares (e.g. manual_pending) lives in "claims" (T-34)
        for t in batch if a.batch is not None else [task]:
            t["evidence"] = {**evidence, "batch": ids} if a.batch is not None else evidence
            if not (a.keep_status and ok):   # the close of a batch branch keeps a passing task's status (DEC-033)
                set_status(t, "verified_auto" if ok else "implemented", f"verify con código {code}: {passed}/{total} pasan, {failed} fallan")
            t["blocked_by"] = None   # a status written from facts leaves any block behind
        write_atomic(tasks_path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    if not ok:
        sys.stderr.write(f"record_evidence: {tid}: verify failed (exit {code}, {failed} of {total} failing); "
                         f"status {'implemented' if not a.report_only else 'unchanged (report only)'}; log: {log_file}\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
