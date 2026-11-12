"""Stock valuation."""


def valuation(on_hand: dict[str, int], costs: dict[str, str]) -> str:
    """The value of the stock, as a string with two decimals."""
    total = 0.0
    for sku, qty in on_hand.items():
        total += qty * float(costs[sku])
    return f"{round(total, 2):.2f}"
