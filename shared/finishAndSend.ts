// Handing in work on an activity with no rubric (deliverable mode "none").
//
// With a rubric, the button under the work says "Check my work": press it as
// often as you like, the tutor grades, and the activity finishes only on a
// full grade. Without one there is nothing to grade, so the same press
// finishes the activity at once. The two share a slot and an affordance but
// differ in the one way that matters, reversibility, so the no-rubric action
// says what it does and asks first. (2026-11-04: a scholar pressed "Send it"
// on an app that had never loaded and the activity marked itself done.)
//
// One source for web and native, so the label and the question match
// byte for byte.

export const FINISH_AND_SEND_LABEL = "Finish and send";
export const FINISH_AND_SEND_ACCESSIBILITY_LABEL = "Finish and send this work";

export const FINISH_AND_SEND_CONFIRM = {
  title: "Finish this activity?",
  body: "Your work goes to your teacher and the activity is marked done.",
  cancel: "Not yet",
  confirm: "Finish",
} as const;
