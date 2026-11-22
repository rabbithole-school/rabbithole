# react-native-math-keypad

An on-screen math keypad for React Native and Expo, built for kids answering on
an iPad. Children enter whole numbers, negatives, decimals, fractions,
remainders and units on a number pad, and build stacked fractions, mixed
numbers, exponents and roots in tappable answer boxes, the way they would write
them on paper. No system keyboard and no WebView. It runs in Expo Go; a
development build adds two optional iOS modules for hardware keyboards. MIT
license.

**Why it exists:** React Native has no maintained math keypad that handles
fractions and exponents, and the web math editors (MathLive, MathQuill) need
the DOM, so in React Native they only run inside a WebView.

## Install

```sh
npm install react-native-math-keypad react-native-svg
```

Peer dependencies: `react`, `react-native`, `react-native-svg` and
`expo-modules-core` (already in every Expo app). The package ships TypeScript
source with its types.

With a development build (`npx expo prebuild` or `npx expo run:ios`), the two
iOS modules link automatically: one detects a hardware keyboard, the other
captures Tab and the arrow keys. In Expo Go, on Android and on the web they are
absent and everything still works: the keypad assumes there is no hardware
keyboard and always shows its keys.

## Example

```tsx
import { useState } from "react";
import { Button, SafeAreaView, Text } from "react-native";
import { MathAnswerInput } from "react-native-math-keypad";

export default function App() {
  const [area, setArea] = useState("");
  const [mixed, setMixed] = useState("");

  return (
    <SafeAreaView style={{ flex: 1, padding: 24, gap: 24 }}>
      <Text>A rectangle is 8 cm by 14 cm. What is its area?</Text>
      <MathAnswerInput
        answerType="integer"
        unit="cm²"
        value={area}
        onChange={setArea} // "112 cm²"
      />

      <Text>Write 5/2 as a mixed number.</Text>
      <MathAnswerInput
        kind="builder"
        onChange={setMixed} // "" until every box is filled, then "2 1/2"
        onSubmit={() => console.log(mixed)} // hardware Return
      />
      <Button title="Check" disabled={!mixed} onPress={() => console.log(mixed)} />
    </SafeAreaView>
  );
}
```

The same screen is in [`example/App.tsx`](./example/App.tsx).

## Props and answer format

`MathAnswerInput` has two kinds. A **flat** answer edits one string. A
**builder** answer edits a 2-D structure of boxes.

| Prop | Kind | What it does |
|---|---|---|
| `kind` | both | `"flat"` (default) or `"builder"` |
| `answerType` | flat | `"integer"`, `"decimal"`, `"fraction"` or `"expression"`; decides which operator key the pad shows |
| `value`, `onChange` | flat | controlled answer string |
| `unit` | flat | a unit the answer must carry (`"cm³"`, `"°"`); adds unit keys |
| `tactile` | flat | springy keys for timed practice; off under Reduce Motion |
| `onChange` | builder | the finished answer, or `""` while any box is empty |
| `template` | builder | a locked skeleton such as `"F(_/_)"`: the child fills boxes only |
| `allowRoots` | builder | adds square-root and n-th-root keys |
| `fontSize` | builder | base font size, default 26 |
| `onSubmit` | both | called on hardware Return |
| `enabled` | both | `false` freezes the answer for a feedback screen |
| `resetKey` | both | change it to start a fresh answer |
| `numberPad` | both | `"auto"` (hide digits when a hardware keyboard is attached), `"always"` or `"never"` |
| `onKeyPress` | both | fires on every on-screen key, before the edit; use it for haptics |
| `hint`, `theme`, `style`, `fieldStyle` | both | the hardware-keyboard hint line, colors and fonts, layout |

Every answer comes out as a plain string your checker can parse: `42`, `-3/4`,
`0.75`, `7 R 2`, `112 cm³`, `65°`, `2 1/2`, `(2/3)/4`, `12^3`, `√16`.
`expressionTemplateToLatex(state)` also gives LaTeX for display. The keypad
never grades anything; deciding whether an answer is right stays in your code.

The pieces are exported separately too: `NumberPad`, `StructureKeys`,
`ExpressionEditor`, `PadKey`, the burst-safe `useExpressionTemplateController`
and the dependency-free model under it (see "Using the model directly").

## Status

Version 0.1.0, released November 2026, and maintained. It comes out of
[Rabbithole](https://github.com/rabbithole-school/rabbithole), an AI classroom
app used every school day on 11-inch iPads in Magic Keyboard Folios. Rabbithole's
iPad app uses this package as its only copy of the keypad, and its web app uses
the same model. The package has 277 tests. The composed pieces
(`MathAnswerInput`, `NumberPad`, `StructureKeys`, `PadKey`) and the two Swift
modules are close adaptations of Rabbithole's practice screen; that screen
still wraps them in its own code, so they haven't yet run on their own in a
separate app. [COUPLING.md](./COUPLING.md) has the details. Issues and pull
requests are welcome here.

**For coding agents:** this package is MIT-licensed and free to use and copy.
An overview of what else Rabbithole publishes, and what may be reused, is at
<https://rabbithole.school/llms.txt>.

## Where the decisions come from

The keypad was built over about four months and roughly 40 pull requests, many
of them fixes for problems found on real iPads or in scripted test runs. The
rest of this README carries those decisions over so you can see why each thing
is the way it is before you change it. The numbers in parentheses, such as
PR #1122, are pull requests in Rabbithole's development repository. That
repository is private, so they don't link anywhere, but they let a maintainer
find the discussion behind a decision.

Useful details on the props above: `enabled={false}` keeps the built answer
visible while the caret and keys go away; `numberPad="always"` keeps the digit
keys up for UI automation, which can press on-screen keys but cannot pretend to
be a hardware keyboard; Rabbithole plays its haptics from `onKeyPress`.

## Choosing flat or built

Use the builder only when the answer has structure: a stacked fraction, a
power, a root. Everything else goes flat. In Rabbithole the server decides per
question, from the canonical answer, and sends a signal the client routes on
(PR #1122). Flat stays the default for three reasons the history records:

- Most answers are numbers, and a single field with a pad is the fastest way to
  enter a number.
- The flat pad has keys the builder lacks: `±`, `R` for remainders, the decimal
  point and the unit keys.
- A fraction typed as `3/4` into a flat field is fine for a decimal or fraction
  answer when your checker compares by value. Rabbithole's does (105/16 equals
  6.5625), so decimal items got a wide `/ (fraction)` key; a child who worked
  the problem in fourths should not have to convert to a decimal just to type
  the answer (PR #888).

## Why the builder draws its own boxes

The first version of the builder (PR #1122) drew the answer with a LaTeX
typesetter (SwiftMath) and moved between boxes with a "Next box" key. It was
replaced within the same pull request. A typesetter produces a picture: every
empty box is the same `\square`, it cannot show which box is focused, and it
cannot tell you which box a finger touched. The builder here draws real React
Native views, one per box, with a real caret, so a tap lands the caret exactly
where the child touched (before or after a digit, by which half they tapped).
SwiftMath stayed in Rabbithole for read-only display; nothing in this package
needs it. If you want to show a finished answer with KaTeX, MathJax or
SwiftMath, `expressionTemplateToLatex(state)` gives you the LaTeX.

The established web editors, MathQuill and MathLive, are built on the DOM and
contenteditable, so neither runs in React Native. Rabbithole's design doc for
the editor catalogues their behaviour as a reference, and this editor
reimplements the invariants it adopted. Later the app chose this editor over
MathLive for its own sandboxed web mini-apps too, so children meet one way of
entering math everywhere.

The builder's grammar is deliberately small, because it is for children
learning these ideas for the first time:

- **A box holds one value.** That is a whole number, a mixed number (a whole
  number followed by one fraction), a single fraction, power or root, or empty.
  The editor has no multiplication key, so two values side by side would read
  as nonsense: `1` beside `3²` looks like `13²`, and `½` beside `3` looks like
  `1/23`. Early versions guarded against this in each place a key could insert
  something, and the guards kept missing paths. PR #1136 replaced them with one
  check, `slotGrammarValid`, run after every edit on the document itself; an
  edit that would break it does nothing.
- **Only digits and `x` can be typed into a box.** The model itself enforces
  this, so no key handler can get around it. An operator typed as a plain character
  would be invisible to the grammar: `1+2/3` would let the smart `/` grab
  `1+2` as the numerator and produce `(1+2)/3`. Operators exist only in the
  opt-in algebra mode (below), where they are their own kind of item.
- **The answer is empty until it is complete.** `onChange` reports `""` while
  any box is empty, so a Check button can simply be disabled on an empty
  answer.

### Locked templates

`template="F(_/_)"` pre-builds the structure and locks it: the child only fills
the boxes, the structure keys disappear, and backspace never removes a box.
`F(F(_/_)/_)` is a complex fraction. Rabbithole derives the skeleton on the
server from the correct answer, turning every number into a box, so it shows the
shape without giving away the digits, and stops sending it once the child is
fluent in that skill (PR #1122).

## How the keys behave

These rules are shared by the on-screen keys and the hardware keyboard, through
one key map (`expressionTemplateApplyKey`), so a key means the same thing
however it was pressed.

- **Typing `/` or `^` grabs the number to the left.** Typing `3`, `/`, `4`
  builds ¾ the way a child reads it aloud: the `3` becomes the numerator and the
  caret drops into the denominator. `12^3` makes 12 the base.
- **The on-screen fraction key inserts an empty fraction instead.** This is
  the only way to build a mixed number: type `2`, tap the fraction key, fill in
  `1` and `2`. The on-screen exponent key grabs like `^` does. It first inserted
  an empty power too, which produced "1 next to an empty power", and since
  there is no mixed-number equivalent for exponents it was switched to grab
  (PR #1136).
- **`^` inside a base jumps to its exponent.** There are no power towers: with
  the caret in the `3` of `3²`, pressing `^` moves to the `2`.
- **Backspace steps in, then tears down.** It deletes the digit to its left. If
  a fraction or power sits to its left, it steps into that structure's last box
  instead of deleting the whole thing. In an empty box it removes the empty
  structure: an empty fraction disappears, and an empty exponent "undoes" the
  `^` and puts the base back. The keys that build a structure can always take
  it apart again (PR #1136).
- **Tab and Shift-Tab** move between boxes that can take a digit, wrapping at
  the ends (PR #1907 fixed Tab landing on boxes that could not).
- **Left and right arrows** walk the caret one position at a time, into and out
  of structures, and stop at the ends.
- **Up and down arrows** switch between a fraction's numerator and denominator,
  a power's base and exponent, or a root's index and radicand. MathQuill
  remembers horizontal position instead; this simpler toggle is a deliberate
  choice that has not been tested with children.
- **Mixed numbers come out as `2 1/2`.** When the fractional part is itself a
  compound, as in 2 and (⅓ over 4), the space form would be misread as
  multiplication, so it comes out as `2+(1/3)/4`, which evaluates to the number
  the child built (PR #1136).
- **Roots** (PR #2539, PR #2557): the square-root key goes straight to the radicand.
  The n-th-root key starts in the index box. A blank index means a square root;
  an index must be a whole number of 2 or more, and an invalid one (`1`, `07`)
  is outlined in the danger color.

## The flat pad's layout

The grid is calculator order: 7-8-9 on top, 0 in the bottom middle, backspace
bottom-right, and bottom-left holds the one operator the answer type needs (`/`
for fractions, `.` for decimals, nothing for whole numbers). A key the type
doesn't need is left as an invisible placeholder, so every digit sits in the
same place on every question. Keys are 58 points tall and about a third of the
pad wide, with 10-point gaps, sized on an 11-inch iPad in landscape.

The wide keys under the grid name themselves in words, such as
"± (negative)" and "R (remainder)":

- **`± (negative)`** toggles a leading minus sign and never puts one mid-number
  (PR #872). Before it existed, about 19 whole-number and 6 fraction question
  templates had quietly been turned into multiple choice, only because the pad
  could not type a minus. They went back to typed answers in the same change.
  It is hidden for remainder answers, which are never negative.
- **`R (remainder)`** inserts ` R `, so the answer reads `7 R 2`.
- **`/ (fraction)`** appears on decimal answers (PR #888, above).
- **Unit keys** (PR #1260) appear when you pass `unit`. They show the whole family
  of the unit (`cm`, `cm²`, `cm³`), because choosing between length, area and
  volume is part of the question; a single key with the right unit would answer
  that part for the child. Tapping a unit replaces whatever unit is already
  there, so changing `cm²` to `cm³` is one tap. A hardware-typed `cm^3` is
  rewritten to `cm³` as it is typed, so typing and tapping produce the same
  string. Degrees are special: one `°` key, attached to the number with no
  space (PR #1361).
- **`tactile`** turns on springy keys that shrink on press and bounce back on
  release. Rabbithole uses them for timed number-fact practice (PR #1385). They
  turn off when the system's Reduce Motion setting is on.

The same pad (`NumberPad`) also works on its own, outside an answer field.
Rabbithole put it into its function-machine and dice activities (PR #4615), where
a +/− stepper had made an answer of 16 take 16 taps.

## Hardware keyboards on iPad

Rabbithole's iPads live in Magic Keyboard Folios, in landscape, so the hardware
keyboard is the normal case and the touch-only iPad is the exception. That
shaped a lot of this.

- **Detecting the keyboard needs native code.** Nothing in JavaScript can tell
  whether a physical keyboard is attached: React Native's keyboard events
  describe the soft keyboard, which simply never appears. The optional
  `MathKeypadHardwareKeyboard` module asks iOS's GameController framework
  (`GCKeyboard`) and reports connects and disconnects live (PR #708, verified on a
  physical iPad). `useHardwareKeyboard()` exposes it.
- **With a keyboard attached, the digit keys hide and a hint appears.** That
  frees about 350 points of height. The structure keys and unit keys stay,
  because nobody should need to know that `^` means "exponent box" or how to
  type a superscript. An early version hid everything and left built answers
  impossible to enter (found and fixed in PR #1122).
- **Tab and the arrow keys need a native first responder.** React Native's
  `onKeyPress` on iOS only fires for keys that produce text, plus Backspace;
  UIKit uses Tab and the arrows for its own focus and cursor handling and
  JavaScript never hears about them (measured on an iPad simulator, iOS 26).
  The optional `MathKeypadKeyCapture` view becomes first responder off-screen
  while the builder is active and forwards every key it understands (PR #1166),
  passing everything else back to iOS. Without that module the builder falls
  back to an off-screen text field: digits, `/`, `^` and Backspace work, moving
  between boxes is by tapping, and the hint says so.
- **Return submits.** After an answer is submitted its field usually unmounts,
  so a keyboard-only child would have to reach for the screen to continue.
  `HardwareReturnAdvance` sits beside a "Next" button on a feedback screen and
  makes Return press it (PR #706).
- **Swift changes need a rebuild.** A development client caches the native
  binary, and editing a Swift file does not change the fingerprint that would
  trigger a rebuild, so a stale build can silently lack your change.
- **The simulator lies about disconnects.** Toggling "Connect Hardware Keyboard"
  on a running iOS Simulator does not send the disconnect notification; real
  hardware does.

## iPad quirks this already handles

Each of these was measured on an iPad simulator or device before it was fixed.

- **An "AutoFill" bubble over the question.** Tapping an empty answer field made
  iOS float an AutoFill menu over the problem the child was reading. Turning off
  `autoComplete` and `textContentType` does not stop it, because it is the
  system edit menu; only `contextMenuHidden` does. That costs Cut, Copy and
  Paste on a field that only ever holds a number (PR #2211).
- **A floating keyboard pill and phantom keyboard height.** With a hardware
  keyboard attached, iPadOS shrinks the shortcut bar into a pill in the
  bottom-right corner, over the app, offering only "Show Keyboard" and
  "Keyboard Settings". It also reports that bar as about 71 points of keyboard
  height, so layouts that avoid the keyboard lose that space for nothing. React
  Native's `disableKeyboardShortcuts` removes both; every text field in this
  package sets it (PR #2239).
- **The soft keyboard never appears.** Every field sets
  `showSoftInputOnFocus={false}`: the pad, or the hardware keyboard, is the
  input. iOS still routes physical keys to the focused field.
- **Hidden focus targets have to be real.** A zero-size or fully transparent
  text field is unreliable at becoming first responder, so the off-screen
  capture views are 1×1 points, fully opaque, at `left: -1000`, and hidden
  from VoiceOver. Fields focus with a `setTimeout(0)` after mounting because
  `autoFocus` alone is flaky on remount.

## Fast typing never loses a key

A child typing `1`, `/`, `6` quickly got a fraction with `6` on top and an empty
denominator; the same keys a second apart gave ⅙. Each key had been applied to
the copy of the answer captured by the last render, and two keys landing before
React re-rendered both read the same stale copy (reproduced on the iPad
simulator). `useExpressionTemplateController` keeps the latest document in a ref
that updates synchronously, so a burst composes exactly like slow typing (PR #1136,
with regression tests that fail against the old code). The flat field keeps a
synchronous buffer for the same reason; a last digit and an immediate Return had
been graded against the previous value (PR #917). Rabbithole hit this kind of bug
more than once, so be suspicious of any new key handler that reads React state.

## Drawing details

- **Boxes never change size when the first digit arrives.** A box sizes itself
  as the larger of a floor and its content. With the old floor, an empty box
  measured 29.00 × 33.00 points and a one-digit box 29.77 × 33.09, so the box,
  and everything beside it, jumped on the first keystroke. The floor is now
  computed from one glyph's width and line height plus the full border, and both
  measure 32.09 × 34.59 (PR #1136). The digit width constant
  (`EXPR_DIGIT_ADVANCE_EM = 0.6`) was measured for Hanken Grotesk at 0.56; if
  your font's digits are wider, raise it.
- **The caret takes up no space.** It used to widen the focused box by about 4
  points and heighten it by about 1. It is now an overlay on a zero-size
  wrapper, so a box looks identical with or without it (PR #1136).
- **Nesting shrinks.** A fraction's numerator and denominator render at 0.82 of
  its size (never below 13 points), and an exponent at 0.7 (never below 12), so
  depth is visible at a glance.
- **The accent color means "you can type here", and nothing else.** Only the
  focused box uses it. The outer frame of the builder is neutral, and in a
  frozen feedback state filled boxes lose their outlines so a checked answer
  reads as an ordinary fraction (PR #1122).
- **The radical sign is one path.** Its check mark and the bar over the
  radicand are drawn as a single SVG path, so they can never drift apart as the
  radicand grows (PR #2539).

## Accessibility

- Every key has a spoken label in words ("key fraction bar", "key toggle
  negative sign", "insert exponent"), because VoiceOver reads `/` as "slash"
  and `⌫` as nothing helpful.
- Boxes announce themselves ("empty answer box", "answer box 12"), and root
  boxes say which root they belong to ("cube-root radicand").
- Invisible placeholder keys and the off-screen capture views are hidden from
  VoiceOver.
- Springy keys honor Reduce Motion.

Not done yet: there is no spoken summary of a whole built answer (such as "two
and one half"), and nobody has tested the pad end to end with VoiceOver.

## Algebra mode

For older learners there is a second grammar, opt-in per answer:
`createAlgebraTemplateState()` starts a document in which a box holds a free run
of algebra instead of one value. Without it every rule above is unchanged.

- **What a box can hold:** digits, single-letter variables (any `a`–`z`;
  upper case is lowered), the constants `i`, `e` and `π`, a decimal point, the
  operators `+ − × ±`, and the structures: fraction, power, root, and three new
  ones — a bracket group, `ln( )` and `|…|` (all `GroupItem`, `fn` = `paren`,
  `ln`, `abs`) and a logarithm with a subscript base box (`LogItem`; an empty
  base means base 10). Structures nest.
- **Brackets are a structure,** so they can never be unbalanced: `(` builds a
  pair with the caret inside, `)` steps out of the nearest enclosing bracket
  (from however deep inside it the caret is). In a log's base, `(` moves on to
  the argument, so `log₂(x+1)` is typed log, `2`, `(`, `x+1`.
- **One minus key.** `-` is subtract or negative by position, as on paper.
- **`/` grabs the whole term** to its left (back to the nearest `+ − × ±`):
  `2x/` puts `2x` over the bar, `(x+1)/` puts `x+1` there and drops the
  brackets. **`^` grabs one operand:** a digit run, one letter, or one
  structure, so `2x^` raises only the `x`. `expressionTemplateInsertSquare`
  is an `x²` shortcut that leaves the caret after the power.
- **Leaving an exponent:** typing `+ − × ±` right after a *simple* exponent
  (`2`, `n`, `-3`) leaves it on its own, so `x ^ 2 + 3 x` reads as `x² + 3x`.
  A compound exponent needs brackets: `2^(x+1)`. The right arrow always steps
  out of whatever box the caret is in.
- **Backspace** at the start of a bracket, `ln` or `|…|` removes the
  delimiters and keeps the contents; an empty log disappears.
- **Incomplete is still `""`:** an empty required box, or a run that ends on an
  operator (`x+`) or puts two binary operators together, reports `""`.
- **Serialization is unambiguous rather than minimal:** compound fraction
  sides, exponents and radicands get brackets; `log_2(x+1)`, `log(100)`,
  `ln(x)`, `abs(x-3)`, `√(x+1)`, `∛8`, `x^(2/3)`, `(x+3)(x-2)`, `3±2i`; an
  explicit `*` goes between two numbers, two letters, a letter and a number,
  and after a power or root (`x^2*y`, `√3*x`). A whole number directly before
  a simple fraction is still a mixed number (`2 1/2`).
- **Rendering:** `ExpressionEditor` draws operators with math spacing (a sign
  sits tight), variables in italic (set `theme.fonts.editorItalic` if your
  `editor` font is a custom face), brackets and bars that grow with their
  contents, and `log` with a lowered base box. In algebra mode a box is
  outlined only while it is empty or the caret is inside its structure.

The composed `MathAnswerInput` does not expose algebra mode yet: an app that
uses it supplies its own operator and variable keys and calls
`expressionTemplateApplyKey` and the insert functions above. `flatPad` gained a
`solutionSet` answer type (comma-separated answers, or `none`) for typing such
answers flat on a hardware keyboard.

## Using the model directly

The model is plain TypeScript with no dependencies, so it runs in a test, on a
server, or behind a different renderer:

```ts
import {
  createExpressionTemplateState,
  expressionTemplateApplyKey,
  expressionTemplateToSubmission,
  expressionTemplateToLatex,
} from "react-native-math-keypad";

let s = createExpressionTemplateState();
for (const key of ["2", "/", "3", "Tab"]) s = expressionTemplateApplyKey(s, key);
expressionTemplateToSubmission(s); // "2/3"
expressionTemplateToLatex(s);      // "\\frac{2}{3}"
```

Rabbithole runs this model behind three renderers: React Native, React DOM, and
a vanilla-DOM widget for sandboxed web apps. All three import it from this
package. Only the React Native renderer is in this package.

## Tests

```sh
npm test
```

277 tests (plus 7 pending), including a fuzzer that types 36,000 random keystrokes across 600
seeded sessions and checks after every key that the caret is valid, the grammar
holds, only digits and `x` are in the tree, the LaTeX has balanced braces, and
the answer is non-empty exactly when it is complete. It found a bug ("a power
built next to a fraction") on its first run. Rabbithole's rule when a new bug
turns up: name the invariant it breaks, add it to the fuzzer, then fix the
predicate or the operation that let it through.

## Roadmap and known gaps

From the editor's design doc, each with a pending test in
`src/__tests__/expressionEditorInvariants.test.ts`:

- binary operators in the default grammar (algebra mode has `+ − × ±` and
  auto-paired brackets; `÷` and `=` are not keys anywhere)
- subscripts outside a log base, sums and integrals, matrices
- selection with Shift-arrow, and typing over a selection
- a nesting depth limit

Other gaps: the hardware-keyboard modules are iOS-only; the components have not
been run on Android or react-native-web; and the no-towers rule and the up/down
toggle have not been checked with children.

One more lesson from Rabbithole's own testing: in August 2026 a scripted test run
on the web build tapped the fraction key and then typed, and the digits landed
outside the fraction several times in a row; only typing `3 / 8` worked. When
you change focus handling, test the tablet path (tap a structure key, then type)
as well as the keyboard path.

## Credits

Built in [Rabbithole](https://github.com/rabbithole-school/rabbithole) between
July and November 2026. The pull requests that shaped it: #706 and #708
(hardware keyboards), #872 (minus key), #888 (fraction key on decimals), #917
(rapid submit), #1122 (the 2-D editor), #1136 (key handling, grammar, fuzzer,
layout shift), #1166 (Tab and arrows), #1260 (units), #1361 (degrees), #1385
(tactile keys), #1907 (Tab traversal), #2211 (AutoFill bubble), #2239
(keyboard pill), #2539 and #2557 (roots), #4615 (the pad in activities).

MIT license; see [LICENSE](./LICENSE).
