"""A stand-in for the warehouse API: reads the pages a fixture directory holds."""

import json
from pathlib import Path


class WarehouseApi:
    def __init__(self, root: Path):
        self.root = Path(root)

    def _page(self, name: str) -> dict:
        return json.loads((self.root / "pages" / name).read_text())

    def movements(self) -> list[dict]:
        """Every movement of the day, in the order the API returns them, across all pages."""
        items: list[dict] = []
        page = self._page("page-1.json")
        while page["next"]:
            items.extend(page["items"])
            page = self._page(page["next"])
        return items
