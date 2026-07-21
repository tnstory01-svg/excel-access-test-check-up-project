#!/usr/bin/env python3
"""Validate the source-only Gate 0A oracle contract; this does not execute POI."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FORMATS = ("xlsx", "xlsm", "xls")
CAPABILITIES = (
    "excel.cell.value.v1",
    "excel.cell.formula.stored.v1",
    "excel.style.number-format.v1",
    "excel.style.font.v1",
    "excel.style.fill.v1",
    "excel.style.border.v1",
    "excel.style.alignment.v1",
)
REQUIRED_KINDS = {"positive", "boundary", "negative"}


def load(name):
    with (ROOT / name).open(encoding="utf-8") as fixture:
        return json.load(fixture)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    formula = load("formula-collision-v1.json")
    gate = load("gate-0a-capabilities-v1.json")
    cases = {case["id"]: case for case in formula["cases"]}

    require(formula["fixtureId"] == "formula-collision-v1", "wrong formula fixture ID")
    require(REQUIRED_KINDS <= {case["kind"] for case in cases.values()}, "formula fixture lacks required case kinds")
    for case in cases.values():
        require(case["formula"].startswith("="), f"{case['id']} lacks leading =")
        require(case["tokens"], f"{case['id']} lacks oracle tokens")

    for collision_set in formula["collisionSets"]:
        formulas = [cases[case_id]["formula"] for case_id in collision_set]
        require(len(formulas) == len(set(formulas)), f"collision set collapses: {collision_set}")
    intersection = cases["intersection-positive"]
    union = cases["union-boundary"]
    ambiguous = cases["whitespace-removal-negative"]
    require("SPACE_INTERSECTION" in intersection["tokens"], "intersection token is not preserved")
    require("COMMA_UNION" in union["tokens"], "union token is not preserved")
    require(ambiguous.get("expectedDisposition") == "unsupported", "ambiguous formula must fail closed")

    require(tuple(gate["formats"]) == FORMATS, "wrong format coverage")
    require(tuple(gate["capabilities"]) == CAPABILITIES, "wrong Gate 0A capability coverage")
    require(set(gate["requiredFixtureKinds"]) == REQUIRED_KINDS, "wrong fixture-kind contract")
    require(gate["status"] == "blocked", "source-only probe must remain blocked")
    require(gate["formulaOracle"] == "formula-collision-v1.json", "wrong formula oracle link")
    expected_pairs = {(fmt, capability) for fmt in FORMATS for capability in CAPABILITIES}
    actual_pairs = {(row["format"], row["capability"]) for row in gate["matrix"]}
    require(actual_pairs == expected_pairs, "matrix must contain every format/capability pair exactly once")
    require(len(gate["matrix"]) == len(expected_pairs), "matrix has duplicate entries")
    require(all(row["status"] == "blocked" for row in gate["matrix"]), "unproven capability marked supported")

    print(json.dumps({
        "gate": "0A",
        "terminal": "COMPLETE",
        "probeStatus": "blocked",
        "provenCapabilities": [],
        "blockedCapabilities": list(CAPABILITIES),
        "checkedFormatCapabilityPairs": len(expected_pairs),
        "formulaCollisionContract": "valid",
        "limitation": gate["reason"],
    }, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f"Gate 0A contract check failed: {error}", file=sys.stderr)
        sys.exit(1)
