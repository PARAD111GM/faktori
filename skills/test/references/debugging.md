# Debugging a failed criterion

Load this reference only after a bug, test failure, or unexpected result. Keep
the investigation revision-bound and free of credentials, session tokens, and
secret values.

1. Reproduce the reported symptom with the smallest reliable command or
   interaction. Record the exact revision, environment, inputs that are safe to
   retain, expected outcome, and observed outcome.
2. Gather boundary evidence before modifying behavior. Trace the relevant data,
   state, configuration presence, and effect receipt across each component
   boundary. Record identifiers, shapes, status, and redacted presence/absence;
   never print, copy, or persist secret values.
3. State one falsifiable hypothesis that explains the boundary evidence. Compare
   a relevant working path or documented contract when available.
4. Run one minimal experiment that changes or observes one variable. If it
   disproves the hypothesis, preserve that result and return to the evidence;
   do not stack speculative fixes.
5. After identifying the cause, add the smallest behavior-level regression for
   the original symptom, verify it fails before the correction when feasible,
   apply one root-cause fix, and rerun the regression plus required verification
   on the final revision.

Escalate a non-reproducible failure, unavailable safe evidence, unresolved
external state, or repeated disproven hypotheses. Record the safe resume point
instead of claiming a cause or a fix.
