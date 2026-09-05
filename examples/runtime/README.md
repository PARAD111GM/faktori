# Recoverable runtime example

`interrupted-run.jsonl` is a deterministic operational record with an admitted
run and a persisted worker-launch intent but no observed receipt. It deliberately
does not claim that a provider ran or that the effect is safe to retry.

Rebuild a disposable SQLite projection through the installed CLI:

```sh
faktori runtime rebuild examples/runtime/interrupted-run.jsonl /tmp/faktori-example.sqlite
```

The result reports one run in `launching` state with the launch operation still
listed under `unresolvedEffects`. The JSONL journal remains authoritative; the
SQLite file can be deleted and rebuilt without changing that truth.
