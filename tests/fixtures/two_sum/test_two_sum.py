"""Stdlib unittest — no pytest dependency."""

import unittest

from solution import two_sum


class TestTwoSum(unittest.TestCase):
    def test_basic_pair(self):
        self.assertEqual(two_sum([2, 7, 11, 15], 9), [0, 1])

    def test_second_index_order(self):
        self.assertEqual(two_sum([3, 2, 4], 6), [1, 2])

    def test_negative_numbers(self):
        self.assertEqual(two_sum([-1, -2, -3, -4, -5], -8), [2, 4])


if __name__ == "__main__":
    unittest.main()
