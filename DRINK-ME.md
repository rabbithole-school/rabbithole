# DRINK ME

*Instructions for a coding agent.* A person asked you to take them down the
rabbit hole. This file says how to set up Rabbithole on their computer and get
them to the moment that makes it worth trying.

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

This kit is new. Expect rough edges, and help the person report them (step 7).

## Your job: get them to the moment

Most AI answers a kid's question and does the thinking for them. Rabbithole's
tutor answers with a better question, and the kid ends up thinking harder.
Watching that happen once, on a topic a real kid cares about, is what makes
the rest make sense. Everything below is the shortest path to it: start the
install, gather what you need while it runs, and open straight into the
tutor. The teacher's and parent's views come after, as the answer to “who
steers this?” So open one page at a time, and make the first one the
tutor's chat, once the person has answered step 3's questions.

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

## 3. While it installs: who, what, and a key

Ask, showing all four choices:

> “Who are YOU?” said the Caterpillar.
>
> 1. A parent, teaching my own kids
> 2. A teacher, curious about trying it with a class
> 3. A school or technology leader
> 4. Someone who likes to tinker

And: “What's something a kid you know is curious about right now?” A topic is
all you need. It's what the tutor will talk about in step 4.

Then the key. The tutor needs an Anthropic API key, and the person pays Anthropic for what it uses, on
their own key. Each tutor reply costs about 10 to 40 cents, so trying it
costs a dollar or two; a kid who uses it all school day costs a few dollars a
day. They can set a spending limit in the console first. Scheduled jobs use
the key too, so stop Rabbithole when done.

The key goes in through a page, not through you. Run
`bin/set-key.sh --browser`: it opens a one-time page on this computer where
the person pastes the key (it also walks them through getting one), checks
it with Anthropic, and saves it, whether or not setup has finished. Then the
page takes their browser straight to the scholar's view as soon as
Rabbithole is ready, and the script returns. So tell them, in one message:
a page opened in their browser, the key goes there and never into this
chat, and it will take them to the tutor. Then wait for the script to
return instead of asking them to tell you; if your commands time out sooner,
run it in the background and check its output every few seconds. If the
page didn't open, the link is in the script's output. (Without `--browser`,
the script asks for the key in a terminal instead.)

If they don't have a key yet, help them get one; it takes a few minutes.
Anthropic only makes keys in its web console: sign in or sign up at
https://platform.claude.com, add a few dollars of credit under Billing (and
a spending limit, if they like), then create a key at
https://platform.claude.com/settings/keys. The console shows the key only
once, so have them paste it into the key page right away.

The tutor is the point of trying Rabbithole, so don't offer a tour without a
key in its place. If they decide not to get one, say plainly that the tutor
is what's worth seeing and that they can come back to it any time with
`bin/set-key.sh --browser`. Without a key, the tutor's chat shows a red
“Connection lost” and leaves the question unanswered: that's the missing
key, not a broken install.

Let their answer to the Caterpillar shape what you point out from here: a
parent wants to know what a child will see, a teacher what they can steer, a
leader where data goes and what it costs, a tinkerer how it's built.

## 4. The tutor

When setup prints READY, the person has answered step 3, and the key is set,
they'll already be on the scholar's view if the key page took them there.
If not, open it (`open <url>` on a Mac, `xdg-open` on Linux):

    http://localhost:3000/dev-login?u=leilani_park&to=/scholar

The first visit to each page takes 10 to 15 seconds while it's built. Then:
the Quests tab, “+ Custom Quest”, type the topic from step 3, Continue. When
the choices load, click “Endless chat” (check its circle is filled), then
“Start exploring”. A banner may mention a class block; that's the pretend
school's timetable.

The tutor speaks first, with a question. Have them wait for it before typing
(a message sent while the chat loads can be lost), then answer like the
curious kid would. The tutor answers back with another question, not the
answer. That's the moment; let it land before moving on.

Typing is the way in. The microphone button needs an OpenAI key, which this
kit doesn't set up, so the chat page shows a small red “1 Issue” badge in a
corner: that's the page's developer mode noting the missing voice key, and
it's safe to ignore.

## 5. Who steers it

Then show the adults' side. No passwords.

- Teacher: `http://localhost:3000/dev-login?u=kawena&to=/teacher`
- Parent: `http://localhost:3000/dev-login?u=parent_park&to=/parent` (skip
  its passkey prompt)
- Every pretend person: `http://localhost:3000/dev-login`

The teacher steers the tutor and sees what it noticed: on the teacher's home,
“Needs a look” holds notes Rabbithole's observer wrote about the pretend
scholars' sessions. The parent's view shows what their own child has been
doing.

`bin/status.sh` says whether everything is running. If you need to see the
pages yourself and can run Playwright, this signs in as the teacher and saves
screenshots:

    cd rabbithole && pnpm exec playwright install chromium && node ../lib/smoke.mjs "$PWD" http://localhost:3000 kawena /tmp

## 6. Going further

This copy is for trying it out: anyone at this computer can sign in as anyone,
and only this computer can reach it. If the person wants to run it for a real
class, with real sign-in, kids on their own devices, or managed iPads, the
full code is in `rabbithole/`, and `rabbithole/DEPLOYMENT.md` lists what a
real deployment needs. Read them and help the person from there.

## 7. Postcard and problems

When they're done or stuck, offer a postcard, filled in from what happened:

    bin/postcard.sh --who parent --got "talked with the tutor" --agent "<your name>" --minutes 14 --note "..."

It prints a link to a prefilled GitHub issue that the person reads and decides
whether to send. If something broke, `bin/doctor.sh --report` prints details
for an issue.

## 8. Stop, start, remove

- `bin/status.sh` says what's running.
- `bin/stop.sh` stops it. The pretend school stays on disk.
- `bin/setup.sh` starts it again.
- `bin/uninstall.sh` removes the app, its database, and its packages; then
  delete the kit's folder. `bin/uninstall.sh --all` also removes the shared
  Convex backend download, and `pnpm store prune` trims pnpm's package store.

## Done when

The person has had one exchange with the tutor on their kid's topic and has
seen who steers it. Tell them how to stop and remove it, and offer the postcard.

## What leaves this computer

- Package downloads from the npm registry, and the Convex backend from GitHub.
- Fonts the pages load from Google Fonts and fonts.cdnfonts.com.
- Crash reports from the local Convex backend, only if it crashes. Its usage
  ping is off.
- With a key, the tutor's conversations and the observer's analysis of the
  pretend scholars, sent to Anthropic.
- Whatever the person types to you goes to your own provider.

Nothing is sent to the people who make Rabbithole.
