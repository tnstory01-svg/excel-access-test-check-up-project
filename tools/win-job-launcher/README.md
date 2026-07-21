# win-job-launcher

Windows-only worker helper. This is not the product launcher and must only start an already-authorized worker supplied by the server; it neither interprets artifact handles nor opens Excel files.

## Invocation

```text
win-job-launcher --timeout-ms <positive milliseconds> -- <program> [argument ...]
```

The helper starts the program with inherited standard input/output/error using `CreateProcessW(CREATE_SUSPENDED)`, configures a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigns the primary process before resuming its thread, and closes the job on timeout. It attempts `CTRL_BREAK_EVENT` cancellation, waits two seconds, then closes the job so the worker process tree is killed. Failure to assign the Job Object terminates the still-suspended primary process and never resumes it.

Argument validation is platform-independent and tested. Running a valid invocation on a non-Windows host fails clearly because the required Job Object boundary is unavailable.

## Source-only policy

This helper's executable is a temporary CI/local validation artifact only. Do not track, push, package, or publish its binary, ZIP, runtime, or `target/` output. Commit source and the locked Cargo dependency graph only.
