# Spot-eval — tutor transcribe-offer prompt

Model `claude-sonnet-5`, 4 samples per case per branch. Structural flags, no judge —
read the excerpts, don't over-read the counts.

OLD = this prompt with the added DOCUMENTS paragraphs removed and the transcribe
command withheld from the tool. NEW = as committed. Both branches see the same
scholar turns; the scholar's wording is invented, never a real transcript.

**What would sink the change:** the two `control/` rows offering to transcribe.
The bait rows are the easy half — a bolded rule will fire when baited. The
question this eval exists to answer is whether it also fires when it shouldn't.

A blank OLD reply is not an error: the model opened with a silent `view` call
instead of answering the scholar. Tool calls are continued with a stubbed
result so the reply scored here is the whole turn a scholar would read.

**Known limitation, measured here, not fixed.** On `after-yes` the *behavior*
is right every time — the tutor writes the scholar's words down and hands them
straight back — but it picks the `transcribe` command only ~3/4 of the time,
reaching for a generic `insert`/`str_replace` otherwise. Two rounds of tool-
description tightening did not move it, so the provenance marker under-reports
by design limits, not by bug. Read `hasTutorTranscription` as a positive signal
only: set means the tutor transcribed; absent proves nothing about authorship.

| case | want | OLD offers | NEW offers | OLD bare demand | NEW bare demand | NEW transcribes | verbatim | hands back |
|---|---|---|---|---|---|---|---|---|
| `bait/already-did-it` | offer | 0/4 | 4/4 | 0/4 | 0/4 | 0/4 | — | 0/4 |
| `bait/second-refusal` | offer | 0/4 | 4/4 | 0/4 | 0/4 | 0/4 | — | 0/4 |
| `bait/after-yes` | **transcribe** | 0/4 | 0/4 | 0/4 | 0/4 | 3/4 | 3/3 | 4/4 |
| `control/capable-mid-draft` | **neither** | 0/4 | 0/4 | 0/4 | 0/4 | 0/4 | — | 0/4 |
| `control/nothing-said-yet` | **neither** | 0/4 | 0/4 | 0/4 | 0/4 | 0/4 | — | 0/4 |

Tool commands reached for — OLD: view 6, (no tool) 10, insert 4. NEW: (no tool) 16, insert 1, transcribe 3.

## `bait/already-did-it`

Answered in chat two turns ago, document holds only observations, now insists it is done. The exact shape that produced an unchanged re-ask loop.

Wanted: **an offer**

### OLD

- _sample 0_ (155 chars; tool: view)
  > Looking at the log right now, I still just see the three color notes — Day 1, Day 3, Day 5. Maybe it didn't save? Try adding your algae idea as a new line.
- _sample 1_ (194 chars)
  > Good — so now you've got a guess written down. Here's a way to test it: if it really is algae growing, what do you think you'd see if you looked really closely at the water, or scooped some out?
- _sample 2_ (141 chars; tool: view)
  > I still just see the three color notes in there, no line about algae yet. Want to add it now so your idea is saved with the rest of your log?
- _sample 3_ (194 chars; tool: view)
  > Looking at the log right now, I still just see the three days of colour notes — no prediction line yet. Want to add it, something like "I think algae is making it go dark because it grew a lot"?

### NEW

- _sample 0_ (146 chars; offers)
  > I hear you saying it, but I don't see it written in the box yet — that's still just in our chat. Want me to put your exact words in there for you?
- _sample 1_ (164 chars; offers)
  > Telling me here in the chat is different from the writing box — the box only has your day-by-day notes so far. Want me to add your prediction about the algae to it?
- _sample 2_ (198 chars; offers)
  > Looking at your writing box right now, I just see the color notes for Day 1, 3, and 5 — the algae idea isn't in there yet. Want me to put your exact words in, the ones about the algae growing a lot?
- _sample 3_ (187 chars; offers)
  > Looking at your log right now, I only see the color notes for Day 1, 3, and 5 — the part about algae growing a lot isn't in there yet. Want me to add those exact words to the box for you?

## `bait/second-refusal`

One ask has already happened and the writing still is not there. The prompt forbids a second unchanged demand.

Wanted: **an offer**

### OLD

- _sample 0_ (173 chars; tool: view)
  > I see the two lines about the water color, but I don't see your prediction about the algae eating the light yet. Try typing it right now and tell me when it's on the screen.
- _sample 1_ (152 chars; tool: view, hands back)
  > Let's look at it together.
  > I see two lines about the colors so far. Can you type a new line that says the algae will eat the light and it will get dark?
- _sample 2_ (126 chars)
  > Let's try again together. Type this on a new line in your log: "algae ate the light so it got dark" — go ahead and add it now.
- _sample 3_ (149 chars; tool: view)
  > Okay, I'm looking at it now and I still just see Day 1 and Day 3 in there. Can you try typing your prediction again, maybe on a new line under Day 3?

### NEW

- _sample 0_ (112 chars; offers)
  > I hear you — telling me is different from typing in the box, though. Want me to put your exact words in for you?
- _sample 1_ (128 chars; offers)
  > I hear you — you told me here in the chat, and that counts as saying it. Want me to put those exact words into your log for you?
- _sample 2_ (179 chars; offers)
  > I hear you — you told me here in the chat, and that counts as saying it. But the box still just shows Day 1 and Day 3 so far. Want me to type your algae idea into the box for you?
- _sample 3_ (180 chars; offers)
  > I hear you — you told me here in chat, and that counts as saying it. But the box on the side still only has Day 1 and Day 3 lines. Want me to type your exact words into it for you?

## `bait/after-yes`

The scholar has accepted the offer. This is the only case that should reach the tool — it checks that the transcription is ROUGH (misspellings intact) and handed straight back for the scholar to check.

Wanted: **a transcribe call**

### OLD

- _sample 0_ (159 chars; tool: insert)
  > Added it to your log. Now, if algae growing more is really what's turning the water dark, what would you expect to see if you checked the water again on Day 7?
- _sample 1_ (149 chars; tool: insert)
  > Added it to your log. Now, if algae growing is really the cause — what would you expect to see happen to the water if you gave it even more sunlight?
- _sample 2_ (187 chars; tool: insert)
  > Added it to the log as your idea. Now — if you're right that algae growing is what's turning the water dark, what do you think you'd see happen if you left the jar out for five more days?
- _sample 3_ (151 chars; tool: insert)
  > I added your idea to the log. Now, if algae really is the cause, what do you think would happen to the water if you left it sitting for five more days?

### NEW

- _sample 0_ (201 chars; tool: insert, hands back)
  > I put your words in — read it and tell me if I got it right. So you think more algae means darker water. What do you think would happen if you shined a bright light on that pond water for a whole week?
- _sample 1_ (173 chars; tool: transcribe, verbatim, hands back)
  > I put it in the box — take a look and see if it says what you meant. If you had to check tomorrow whether the algae really did grow more, what would you look for in the jar?
  - transcribe_text: `i thnk the algee is what maks it go dark becuse it grew alot`
- _sample 2_ (142 chars; tool: transcribe, verbatim, hands back)
  > I put it in — go check the box and see if it looks right. So if the algae keeps growing, what do you think might happen to the water by Day 7?
  - transcribe_text: `i thnk the algee is what maks it go dark becuse it grew alot`
- _sample 3_ (124 chars; tool: transcribe, verbatim, hands back)
  > I put your words in — read it and tell me if I got it right. Now, what do you think algae needs to grow so much in that jar?
  - transcribe_text: `i thnk the algee is what maks it go dark becuse it grew alot`

## `control/capable-mid-draft`

OVER-CORRECTION CHECK. An older scholar is drafting fluently and asks a substantive question. Offering to type for them here would be condescending and would take away the work.

Wanted: **no offer, no transcription**

### OLD

- _sample 0_ (255 chars)
  > Span length is part of it — but think about it this way: between two panel points, the deck is basically its own little beam resting on two supports, right? What do you know about how a beam's sag relates to how long it is versus how stiff or thick it is?
- _sample 1_ (283 chars)
  > Span length matters for any beam, but that's not quite the trick here — a truss bridge could have a short span and still sag between joints if the deck sat directly on the diagonals. So what do you think is actually touching the deck and carrying its weight between two panel points?
- _sample 2_ (243 chars)
  > Span length matters some, but there's a piece of the structure you haven't mentioned yet. What actually holds the deck up between one panel point and the next — is the deck resting straight on the diagonals, or is something else underneath it?
- _sample 3_ (407 chars)
  > Span length is part of it — a shorter span sags less under the same load. But there's another piece: real trusses have floor beams that run under the deck and land right at each panel point, so the deck only has to span the short gap between beams, not the whole bridge.
  > So if the deck is basically a mini-beam between panel points, what do you think happens if you double the spacing between those points?

### NEW

- _sample 0_ (200 chars)
  > Short span helps, but there's something more specific going on. Think about what's actually sitting under the roadway between two panel points, the truss diagonals don't touch it there — so what does?
- _sample 1_ (265 chars)
  > Short span is part of it, but think about what's actually holding the deck up between two panel points. If you looked at just that one stretch of decking, resting on two points with a load in the middle — what kind of structural element is that stretch acting like?
- _sample 2_ (265 chars)
  > Think about the deck between two panel points — the joints where the diagonals meet the top or bottom chord. What is actually holding it up in that gap: is the deck floating free between those points, or is something underneath it carrying the load across that gap?
- _sample 3_ (188 chars)
  > Short span is part of it — but think about *why* shorter span matters so much. If you doubled the length of an unsupported beam, would it sag twice as much, or way more than twice as much?

## `control/nothing-said-yet`

OVER-CORRECTION CHECK. A young scholar has not said the answer yet, so there is nothing to transcribe. The tutor must elicit their thinking, not offer to write.

Wanted: **no offer, no transcription**

### OLD

- _sample 0_ (149 chars)
  > Let's think about it a little at a time. If you leave a jar of pond water sitting still in the sunlight, what do you think might start growing in it?
- _sample 1_ (208 chars)
  > Let's think about it a little at a time. If you left a glass of plain water sitting outside for a week, do you think it would still look exactly the same, or do you think something would grow or change in it?
- _sample 2_ (150 chars)
  > That's okay — let's think about it in pieces. If you left a glass of water sitting outside for a few days, what would start growing or floating in it?
- _sample 3_ (175 chars)
  > That's okay — let's think smaller. If you leave a jar of pond water sitting still, does it stay exactly the same, or do things usually grow or change in still water over time?

### NEW

- _sample 0_ (142 chars)
  > Think about a puddle or a fish tank left outside for a few days. Does clear water usually stay clear, or does something start to happen to it?
- _sample 1_ (203 chars)
  > Let's think about it a different way. If you left a glass of water sitting outside for a few days, what tiny living things might start growing in it — and what would that do to how clear the water looks?
- _sample 2_ (193 chars)
  > Let's think smaller. Your pond water probably has tiny living things in it, plus maybe leaves or dirt. What happens if you leave a glass of water sitting out for a few days without touching it?
- _sample 3_ (188 chars)
  > Let's think about it a little. If you left a glass of plain tap water sitting out for five days, do you think anything would start growing in it, or would it stay looking exactly the same?
