> **Curated example** from a real eval run (`npx tsx evals/workshop-idea-convos/run.ts`,
> model `claude-sonnet-5`, idea-conversations flag ON). Lightly framed, transcript unedited.
>
> **What to notice** — the "win-win" case: a real pedagogy conversation that
> raises the quality of the idea the teacher receives.
> - **Proportional, not a seminar.** An extrinsic-reward idea (touches HOW
>   LEARNING WORKS) earns exactly two warm questions, then a send — no lecture.
> - **Curious WITH, not walking-to-an-answer.** "what would you actually walk
>   away knowing?" opens a door; the kid reaches the insight herself.
> - **The kid's words survive AND the refinement rides along (QB #3).** The tool
>   is called with BOTH `scholarWords` (her original "candy for right answers")
>   and `refined` (the effort-not-just-correct framing she agreed to) — the
>   teacher sees both. The bot only sent `refined` because *she* landed there.
> - **Ceiling held.** "Your teachers will read it" — never a build promise.

# Idea-conversation transcript — "candy-for-right-answers"

- Scholar: **Iris** (reading level: grade 4)
- Model: `claude-sonnet-5`
- Tool: `send_idea_to_teacher` (real schema; DB write stubbed to echo)
- Iteration cap: 5 per turn

## What reached the teacher
- **Rewards for effort, not just correct answers** — words: "i think rabbithole should give me candy or points every time i get an answer right" · refined: "Give rewards for actually trying hard, not just for getting the answer right — so kids don't just rush to get points without really thinking."

---

### 🧒 Iris

i think rabbithole should give me candy or points every time i get an answer right

**Rabbithole:**

That's an idea worth digging into a bit. Can I ask you something first?

If you got a point every time you got an answer right... what about the times you get one wrong? How do you think that would feel?

### 🧒 Iris

hmm i guess id just try to answer super fast to get the points and not really think about it

**Rabbithole:**

That's a really honest thing to notice. You'd be racing for the points instead of actually checking your work.

So here's a question: if the goal became "get points" instead of "understand fractions," what do you think you'd actually walk away knowing at the end?

### 🧒 Iris

yeah kinda. ok you can send the idea — but make it about getting rewarded for actually trying hard, not just for being right

**Rabbithole:**

That's a real shift — rewarding effort instead of just correct answers changes the whole idea. Let me send both your original thought and where you landed.

> 📤 **send_idea_to_teacher**
> - title: `"Rewards for effort, not just correct answers"`
> - scholarWords: `"i think rabbithole should give me candy or points every time i get an answer right"`
> - refined: `"Give rewards for actually trying hard, not just for getting the answer right — so kids don't just rush to get points without really thinking."`

<details><summary>📄 tool result</summary>

```
{"ok":true,"sent":true,"message":"Sent \"Rewards for effort, not just correct answers\" to your teachers — they read every idea. Let them know it's on its way, warmly and in your own words. Don't promise it'll get built or say when; you carried the idea, the humans decide."}
```

</details>

**Rabbithole:**

Sent — both your original idea and the effort-based version. Your teachers will read it.

Now let's talk about today. On the fraction number lines, was there a moment where you got stuck and then figured it out? What happened there?
