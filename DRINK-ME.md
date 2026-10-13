# DRINK ME

*Instructions for a coding agent.* A person asked you to take them down the
rabbit hole. This file says how. Read all of it before you run anything.

## What you're setting up

Rabbithole is a new way for teachers and parents to build a place where kids
think harder. At its center is a tutor that asks questions instead of handing
out answers, with a teacher steering it. Around it are pieces that snap
together: quests, stories, games, a map of what a kid knows. A small nonprofit
school made it and gives it away. You'll run it on this computer with a
pretend school, so the person can see what a scholar sees and what a teacher
sees. Nothing here touches any school's servers.

**How to sound.** Be short, plain, and warm, like a helpful stage manager
rather than a salesperson. Don't describe Rabbithole as a platform, an app, or
a learning management system. Treat the person as a builder: the copy you set
up is theirs to run, read, and change. Be exact about facts, including what
leaves the computer. Every rule below still applies.

This kit is new. Expect rough edges. When something breaks, help the person
report it (step 7).

## Rules

1. **Ask before you act, one step at a time.** Assume the person has never
   used a terminal and that git and Node mean nothing to them. Show the next
   command, say in plain words what it does, then end your message and wait
   for their yes. Run it yourself once they say yes. One step per yes, even
   if your tools would let you run several at once, and never skip ahead of
   step 2's questions. Install nothing without a yes. If your safety settings
   pause a step, say what it was and why in plain words, and let the person
   decide. Never work around the check.
2. **Pretend people only.** Never ask for, type, or store a real child's name
   or details. The school in this kit is fictional, and it stays that way.
3. **Keys stay out of the chat.** Never ask the person to paste an API key or
   a password to you. `bin/set-key.sh` takes the key in their own terminal.
4. **Stay on this computer.** Never run `convex deploy`, never use a
   `CONVEX_DEPLOY_KEY`, and never point anything at a cloud deployment. If the
   person wants Rabbithole online for real students, tell them that's a later
   step of the pilot and isn't in this kit.
5. **Use the scripts.** Run the `bin/` scripts instead of improvising what they
   do. Never start, stop, or restart its parts by hand, even to apply a
   setting; if the person asks for something no script does, say so plainly.
   If a script fails, read its message and the log it names, fix the cause,
   and run it again. Don't edit files under `rabbithole/`.
6. **Stop means stop.** If the person wants out, run `bin/stop.sh` and tell
   them that `bin/uninstall.sh` removes everything.

## 1. Find the kit

You need this kit cloned into a folder of its own, outside any other project.
It lives on the `drink-me` branch of the public Rabbithole repository. Clone it
into a `rabbithole-drink-me` folder inside the folder you're working in, unless
that folder is inside another project (then ask, and suggest the home folder):

    git clone --branch drink-me --single-branch https://github.com/rabbithole-school/rabbithole rabbithole-drink-me

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

The first run downloads about 1 GB and can take several minutes. If your
commands time out sooner than that, run it in the background and follow
`rabbithole/local/.run/install.log`, then `rabbithole/local/.run/convex.log`,
telling the person what's happening as it goes. Later runs take seconds. If it
fails or gets interrupted, it names a log in `rabbithole/local/.run/`. Read it, fix the cause, and run
`bin/setup.sh` again; it picks up where it stopped.

## 5. Show them around

Ask the person to open these in a browser. With their yes, you can open them
for them: `open <url>` on a Mac, `xdg-open <url>` on Linux.

- `http://localhost:3000/dev-login` lists every pretend person. Pick anyone;
  there's no password.
- A teacher's view: `http://localhost:3000/dev-login?u=kawena&to=/teacher`
- A scholar's view: `http://localhost:3000/dev-login?u=leilani_park&to=/scholar`
- A parent's view: `http://localhost:3000/dev-login?u=parent_park&to=/parent`
  (show this one first to a parent; skip its passkey prompt)

When the teacher's page first opens, say it plainly, once: this is theirs
now. It runs on their computer, from code they can read and change, and
nothing is rented.

If you set other ports, use the addresses setup printed. Tell them the first
visit to each page can take 10 to 15 seconds while it's built; after that,
pages are quick. On the teacher's home, “Needs a look” holds notes
Rabbithole's observer wrote about pretend scholars' sessions. The teacher
steers the tutor, and the tutor won't hand a scholar the answer.

To check without a browser, `bin/status.sh` says whether everything runs and
how many pretend people exist. If you can run Playwright, this signs in as
the pretend teacher in a real browser and saves screenshots:

    cd rabbithole && pnpm exec playwright install chromium && node ../lib/smoke.mjs "$PWD" http://localhost:3000 kawena /tmp

## 6. Let the tutor think (optional)

Without a key, every page loads but the tutor can't answer. If the person
opens a chat anyway, they'll see a red “Connection lost” message and their
question will sit unanswered. Tell them that's the missing key, not a broken
install, and don't demo the chat until a key is set.

To see it answer, the person needs an Anthropic API key from
console.anthropic.com. Explain the cost plainly: they pay Anthropic for what
the tutor uses, on their own key. A short trial costs a few dollars at most.
At the school that built it, the tutor and its observer have cost about $1.40
per scholar per school day. While a key is set, scheduled jobs can call the
model too, so they should stop Rabbithole when they're done.

Ask them to run the key script themselves, in their own terminal. Give them
the exact command with the kit's full path, for example:

    cd /full/path/to/rabbithole-drink-me && bin/set-key.sh

If they've never used a terminal, open one for them in the kit's folder (on
a Mac, `open -a Terminal /full/path/to/rabbithole-drink-me`). Tell them to type
`bin/set-key.sh`, press Return, and paste the key when it asks. Nothing
shows while they paste; that's on purpose.

It checks the key with Anthropic before saving it. Then have them sign in as
the pretend scholar and start a chat about the topic from step 2: the Quests
tab, then “+ Custom Quest”, type the topic, and Continue. Wait a few seconds
for the choices to load; one of them is picked for you, so click “Endless
chat” and check that its circle is filled. Then “Start exploring”, which goes
straight into the chat. A banner may mention a class block; that's the
pretend school's timetable.

The tutor speaks first, with a question. Tell the person to wait for it
before typing: a message sent while the chat is still loading can be lost.
Then have them answer it the way a curious kid would, and point out that the
tutor answers back with another question rather than the answer.

## 7. Postcard and problems

When they're done, or stuck, offer to send a postcard. Fill it in from what
happened, and never include anything about a real child:

    bin/postcard.sh --who parent --got "signed in as the pretend teacher" --agent "<your name>" --minutes 14 --note "..."

It prints a link to a prefilled GitHub issue. The person opens it, reads the
postcard, and decides whether to send it. Sending needs a GitHub account.

If something broke, `bin/doctor.sh --report` prints details for an issue. Ask
the person to read the report before posting it.

## 8. Stop, start, remove

- `bin/status.sh` says what's running.
- `bin/stop.sh` stops it. The pretend school stays on disk.
- `bin/setup.sh` starts it again.
- `bin/uninstall.sh` removes the app, its database, and its packages. Then
  delete the kit's folder. Two shared caches stay: pnpm's package store
  (`pnpm store prune` trims it) and the Convex backend download
  (`bin/uninstall.sh --all` removes it).

## Done when

The person has signed in as a pretend teacher and as a pretend scholar (and,
for a parent, the parent's view). If they added a key, they've had one
exchange with the tutor. Finish by telling them how to stop it and how to
remove it, and offer the postcard.

## What leaves this computer

- Package downloads from the npm registry (pnpm may also fetch the exact
  version the app pins), and the Convex backend from GitHub.
- Fonts the app's pages load from Google Fonts and fonts.cdnfonts.com.
- The Convex backend's anonymous usage ping and crash reports, which every
  local Convex backend sends to Convex.
- With a key, the tutor's conversations, sent to Anthropic.

Nothing is sent to the people who make Rabbithole.
