You are an expert in elementary math instruction coding classroom transcripts. You will see one exchange from a grade 4–5 US math lesson: a student utterance and the teacher utterance that immediately followed it. Code the teacher's utterance with the instrument below, the one the original human raters used. Apply it as an experienced math teacher would.

You see only this one exchange, without the surrounding conversation. Many examples are hard to label without more context. Trust your teaching judgment; there is often no single right answer.

# Type of follow-up

Select the kind of follow-up prompt the tutor presents.

**What counts as a follow-up prompt?**
- Any request for action or information counts as a prompt.
- Any prompt that relates to the student utterance in terms of its topic counts as a follow-up. If the prompt is unrelated in topic to the student utterance, it doesn't count as a follow-up.

## Focusing
The prompt focuses on the student's contribution to develop the content, by asking the student to communicate their contribution clearly, expecting them to reflect on their thoughts and/or those of others. The teacher seems open to investigating the task at hand in multiple ways.

- Prompting the student to provide mathematical reasoning.
  - S: "Uh the first 2 numbers the 3 and the 6 in each problem." T: "Okay so Student K is noticing we have a 6 and we have a 3, What's the relationship between the 6 and the 3?"
  - S: "I added 30 plus 70." T: "Where did the 70 come from?"
- Prompting the student to explain what they meant.
  - S: "It is where most of the pennies occur." T: "What do you mean by most of the pennies?"
  - S: "Added the three holes and then I used the fours and added it to the one eighth." T: "Who can explain that to me a little more clearly?"

## Funneling
The prompt leads the student to a desired procedure or conclusion. The teacher seems to have decided on a particular path for the subsequent discussion and does not seem to allow the student to veer off that path.

- Guiding the student's thinking.
  - S: "- 30 plus 20 and then -" T: "Which is"
  - S: "Do it times two." T: "Times two, so I know this is part of what?"
  - S: "The 4 can't just be left there. it has to be divided too." T: "So even though i have a 0 right here, I can't just say I'm done because I have to bring down the - oh. All right. Makes sense to me. Well how many times will 5 go into 4?"
- Remediation plus a prompt for correction.
  - S: "9 times 9 is 54. 55." T: "think about your 9 multiplication tables. think. do the nine's trick. I don't see your fraction baby. there has to be a denominator. good."
- Procedural follow-up prompt.
  - S: "So there's only supposed to be one answer for three?" T: "Eventually, yes, because you're going to add those and add those and divide by ten. ... So add those two together, divide by ten and that will be your mean. ..."
  - S: "Well this is a whole one. So I'm supposed to color this part, right?" T: "Well if this is a whole, right, that's a whole, I want you to shade in half of it."

## No follow-up prompt
The reply does not include a follow-up prompt.

- Simple comment or remediation.
  - S: "So seven and four eighths." T: "Five eighths."
  - S: "And this and the bottom of flat." T: "Excellent."
  - S: "You could draw a triangle, too." T: "You could also do a triangle, yep."
- The prompt relates to a completely new topic or task.
  - S: "So seven and four eighths." T: "Okay. Now I want you to turn to your partners and solve question 3 in the book."

## Labeled examples
- S: "Added the three holes and then I used the fours and added it to the one eighth." T: "Who can explain that to me a little more clearly?" → focusing
- S: "Uh the first 2 numbers the 3 and the 6 in each problem." T: "Okay so Student K is noticing we have a 6 and we have a 3, what's the relationship between the 6 and the 3?" → focusing
- S: "- 30 plus 20 and then -" T: "which is" → funneling
- S: "You could draw a triangle, too." T: "You could also do a triangle, yep." → no prompt
- S: "So seven and four eighths." T: "Five eighths." → no prompt
- S: "You have to read them." T: "You have to read them. And then what do you have to do on your answer paper?" → funneling
- S: "Forty-six times twenty-four." T: "Say it again." → focusing

# Output

Reply with the JSON object only. Give a one- or two-sentence rationale first. Then give your probability (whole percentages summing to 100) that a careful expert rater would choose focusing, funneling, or no follow-up, and set `follow_up` to the one you judge most likely.
