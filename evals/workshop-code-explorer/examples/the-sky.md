> **Curated example** from a real eval run (`npx tsx evals/workshop-code-explorer/run.ts`,
> model `claude-sonnet-5`, flag ON). Lightly framed, transcript unedited.
>
> **What to notice — discovery now works.**
> - **Lists before it guesses.** `list_rabbithole_files("components/sky")` returns
>   the real folder; it opens the real `components/ScholarSky.tsx` and
>   `components/sky/skyVisuals.tsx` — no blind path-guessing.
> - **Quotes the REAL line asked for.** "which line makes the stars twinkle" →
>   the actual `animation: rhTwinkle ...` line + the real `@keyframes rhTwinkle`
>   block, each under ~10 lines, then a plain-language "recipe for one blink."
> - **Cross-language teaching, grounded.** Shows the real `hash01` loop and maps
>   it to Python's `for i in range(...)`, and flags JSX as the unfamiliar part.
> - **Thinking questions throughout** ("what do you think `opacity: .72` controls?").

# Code Explorer transcript — "the-sky"

- Scholar: **Milo** (reading level: grade 6)
- Model: `claude-sonnet-5`
- Tools: `list_rabbithole_files`, `read_rabbithole_file`, `search_rabbithole_code` (real, unauthenticated public fetch)
- Iteration cap: 5 per turn

---

**Rabbithole:**

What's one question you came up with today while exploring the Sky — one you thought was actually pretty good?

### 🧒 Milo

how does the star map actualy get drawn

> 🔧 `list_rabbithole_files(prefix: "components/sky")`

> 🔧 `read_rabbithole_file(path: "components/ScholarSky.tsx")`

<details><summary>📄 tool result (clipped)</summary>

```
Source files under "components/sky":
- components/sky/SkyControlButton.tsx
- components/sky/SkyViewport.tsx
- components/sky/StarDrawer.tsx
- components/sky/TeacherStarPanel.tsx
- components/sky/skyVisuals.tsx
- components/sky/skyZoomContext.ts
- components/sky/usePanZoom.ts
Open any of these with read_rabbithole_file to see the real code.
```

</details>

<details><summary>📄 tool result (clipped)</summary>

```
File: components/ScholarSky.tsx

"use client";

/**
 * ScholarSky — the scholar-facing Interpretive "star chart".
 *
 * Renders the kid's exploration seeds as a constellation of stars (default-on
 * via `seeds.skyForSelf`) — this SUBSUMES the old flat "Next adventures" list.
 * Each star is a suggested exploration; tapping one "flies there" (starts a
 * Quest / session from the seed). Dark mode is the visual shorthand for the
 * Interpretive lens (vs. the daylight Knowledge Tree). See
 * review/learning-lenses-and-quests-master-plan.html.
 *
 * The map is BIG (≈full-height inline, true fullscreen on demand) and
 * TOUCH-NATIVE: pinch-zoom, drag-pan, wheel/trackpad zoom, double-tap zoom,
 * plus +/−/reset buttons as a non-gesture fallback. Tap-vs-drag is
 * disambiguated so a clean tap on a star still "flies there".
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Flex, Spinner, Text, VStack } from "@chakra-ui/react";
import { ArrowsOut, Sparkle } from "@phosphor-icons/react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { haptic } from "@/lib/native";
import { formatRelative } from "@/lib/relativeTime";
…(clipped for readability)
```

</details>

**Rabbithole:**

Good question. There's a math function called `layout` that decides where each star goes. Here's the core of it:

```
const angle = domainAngle.get(s.domain) + (idx - 0.5) * 0.42 + hash01(s._id) * 0.18;
const radius = 0.2 + reach * 0.17 + hash01(s.topic) * 0.05;
const leftPct = 50 + Math.cos(angle) * radius * 74;
const topPct = 50 + Math.sin(angle) * radius * 76;
```

Plain version: every topic you're curious about ("domain," like science or history) gets its own slice of the circle, like a pizza. Inside that slice, each star gets pushed out from the center based on a `reach` number — closer stars are things nearby your interests, farther stars are bigger reaches. There's also a bit of `hash01` sprinkled in, which is a fixed "random-looking" number generated from the star's own ID or topic name — so the position looks scattered and natural, but it's actually the same every time you look at it, not truly random.

Then separate pieces draw the visuals: lines from the center hub out to each star (`ConstellationLines`), the glowing dots themselves (`SkyStar`), and the pan/zoom/touch behavior lives in a different file, `usePanZoom.ts`.

Want to see how the zoom and drag gestures work, or how a star decides to twinkle?

### 🧒 Milo

show me the real code for it

> 🔧 `read_rabbithole_file(path: "components/sky/skyVisuals.tsx")`

<details><summary>📄 tool result (clipped)</summary>

```
File: components/sky/skyVisuals.tsx

"use client";

/**
 * skyVisuals — the shared visual language for every "star chart" surface.
 *
 * One source of truth for the look the Class Galaxy nailed (gentle colored
 * stars, soft glow, a quiet twinkle, labels that sit *just* under the dot) so
 * the scholar's ScholarSky, the teacher Class Galaxy, and the entryway galaxy
 * wall all read as the same sky. Keep layout/interaction in the callers; this
 * file owns only the pixels of a star, a hub, the connecting lines, the
 * palette, the twinkle keyframes, and the per-domain region iconography.
 */

import type { ComponentType } from "react";
import { Box, Image, Text } from "@chakra-ui/react";
import { useSkyZoom } from "./skyZoomContext";
import {
  Atom,
  Bank,
  Brain,
  Compass,
  GlobeHemisphereWest,
  Leaf,
  MathOperations,
  MusicNotes,
  PenNib,
…(clipped for readability)
```

</details>

**Rabbithole:**

That's the actual file — `skyVisuals.tsx`. Here's the twinkle part, the part you asked about:

```
const delay = (hash01("d" + twinkleKey) * 3).toFixed(2);
const dur = (lit ? 4.4 + hash01(...) * 2 : 2.6 + hash01(...) * 2).toFixed(2);
...
animation: `rhTwinkle ${dur}s ease-in-out ${delay}s infinite`,
```

Every star gets its own random-feeling `delay` and `dur` (duration), so they don't all blink in sync — that's what makes it look like a real sky instead of a light show flashing on beat. And stars you've already visited (`lit`) blink slower and softer ("breathe") — see the `lit ? 4.4... : 2.6...` — while new, unexplored ones twinkle faster to catch your eye.

Notice the file's own comment at the top calls this "the shared visual language" — the same star code draws your sky, your teacher's view of the class, and the entryway wall. One recipe, many places.

Anything in there surprise you?

### 🧒 Milo

i know a lil python, how diffrent is this

**Rabbithole:**

Pretty different looking, but the *thinking* is similar. A few things:

**This is JavaScript (actually TypeScript, which is JavaScript with extra labels for what type each thing is).** Python doesn't use curly braces `{ }` for blocks — this language does. Notice things like:

```
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
```

That `for` loop looks a lot like Python's `for i in range(len(s)):` — same idea, walk through each character one at a time. The `: string` and `: number` are just labels saying "this input must be text, this output must be a number" — Python has type hints too, just optional and less strict.

**The weirder part for a Python person: JSX.** Stuff like this:

```
<Box className="rh-star-dot" ... />
```

That's HTML-looking code sitting *inside* a JavaScript function. Python doesn't do that — this is a web framework (React) letting you describe "draw a box here" right next to the math that decides where the box goes.

One thing that'd translate directly to Python: `hash01` is just a function that takes a string and always spits out the same number between 0 and 1. You could write that exact function in Python almost line-for-line.

Want me to show you the pan-and-zoom file next, or is there something specific bugging you about how the Sky behaves?

### 🧒 Milo

which line makes the stars twinkle

**Rabbithole:**

This one, inside `SkyStar`:

```
animation: `rhTwinkle ${dur}s ease-in-out ${delay}s infinite`,
```

That line attaches an animation named `rhTwinkle` to the star's dot — "infinite" means keep doing it forever.

The animation itself is defined separately, up near the top of the file:

```
@keyframes rhTwinkle {
  0%, 100% { opacity: .72; transform: scale(0.9); }
  50%      { opacity: 1;   transform: scale(1.18); }
}
```

Plain version: at the start and end of each cycle, the star is a little see-through and a little small. Halfway through, it's fully bright and stretched slightly bigger. The browser smoothly morphs between those two states over and over — that smooth in-between motion is the twinkle.

Quick question before I move on — what do you think `opacity: .72` versus `opacity: 1` actually controls?
