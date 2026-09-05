# Frozen fixture: Python date-boundary regression

The bug contract is precise: an overdue task has a due date strictly before
the injected current date. Today is not overdue, tomorrow is not overdue, and
no due date is not overdue. Keep the clock injected; do not use the host clock
in tests. Run `pytest -q`.

Envelope: 20 minutes, Luna-medium available (Terra-medium fallback), one human
clarification round of at most 5 minutes, no network or paid services.
