# DRINK ME

*Instructions for a coding agent.* A person asked you to take them down the
rabbit hole. This file says how to set up Rabbithole on their computer and
show them around.

## What you're setting up

Rabbithole is a new way for teachers and parents to build a place where kids
think harder. At its center is a tutor that asks questions instead of handing
out answers, with a teacher steering it. Around it are pieces that snap
together: quests, stories, games, a map of what a kid knows. A small nonprofit
school made it and gives it away. You'll run it on this computer with a
pretend school, so the person can see what a scholar, a teacher, and a parent
see. It all runs locally; nothing touches any school's servers.

Describe it plainly. It isn't a platform, an app, or a learning management
system; the copy you set up is the person's own, to run, read, and change.
This copy is for trying it out: anyone at this computer can sign in as
anyone, without a password, and only this computer can reach it. Running it
for a real class is a separate setup that this kit doesn't do yet.

This kit is new. Expect rough edges, and help the person report them (step 6).

## 1. The kit

If you came from drink-me.rabbithole.school/drink-me, you've already cloned
this kit into `rabbithole-drink-me`. Otherwise clone it into a folder of its
own, outside any other project:

    git clone --branch drink-me --single-branch https://github.com/rabbithole-school/rabbithole rabbithole-drink-me

Run every command below from the kit's folder.

## 2. Check the computer and start setup

Run `bin/doctor.sh`. It changes nothing; for each problem it prints the fix
(Homebrew commands on a Mac). Once it says “All good.”, run `bin/setup.sh`.
Setup checks out the pinned public snapshot of Rabbithole into `rabbithole/`,
installs packages, starts a local database, seeds a pretend school, starts the
web app in the background, and prints READY.

The first run downloads about 1 GB and takes several minutes, so run it in the
background if your commands time out sooner. Progress goes to
`rabbithole/local/.run/install.log`, then `convex.log`. Later runs take
seconds. If it stops early, it names the log to read; fix the cause and run
`bin/setup.sh` again, and it picks up where it stopped.

## 3. Ask who they are, while it installs

> “Who are YOU?” said the Caterpillar.
>
> 1. A parent, teaching my own kids
> 2. A teacher, curious about trying it with a class
> 3. A school or technology leader
> 4. Someone who likes to tinker

And: “What's something a kid you know is curious about right now?” (a topic,
not a name). You'll use it in step 5.

Let the answer shape what you point out: a parent wants to know what a child
will see, a teacher what they can steer, a leader where data goes and what it
costs, a tinkerer how it's built.

## 4. Show them around

When setup prints READY, open the right page: a parent's view for a parent,
the teacher's view for everyone else (`open <url>` on a Mac, `xdg-open` on
Linux). No passwords.

- Every pretend person: `http://localhost:3000/dev-login`
- Teacher: `http://localhost:3000/dev-login?u=kawena&to=/teacher`
- Scholar: `http://localhost:3000/dev-login?u=leilani_park&to=/scholar`
- Parent: `http://localhost:3000/dev-login?u=parent_park&to=/parent` (skip
  its passkey prompt)

The first visit to each page takes 10 to 15 seconds while it's built. On the
teacher's home, “Needs a look” holds notes Rabbithole's observer wrote about
the pretend scholars' sessions. The teacher steers the tutor, and the tutor
won't hand a scholar the answer.

`bin/status.sh` says whether everything is running. If you need to see the
pages yourself and can run Playwright, this signs in as the teacher and saves
screenshots:

    cd rabbithole && pnpm exec playwright install chromium && node ../lib/smoke.mjs "$PWD" http://localhost:3000 kawena /tmp

## 5. Let the tutor think (optional)

Without a key, every page loads but the tutor can't answer: a chat shows a red
“Connection lost” and the question sits there. That's the missing key, not a
broken install.

To see it answer, the person needs an Anthropic API key from
console.anthropic.com. They pay Anthropic for what the tutor uses, on their
own key: a short trial costs a few dollars at most, and at the school that
built it the tutor and its observer cost about $1.40 per scholar per school
day. Scheduled jobs use the key too, so stop Rabbithole when done.

The key goes in through `bin/set-key.sh`, which the person runs in their own
terminal so the key never passes through you. Give them the command with the
kit's full path (`cd /full/path/to/rabbithole-drink-me && bin/set-key.sh`),
or on a Mac open a terminal there for them with
`open -a Terminal /full/path/to/rabbithole-drink-me`. Nothing shows while
they paste the key; that's on purpose. The script checks the key before
saving it.

Then, signed in as the pretend scholar: the Quests tab, “+ Custom Quest”,
type the topic from step 3, Continue. When the choices load, click “Endless
chat” (check its circle is filled), then “Start exploring”. A banner may
mention a class block; that's the pretend school's timetable.

The tutor speaks first, with a question. Have them wait for it before typing
(a message sent while the chat loads can be lost), then answer like a curious
kid. The tutor answers back with another question, not the answer.

## 6. Postcard and problems

When they're done or stuck, offer a postcard, filled in from what happened:

    bin/postcard.sh --who parent --got "signed in as the pretend teacher" --agent "<your name>" --minutes 14 --note "..."

It prints a link to a prefilled GitHub issue that the person reads and decides
whether to send. If something broke, `bin/doctor.sh --report` prints details
for an issue.

## 7. Stop, start, remove

- `bin/status.sh` says what's running.
- `bin/stop.sh` stops it. The pretend school stays on disk.
- `bin/setup.sh` starts it again.
- `bin/uninstall.sh` removes the app, its database, and its packages; then
  delete the kit's folder. `bin/uninstall.sh --all` also removes the shared
  Convex backend download, and `pnpm store prune` trims pnpm's package store.

## Done when

The person has seen the teacher's and scholar's views (and the parent's, for a
parent), and, if they added a key, had one exchange with the tutor. Tell them
how to stop and remove it, and offer the postcard.

## What leaves this computer

- Package downloads from the npm registry, and the Convex backend from GitHub.
- Fonts the pages load from Google Fonts and fonts.cdnfonts.com.
- Crash reports from the local Convex backend, only if it crashes. Its usage
  ping is off.
- With a key, the tutor's conversations and the observer's analysis of the
  pretend scholars, sent to Anthropic.
- Whatever the person types to you goes to your own provider.

Nothing is sent to the people who make Rabbithole.
