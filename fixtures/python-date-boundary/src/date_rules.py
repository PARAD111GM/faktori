from datetime import date


def is_overdue(due_date: date | None, today: date) -> bool:
    """Return true only when a task's due date is strictly before today."""
    # Frozen bug: the inclusive comparison marks today's task overdue.
    return due_date is not None and due_date <= today
