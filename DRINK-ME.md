# DRINK ME

*Instructions for a coding agent.* A person asked you to take them down the
rabbit hole. This file says how. Read all of it before you run anything.

## What you're setting up

Rabbithole is a Socratic AI tutor for gifted kids, made by a small nonprofit
school. It asks questions instead of handing out answers, and a teacher stays
in charge of it. You'll run it on this computer with a pretend school, so the
person can see what a scholar sees and what a teacher sees. Nothing here
touches any school's servers.

This kit is in a private pilot. Expect rough edges. When something breaks,
help the person report it (step 7).

## Rules

1. **Ask before you act.** Show each command and say in one sentence what it
   does before you run it. Install nothing without a yes.
2. **Pretend people only.** Never ask for, type, or store a real child's name
   or details. The school in this kit is fictional, and it stays that way.
3. **Keys stay out of the chat.** Never ask the person to paste an API key or
   a password to you. `bin/set-key.sh` takes the key in their own terminal.
4. **Stay on this computer.** Never run `convex deploy`, never use a
   `CONVEX_DEPLOY_KEY`, and never point anything at a cloud deployment. If the
   person wants Rabbithole online for real students, tell them that's a later
   step of the pilot and isn't in this kit.
5. **Use the scripts.** Run the `bin/` scripts instead of improvising what they
   do. If one fails, read its message and the log it names, fix the cause, and
   run it again. Don't edit files under `rabbithole/`.
6. **Stop means stop.** If the person wants out, run `bin/stop.sh` and tell
   them that `bin/uninstall.sh` removes everything.

## 1. Find the kit

You need this kit cloned into a folder of its own, outside any other project.
It lives on the `drink-me` branch of the public Rabbithole repository, and
`~/rabbithole-drink-me` is a good place for it:

    git clone --branch drink-me --single-branch https://github.com/rabbithole-school/rabbithole ~/rabbithole-drink-me

If you came from drink-me.rabbithole.school/drink-me, you've already cloned
it. Run every command below from the kit's folder.

## 2. Ask who they are

Before anything else, ask:

> “Who are YOU?” said the Caterpillar.
>
> 1. A parent, teaching my own kids
> 2. A teacher, curious about trying it with a class
> 3. A school or technology leader
> 4. Someone who likes to tinker

Then ask one more question: “What's something a kid you know is curious about
right now?” Ask for a topic, never a name. Keep the answer for step 6.

The steps are the same for everyone in this pilot. Let the answer decide what
you explain along the way. A parent wants to know what a child will see, a
teacher what they can steer, a leader where data goes and what it costs, and a
tinkerer how it's built.

## 3. Check the computer

Run `bin/doctor.sh`. It changes nothing. For each problem, it prints the fix
(Homebrew commands on a Mac). Ask before installing anything, then run the
doctor again until it says “All good.”

## 4. Set it up

Run `bin/setup.sh`. It checks out the pinned public snapshot of Rabbithole
into `rabbithole/`, installs packages, starts a local database, seeds a
fictional school, and starts the web app in the background. It returns once
it prints READY.

The first run downloads about 1.2 GB and can take several minutes, so tell the
person what's happening while it runs. Later runs take seconds. If it fails,
it names a log in `.kit/`. Read it, fix the cause, and run `bin/setup.sh`
again; it picks up where it stopped.

## 5. Show them around

Ask the person to open these in a browser. On a Mac you can run `open <url>`
for them, with their yes.

- `http://localhost:3000/dev-login` lists every pretend person. Pick anyone;
  there's no password.
- A teacher's view: `http://localhost:3000/dev-login?u=kawena&to=/teacher`
- A scholar's view: `http://localhost:3000/dev-login?u=leilani_park&to=/scholar`

If setup chose other ports, use the addresses it printed. On the teacher's
home, “Needs a look” holds notes Rabbithole's observer wrote about pretend
scholars' sessions. The teacher steers the tutor, and the tutor won't hand a
scholar the answer.

`bin/status.sh` tells you whether everything is running and how many pretend
people exist, if you want to check without a browser.

## 6. Let the tutor think (optional)

Without a key, every page works but the tutor can't answer. To see it answer,
the person needs an Anthropic API key from console.anthropic.com. Explain the
cost plainly: they pay Anthropic for what the tutor uses, on their own key. A
short trial costs a few dollars at most. At the school that built it, the
tutor and its observer have cost about $1.40 per scholar per school day.

Ask them to run this themselves, in their own terminal, from the kit's folder:

    bin/set-key.sh

Then have them sign in as the pretend scholar, start something new, and ask
the tutor about the topic from step 2. Point out that it answers with a
question.

## 7. Postcard and problems

When they're done, or stuck, offer to send a postcard. Fill it in from what
happened, and never include anything about a real child:

    bin/postcard.sh --who parent --got "the tutor answered" --agent "<your name>" --minutes 14 --note "..."

It prints a link. The person opens it, reads the postcard, and decides whether
to send it.

If something broke, `bin/doctor.sh --report` prints details for an issue. Ask
the person to read the report before posting it.

## 8. Stop, start, remove

- `bin/status.sh` says what's running.
- `bin/stop.sh` stops it. The pretend school stays on disk.
- `bin/setup.sh` starts it again.
- `bin/uninstall.sh` removes the app, its database, and its packages. Then
  delete the kit's folder.

## Done when

The person has signed in as a pretend teacher and as a pretend scholar. If
they added a key, they've had one exchange with the tutor. Finish by telling
them how to stop it and how to remove it, and offer the postcard.

## What leaves this computer

- Package downloads from the npm registry, and the Convex backend from GitHub.
- The Convex backend's anonymous usage ping and crash reports, which every
  local Convex backend sends to Convex.
- With a key, the tutor's conversations, sent to Anthropic.

Nothing is sent to the people who make Rabbithole.
