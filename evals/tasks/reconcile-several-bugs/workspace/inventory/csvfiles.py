import csv
from pathlib import Path


def read_quantities(path: Path) -> dict[str, int]:
    with open(path, newline="") as handle:
        return {row["sku"]: int(row["qty"]) for row in csv.DictReader(handle)}


def read_costs(path: Path) -> dict[str, str]:
    with open(path, newline="") as handle:
        return {row["sku"]: row["unit_cost"] for row in csv.DictReader(handle)}
