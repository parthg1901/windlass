"""Expected stock: the opening balance plus the day's movements."""

from collections import defaultdict

SIGNS = {"receipt": 1, "sale": -1, "return": -1}


def expected_on_hand(opening: dict[str, int], movements: list[dict]) -> dict[str, int]:
    on_hand: dict[str, int] = defaultdict(int, opening)
    for movement in movements:
        kind = movement["kind"]
        qty = int(movement["qty"])
        if kind == "adjustment":
            on_hand[movement["sku"]] += qty
        elif kind in SIGNS:
            on_hand[movement["sku"]] += SIGNS[kind] * qty
        else:
            raise ValueError(f"unknown movement kind {kind!r}")
    return dict(on_hand)
