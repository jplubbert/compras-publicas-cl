"""Prints a jest-style count line ("Tests: F failed, P passed, T total") that scripts/record_evidence.py can parse."""


def pytest_terminal_summary(terminalreporter):
    stats = terminalreporter.stats
    passed = len(stats.get("passed", []))
    failed = len(stats.get("failed", [])) + len(stats.get("error", []))
    total = passed + failed + len(stats.get("skipped", []))
    terminalreporter.write_line(f"Tests: {failed} failed, {passed} passed, {total} total")
