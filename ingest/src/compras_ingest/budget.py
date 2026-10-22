"""Daily request budget (S-06): every HTTP attempt takes one unit."""


class BudgetExhausted(Exception):
    pass


class RequestBudget:
    def __init__(self, limit: int):
        self.limit = limit
        self.used = 0

    @property
    def remaining(self) -> int:
        return self.limit - self.used

    def take(self) -> None:
        if self.used >= self.limit:
            raise BudgetExhausted(f"request budget of {self.limit} reached")
        self.used += 1
