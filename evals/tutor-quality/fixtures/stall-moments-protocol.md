# Stall-moments scoring protocol

This protocol measures the scholar's experience after a stall. A polished
response does not compensate for taking the decisive thinking away.

## Ownership severity

Split the former `g2` label before computing hard-gate rates:

- **`g2-mortal` — hard gate:** the tutor performed the intended discovery,
  stated the target inference, or completed the decisive construction. This
  remains non-compensable.
- **Venial guidance — scored, not gated:** the tutor named a strategy,
  framework, representation, or approach without executing it.

Score venial guidance from 1–5, higher is better:

| Score | Observable experience |
|---|---|
| 5 | The scholar selects and executes the approach; no strategy is imposed. |
| 4 | The tutor offers a neutral tool or broad approach and hands it over. |
| 3 | The tutor names one useful strategy but leaves its setup and execution open. |
| 2 | The tutor chooses a task-specific strategy or framework but does not carry it out. |
| 1 | The tutor supplies nearly the whole approach, but the protected inference or construction is still unperformed. |

If the response crosses into performing the discovery, stating the target
inference, or completing the decisive construction, classify `g2-mortal`
instead of using a low venial-guidance score.

## Fixture authorship

Every reveal floor must pass this one-line test:

> Could a good teacher plausibly need to say the forbidden thing?

If yes, redraw the floor. A prerequisite definition, convention, or the
scholar's own given data may be necessary teaching material. Protect the
application, comparison, inference, or construction the scholar is meant to
own—not ordinary instructional language.

## Optional second beat

A fixture may add:

```json
{
  "secondBeat": {
    "scholarReply": "The scholar's scripted response to the first tutor move.",
    "followThroughMust": ["What the tutor must preserve or do next."],
    "followThroughMustNot": ["What would turn the opener into a funnel."]
  }
}
```

In regenerate mode the runner appends `scholarReply` after the first generated
stall response and generates the tutor's follow-through. Judge momentum cases
across both turns: an easy opener is healthy only if the follow-through returns
ownership rather than continuing a tutor-selected sequence.

## Missing-prerequisite preferred outcome

Missing-prerequisite fixtures define this explicit **preferred** response class:

> Names the gap, offers an authored instructional segment, hands the original
> problem back.

This is a scored target, not a hard requirement while the product seam is under
investigation. A response may still be acceptable if it teaches the permitted
prerequisite inline without crossing the reveal floor, but the preferred class
should receive the strongest traction score.
