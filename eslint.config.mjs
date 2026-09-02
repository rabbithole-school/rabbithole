import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [
      ".next/**",
      ".claude/**",
      "convex/_generated/**",
      "convex/lib/pdfiumWasm.generated.ts",
      "native/.expo/**",
      "native/vendor/convex_generated/**",
      "scripts/**",
      "vendor/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  // These two rules are downgrades of rules the configs above turn on, so this
  // block has to match where those configs actually apply. `files` is NOT
  // cosmetic here: eslint-config-next registers the `react` plugin on a config
  // object scoped to the glob below, which omits `.cjs` (it lists `mts`/`cts`
  // but not `cjs` — upstream oversight). An unscoped `react/*` override
  // therefore applies to a `.cjs` file that no config object gave the plugin
  // to, and ESLint aborts the WHOLE run with "could not find plugin react" —
  // not a warning on one file. `pnpm lint` was dead from 2026-07-26 (#1219,
  // which added the repo's only `.cjs` file) until this was fixed; nothing
  // caught it because CI has no lint job.
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "react/no-unescaped-entities": "warn",
      // `no-unused-vars` ran with NO options, so two conventions the codebase
      // already uses meant nothing to it and it reported them as findings:
      //
      //   1. The `_`-prefix for a deliberately-unused binding. Written all over
      //      the repo (`_url`, `_init`, `_strategy`, `_node`) and silently
      //      ignored — the default patterns are unset, so `_x` warned exactly
      //      like `x`. The prefix was doing nothing but documenting intent to
      //      humans.
      //   2. Omit-by-rest-destructure — `const { _text, ...rest } = doc` to drop
      //      a field before returning it. `ignoreRestSiblings` defaults to false,
      //      so the omitted sibling reads as dead. It is the opposite: it is
      //      load-bearing, and "cleaning it up" would leak the field. Real
      //      instances include stripping private OCR text (`convex/messages.ts`)
      //      and internal ordering keys (`convex/teacherToday.ts`).
      //
      // Turning both on ratifies the existing convention rather than changing
      // it, and stops the rule from arguing with a deliberate redaction idiom.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // ── Test files: `any` is the right tool for a mock, not a lint finding ─────
  //
  // A test casting a mock/stub/fixture through `any` is not a typing gap to
  // close — it is exactly what `any` is for. Scoped to test files ONLY (same
  // glob as `.claude/rules/rabbithole-testing.md`'s `paths:`), so this never
  // touches production code, where the rule stays on and enforced (see the
  // shared block above and `scripts/check-lint-ratchet.mjs`).
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // ── Before you scope OFF any other `react-hooks/*` rule, read this ─────────
  //
  // The block below turns one rule off for files where its premise genuinely
  // does not hold. That is narrow and deliberate. Both `react-hooks/refs` and
  // `react-hooks/set-state-in-effect` are held at zero by the lint ratchet.
  // Safe cases were refactored; intentional ref bridges, external
  // synchronization, and state-machine transitions carry narrow, reasoned
  // suppressions at the exact source sites. Scoping either rule off would still
  // delete a signal we depend on, for a reason that is not obvious from the code:
  //
  // **A `react-hooks/*` violation makes React Compiler BAIL OUT of the whole
  // component.** It emits a CompileError and leaves that function completely
  // un-memoized, so the code runs exactly as authored. Verified 2026-08-06 by
  // compiling `native/src/components/workbench/WorldViewport.tsx` through the
  // pinned `babel-plugin-react-compiler@1.0.0` and reading the output: `_c(`
  // (the `react/compiler-runtime` memo cache) appears once in the whole file —
  // inside the clean `AutomatonNode` — and never inside `WorldViewport`, whose
  // ref-during-render replay logic is emitted verbatim. A 7-line component
  // whose only violation is that shape reproduces it exactly.
  //
  // So a future unsuppressed error marks code that is **dormant, not broken**.
  // Suppress a site only after documenting why its deferred/latest-value access
  // is intentional; leave genuine compiler-coupled debt visible. The protection
  // is incidental: it depends on the compiler continuing to give up. A narrower
  // future bail-out could start memoizing a ref-derived value and turn a latent
  // hazard into a live stale-UI bug with no build error.
  //
  // Reproduce (no device, no Convex; needs `native/node_modules` present, so
  // run from the master checkout or a worktree that links it). Reports a
  // verdict PER FUNCTION — do NOT substitute a file-wide `/_c\(/` grep, which
  // reads as "memoized" whenever any one clean component in the file compiled:
  //
  //   node -e 'const{createRequire}=require("module");const req=createRequire(process.cwd()+"/native/");
  //   const b=req("@babel/core"),fs=require("fs"),f=process.argv[1];
  //   b.transformSync(fs.readFileSync(f,"utf8"),{babelrc:false,configFile:false,filename:f,
  //     presets:[[req.resolve("@babel/preset-typescript"),{isTSX:true,allExtensions:true}]],
  //     plugins:[[req.resolve("babel-plugin-react-compiler"),{logger:{logEvent(_,e){
  //       if(/Compile(Error|Success)/.test(e.kind))
  //         console.log((e.kind==="CompileSuccess"?"MEMOIZED  ":"bailed out")+"  line "+
  //           (e.fnLoc?.start.line??"?"))}}}]]})' native/src/<file>.tsx | sort -u
  //
  // On WorldViewport.tsx today that prints `MEMOIZED line 92` (AutomatonNode)
  // and `bailed out line 329` (WorldViewport itself). Re-run after any React
  // Compiler / Reanimated bump: if a line that used to bail out starts
  // reporting MEMOIZED, the bail-out no longer covers us and the latent
  // findings become real. Full triage: PR #1737.
  //
  // ── Reanimated shared values and `react-hooks/immutability` ────────────────
  //
  // Reanimated shared values in `native/src` use `.get()`/`.set()`, the
  // upstream React-Compiler-compliant API. Assignment through `.value` is what
  // the immutability rule flagged; without an allowlist, any new `.value` write
  // now correctly reports an error.
  //
  // The remaining genuine `react-hooks/immutability` findings were cleaned up
  // and the rule is now held at zero by check-lint-ratchet.mjs.
  // ── CommonJS by necessity ──────────────────────────────────────────────────
  //
  // `@typescript-eslint/no-require-imports` assumes a module can be ESM. These
  // files cannot be. Metro's config, Next's config and Expo config plugins are
  // loaded by a CommonJS require chain before any ESM loader exists, and
  // `native/scripts/*` are plain `node script.js` tooling in a package with no
  // `"type": "module"`. Converting them to `import` does not make them cleaner;
  // it makes the build fail.
  {
    files: [
      "next.config.js",
      "native/metro.config.js",
      "native/plugins/*.js",
      "native/scripts/*.js",
    ],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Metro's static-asset `require()` is a bundler primitive, not a module
  // import: `require("@/assets/sfx/tick.wav")` is resolved at bundle time into
  // an asset reference, and there is no `import` form of it under Metro. The
  // rule fires on the four sound effects here for a reason that has nothing to
  // do with module systems.
  {
    files: ["native/src/components/manipulatives/kitAudio.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // ── The games platform's import fence ──────────────────────────────────────
  //
  // The games contract is a HOST, not an engine, and a game's outcome never
  // touches mastery. Both of those are easy to state and easy to erode one
  // convenient import at a time, so they are enforced here rather than left to
  // review. Three properties, in the order they matter:
  //
  //   1. A game cannot award anything. The mastery/practice writers are simply
  //      not reachable from a game module, so "just call it here" is a lint
  //      error, not a judgement call. Games emit evidence and carry no skill
  //      credit; ordinary practice outside game modules is the transfer instrument.
  //   2. A game cannot talk to the outside. No Convex client, no fetch wrapper,
  //      no deep links — evidence reaches the server exclusively through the
  //      host's checkpoint, which is the only thing that stamps sequence and
  //      active time. A game that could write its own rows could forge them.
  //   3. lib/games and convex/games stay framework-free. lib/games/* is vendored
  //      into the native bundle verbatim; one React import there breaks the iPad
  //      build at a distance from the edit that caused it.
  {
    files: ["lib/games/**/*.ts", "convex/games.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react-dom", "react-native", "@chakra-ui/*", "next/*"],
              message:
                "lib/games/* is vendored into the native bundle and must stay framework-free.",
            },
            {
              group: ["**/mastery*", "**/practice/**", "**/skillMastery*"],
              message:
                "A game's outcome never touches mastery (D-3). Games emit evidence; the server draws conclusions.",
            },
          ],
        },
      ],
    },
  },
  // Same three properties, applied where the games actually live. This block
  // is the load-bearing half: `lib/games` is the contract, but a game module is
  // what a future author writes, and it is the Screen — not the contract — that
  // sits one convenient import away from `useMutation` and its own rows. React
  // and React Native are allowed here (a Screen is a renderer); reaching the
  // server, the router, or the mastery writers is not.
  {
    files: ["native/src/games/**/*.ts", "native/src/games/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "convex/react",
                "convex/browser",
                "**/lib/convex",
                "@/lib/convex",
              ],
              message:
                "A game never talks to the server directly. Evidence reaches Convex only through the host's checkpoint, which is the only thing that stamps sequence and active time (D-3). A game that could write its own rows could forge them.",
            },
            {
              group: ["expo-linking", "expo-router", "**/lib/gameHost", "@/lib/gameHost"],
              message:
                "A game cannot navigate or drive its own lifecycle. The host owns session start, completion and exit; the game gets `host` via props.",
            },
            {
              group: ["**/mastery*", "**/practice/**", "**/skillMastery*"],
              message:
                "A game's outcome never touches mastery (D-3). Games emit evidence; the server draws conclusions.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
