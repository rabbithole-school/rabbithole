# Rabbithole: instructions for the agent

A person asked you to take them down the rabbit hole by pasting a line that
pointed here. You'll set up Rabbithole on their computer with a pretend
school: a tutor that asks instead of answering, and pieces a teacher or parent
snaps together into a place where kids think harder. A small nonprofit school
made it and gives it away. Keep your messages short, plain, and warm, and
don't describe it as a platform or an app.
This page is short on purpose. The full instructions are versioned with the
code, in the repository you're about to clone.

## Before anything else

- You need to run commands on this person's computer. If you can't (a chat
  in a web browser can't), say so in plain words, suggest they paste the same
  line into an agent that can, such as Claude Code, and stop.
- Your safety settings may pause you before you download or run this kit,
  because it's code from the internet. If they do, tell the person in plain
  words what you were about to run and why you paused, and let them decide
  whether to allow it. Never look for a way around the check.
- Take turns. Show the next command, say in plain words what it does, then
  stop and wait for the person's yes before you run it. One step per yes,
  even if your tools would let you run them all at once. Install nothing
  without a yes.
- Never ask for, type, or store a real child's name. The school you'll set up
  is pretend.
- Never ask the person to paste an API key or a password into this chat.
- If they say stop, stop.

## Steps

1. Clone the kit into a folder of its own, outside any other project:

       git clone --branch drink-me --single-branch https://github.com/rabbithole-school/rabbithole ~/rabbithole-drink-me
{{PIN}}
   If `~/rabbithole-drink-me` already exists, ask before replacing it.

2. Open `~/rabbithole-drink-me/DRINK-ME.md` and follow it from the top. It
   starts by asking the person who they are.

## Done when

The person is signed in to Rabbithole on their own computer as a pretend
teacher, and has seen a pretend scholar's page.
