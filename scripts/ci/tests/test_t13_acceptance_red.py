"""The REQ-013 acceptance file (tests/acceptance/T-13_benchmark.py) is red until T-13 writes benchmarks/ (Q-10).

It runs pytest on that file in a subprocess and requires exactly E1-E4 to be collected and each one to fail with a
ModuleNotFoundError of benchmarks/generate or benchmarks/report. Once T-13 creates both modules this test is skipped.
"""

import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
ACCEPTANCE = ROOT / "tests" / "acceptance" / "T-13_benchmark.py"
BENCHMARKS = ROOT / "benchmarks"
EXPECTED = {
    "test_req013_e1_generate_sql_is_deterministic_with_at_least_30m_rows": "generate",
    "test_req013_e2_table_with_billed_bytes_slot_ms_and_savings_base_at_zero": "report",
    "test_req013_e3_cache_hit_job_is_left_out_and_listed_under_excluidos": "report",
    "test_req013_e4_dry_run_column_is_labelled_as_upper_bound": "report",
}


def test_t13_acceptance_fails_only_because_benchmarks_modules_are_missing(tmp_path):
    if (BENCHMARKS / "generate.py").exists() and (BENCHMARKS / "report.py").exists():
        pytest.skip("benchmarks/generate.py and benchmarks/report.py exist: T-13 makes the acceptance file green")
    junit = tmp_path / "junit.xml"
    result = subprocess.run(
        [sys.executable, "-m", "pytest", str(ACCEPTANCE), "-p", "no:cacheprovider", f"--junitxml={junit}"],
        check=False,
        capture_output=True,
        text=True,
        cwd=tmp_path,
    )
    assert result.returncode == 1, result.stdout + result.stderr
    cases = {case.get("name"): case for case in ET.parse(junit).getroot().iter("testcase")}
    assert set(cases) == set(EXPECTED), result.stdout
    for name, module in EXPECTED.items():
        failure = cases[name].find("failure")
        assert failure is not None, f"{name} did not fail"
        detail = f"{failure.get('message', '')}\n{failure.text or ''}"
        assert f"ModuleNotFoundError: No module named '{module}'" in detail, f"{name}: {detail}"
