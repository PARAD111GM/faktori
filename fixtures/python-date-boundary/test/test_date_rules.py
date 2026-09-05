from datetime import date
from src.date_rules import is_overdue


def test_boundary_today_is_not_overdue():
    today = date(2026, 9, 4)
    assert not is_overdue(today, today)


def test_yesterday_is_overdue_and_tomorrow_is_not():
    today = date(2026, 9, 4)
    assert is_overdue(date(2026, 9, 3), today)
    assert not is_overdue(date(2026, 9, 5), today)


def test_missing_due_date_is_not_overdue():
    assert not is_overdue(None, date(2026, 9, 4))
