"""python3 -m inventory.reconcile <fixture-dir>: the reconciliation report."""

import sys
from pathlib import Path

from .api import WarehouseApi
from .csvfiles import read_costs, read_quantities
from .ledger import expected_on_hand
from .money import valuation


def report(root: Path) -> str:
    opening = read_quantities(root / "opening.csv")
    counted = read_quantities(root / "counts.csv")
    costs = read_costs(root / "costs.csv")
    on_hand = expected_on_hand(opening, WarehouseApi(root).movements())
    lines = [f"{'SKU':<10}{'EXPECTED':>9}{'COUNTED':>9}{'DIFF':>7}"]
    mismatches = 0
    for sku in sorted(set(on_hand) | set(counted)):
        expected = on_hand.get(sku, 0)
        count = counted.get(sku, 0)
        diff = count - expected
        mismatches += diff != 0
        lines.append(f"{sku:<10}{expected:>9}{count:>9}{diff:>+7}")
    lines.append(f"mismatches: {mismatches}")
    lines.append(f"valuation: {valuation(on_hand, costs)}")
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    sys.stdout.write(report(Path(argv[0])))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
