import unittest

from inventory.ledger import expected_on_hand


class LedgerTest(unittest.TestCase):
    def test_receipts_and_sales(self):
        movements = [
            {"sku": "A", "kind": "receipt", "qty": 5},
            {"sku": "A", "kind": "sale", "qty": 2},
            {"sku": "B", "kind": "adjustment", "qty": -1},
        ]
        self.assertEqual(expected_on_hand({"A": 1, "B": 4}, movements), {"A": 4, "B": 3})


if __name__ == "__main__":
    unittest.main()
