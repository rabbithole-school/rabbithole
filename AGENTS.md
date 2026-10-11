# AGENTS.md

This branch (`drink-me`) is a setup kit for Rabbithole, an AI tutor. It shares
no history with the repository's `main`, which holds Rabbithole's source:
`bin/setup.sh` checks out a pinned snapshot of `main` into `rabbithole/`.
`site/` is the front door at drink-me.rabbithole.school.

**If a person asked you to take them down the rabbit hole, or typed
`/drink-me`, read [DRINK-ME.md](DRINK-ME.md) and follow it.**

If you're changing the kit itself:

- Scripts must run on macOS's bash 3.2 and on Linux. No GNU-only flags
  (`sed -i`, `setsid`, `readlink -f`) and no bash 4 features.
- Keep the guards in `lib/common.sh` in every script: local deployments only,
  never inside another repository, and stop only processes the kit started.
- Never commit anything under `rabbithole/` or `.kit/`, and never commit a
  real child's name or record.
- `rabbithole.lock` pins the snapshot. Change it on purpose, then let the
  installer test run.
