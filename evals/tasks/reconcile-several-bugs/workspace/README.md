# inventory

Nightly stock reconciliation. It pulls the day's stock movements from the warehouse API (paginated), works out what
should be on hand per SKU, compares that with the warehouse's physical count and values the stock.

    python3 -m inventory.reconcile <fixture-dir>

A fixture directory holds what the API and the warehouse would return: `pages/` (the first page is `page-1.json`;
each page names the next one, or `null`), `opening.csv` (on hand at the start of the day), `counts.csv` (the
evening count) and `costs.csv` (unit cost per SKU).

Movement kinds: `receipt` (goods in from a supplier), `sale` (goods out to a customer), `return` (a customer sends
goods back, so they are on hand again) and `adjustment` (a signed correction).

Valuation: for each SKU, the expected on-hand quantity times its unit cost, rounded half up to the cent; the total is
the sum of those.

    python3 -m unittest discover tests
