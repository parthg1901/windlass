"""Validate stock records.

    python3 tools/validate.py [--profile NAME] DIR

Exits 1 with the first invalid record, 0 when every record is valid.
"""

import json
import re
import sys
import tomllib
from pathlib import Path

SKU = re.compile(r"^[A-Z]{3}-\d{4}$")
LOCATION = re.compile(r"^[A-H]\d{2}$")
WEIGHTS = (7, 3, 1)


class Invalid(Exception):
    pass


def checksum(sku: str, qty: int) -> int:
    text = f"{sku}:{qty}"
    return sum(ord(char) * WEIGHTS[index % 3] for index, char in enumerate(text)) % 97


def load_profile(name: str) -> dict:
    profiles = tomllib.loads((Path(__file__).parent / "profiles.toml").read_text())
    profile = dict(profiles["default"])
    if name != "default":
        profile.update(profiles[name])
    return profile


def validate_record(record: dict, profile: dict) -> None:
    sku = record.get("sku")
    if not isinstance(sku, str) or not SKU.match(sku):
        raise Invalid(f"bad sku {sku!r}")
    qty = record.get("qty")
    if not isinstance(qty, int) or isinstance(qty, bool) or qty < 0:
        raise Invalid(f"bad qty {qty!r}")
    if qty > profile["max_qty"]:
        raise Invalid(f"qty {qty} over {profile['max_qty']}")
    if record.get("checksum") != checksum(sku, qty):
        raise Invalid("checksum mismatch")
    if any(sku.startswith(prefix) for prefix in profile["forbidden_prefixes"]):
        raise Invalid(f"sku {sku} has a forbidden prefix")
    if profile["require_location"]:
        location = record.get("location")
        if not isinstance(location, str) or not LOCATION.match(location):
            raise Invalid(f"bad location {location!r}")


def main(argv: list[str]) -> int:
    profile_name = "default"
    if argv[:1] == ["--profile"]:
        profile_name, argv = argv[1], argv[2:]
    if len(argv) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    profile = load_profile(profile_name)
    for path in sorted(Path(argv[0]).glob("*.json")):
        record = json.loads(path.read_text())
        try:
            validate_record(record, profile)
        except Invalid as error:
            print(f"{record.get('id', path.stem)}: {error}", file=sys.stderr)
            return 1
    print("all records valid")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
