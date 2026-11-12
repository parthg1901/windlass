"""Writes data/ for local runs: the anonymised copy of a nightly export, rebuilt from a fixed seed."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from validate import checksum  # noqa: E402

state = 20261112


def rand(n: int) -> int:
    global state
    state = (state * 1103515245 + 12345) % 2**31
    return state % n


# The kinds of damage seen in real exports, sprinkled at random.
KINDS = ["checksum", "negative", "pallet", "no-location", "sku", "tmp", "location", "text-qty"]
PREFIXES = ["BLT", "NUT", "WSH", "SCR", "PIN", "OLD"]

def write(out: Path, label: str, count: int) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for number in range(1, count + 1):
        fault = KINDS[rand(len(KINDS))] if rand(100) < 20 else None
        prefix = "TMP" if fault == "tmp" else PREFIXES[rand(len(PREFIXES))]
        sku = f"{prefix}-{rand(10000):04d}"
        qty = 501 + rand(400) if fault == "pallet" else rand(500)
        record = {"id": f"{label}-{number:04d}", "sku": sku, "qty": qty, "checksum": checksum(sku, qty), "location": f"{'ABCDEFGH'[rand(8)]}{rand(100):02d}"}
        if fault == "checksum":
            record["checksum"] = (record["checksum"] + 1 + rand(90)) % 97
        elif fault == "negative":
            record["qty"] = -record["qty"] - 1
        elif fault == "no-location":
            del record["location"]
        elif fault == "sku":
            record["sku"] = sku.lower()
        elif fault == "location":
            record["location"] = "Z" + record["location"][1:]
        elif fault == "text-qty":
            record["qty"] = str(qty)
        (out / f"{record['id']}.json").write_text(json.dumps(record, indent=2) + "\n")


write(Path("data"), "R", 60)
write(Path("data/late"), "L", 24)
