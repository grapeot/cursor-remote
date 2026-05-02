def two_sum(nums: list[int], target: int) -> list[int]:
    lookup: dict[int, int] = {}
    for i, num in enumerate(nums):
        complement = target - num
        if complement in lookup:
            return [lookup[complement], i]
        lookup[num] = i
    raise ValueError("No pair satisfies the constraint")
