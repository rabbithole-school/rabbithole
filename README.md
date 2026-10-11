# drink-me

A small door into Rabbithole. Paste one line into your coding agent and it
sets up Rabbithole on your own computer, with a pretend school. You don't need
an account or a subscription, and no real school's data is involved.

> **Status: preview, gate 0, not yet announced.** This branch exists to test
> the line with real agents before it's shared. It has no history in common
> with `main`. The kit runs the public Rabbithole snapshot published on
> September 2, 2026. No license is granted beyond testing yet.

## Try it

Paste this into Claude Code, Codex, Cursor, or any agent that can use a
terminal:

```text
Read drink-me.rabbithole.school/drink-me and take me down the rabbit hole.
```

That page tells the agent to clone this branch and follow
[DRINK-ME.md](DRINK-ME.md). To skip the page, clone it yourself and type
`/drink-me` in Claude Code (or tell any agent to follow DRINK-ME.md):

```sh
git clone --branch drink-me --single-branch https://github.com/rabbithole-school/rabbithole ~/rabbithole-drink-me
```

The agent asks who you are, checks your computer, and sets up a local copy
with a pretend school. It shows you each command before it runs it.

## What you need

- A Mac or a Linux computer (on Windows, use WSL) with about 3.5 GB of free disk
- git, Node 22, and pnpm 10. `bin/doctor.sh` says how to get anything missing.
- Optional: an Anthropic API key, so the tutor can answer

## What it does, and what it never does

- It checks out the snapshot pinned in `rabbithole.lock` into `rabbithole/`,
  starts a local Convex backend and the web app, and seeds a fictional school.
  Everything it makes stays inside this folder.
- It never touches a cloud deployment. The scripts refuse to run with a
  Convex deploy key in the shell or a cloud `.env.local`, and they refuse to
  run inside another git repository.
- It sends nothing to the people who make Rabbithole. What does leave your computer: package
  downloads, the Convex backend download, that backend's anonymous usage ping
  and crash reports, and, if you add a key, tutor conversations to Anthropic.

## Commands

| Command | What it does |
|---|---|
| `bin/doctor.sh` | Checks this computer. Changes nothing. |
| `bin/setup.sh` | Sets up and starts Rabbithole. Safe to run again. |
| `bin/status.sh` | Shows what's running and how many pretend people exist. |
| `bin/set-key.sh` | Gives the tutor an Anthropic key. Run it yourself, not through an agent. |
| `bin/stop.sh` | Stops it. The pretend school stays. |
| `bin/postcard.sh` | Prints a prefilled postcard link, for telling us how it went. |
| `bin/uninstall.sh` | Removes everything the kit made. |

Ports default to 3000 (web), 3210 and 3211 (backend). Override them with
`WEB_PORT`, `CLOUD_PORT`, and `SITE_PORT`.

## Known gaps in this pilot

- Web only. The iPad app isn't part of it.
- Times and “today” assume Hawaii in places, because the snapshot hardcodes
  `Pacific/Honolulu`.
- The kit adds two small files to the checkout (in `overlay/`). One is a
  no-op stand-in for a scheduled job that the public code still references
  but doesn't include. The other gives the pretend teachers their pretend
  scholars, because the public snapshot has no membership backfill.
- Slide export may fail, because the snapshot is missing a vendored
  `image-size` build.

## The front door

`site/` is the page at drink-me.rabbithole.school: the line to copy for
people, and `/drink-me` for agents. `site/build.mjs` writes the commit it was
built from into `/drink-me`, so the page always points at the kit version
deployed with it. Vercel builds it from this branch only (`vercel.json`).

## Where this comes from

This kit is the pilot described in chapter VII of the Rabbithole distribution
proposal, “The Little Door”.
