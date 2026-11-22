# Fonts for Special Delivery PDF rendering

Static-weight TTFs instantiated from Google Fonts' variable-font sources
(`google/fonts` GitHub repo, OFL-1.1 licensed — see the accompanying
`*-OFL.txt` files) via `fonttools varLib.instancer`. These match the brand
fonts declared in `shared/brand.ts` (Hanken Grotesk) and the Special
Delivery letter's display headline (Playfair Display), so the pdf-lib
render and the browser print preview use the same typefaces.

Only used by `convex/cloudPrintingActions.ts` for embedding real fonts in
the generated PDF (pdf-lib + `@pdf-lib/fontkit`), replacing the previous
StandardFonts.Helvetica* fallback.

Regenerate by downloading the variable font from
`https://github.com/google/fonts/tree/main/ofl/hankengrotesk` /
`.../playfairdisplay` and running, e.g.:

```
fonttools varLib.instancer -q -o HankenGrotesk-SemiBold.ttf HankenGrotesk[wght].ttf wght=600
```

`hankenGroteskBoldStory.ts` is separate: the Story text font, a Latin + Latin
Extended-A WOFF with composite glyphs flattened so satori draws capital kahakō
correctly. Used only by `convex/lib/storyOverlay.ts`; rebuild it with
`scripts/build-story-font.py`, whose header has the exact commands.
