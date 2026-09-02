/**
 * The editor.
 *
 * CodeMirror 6, tuned for a nine-to-thirteen-year-old holding an iPad. The
 * tuning is most of the value here; the mount is trivial.
 *
 * Three things matter more than they look:
 *
 * - **iOS smart punctuation is a trap.** The keyboard silently turns `'` into
 *   `’` and `--` into `—`, producing a syntax error whose cause is invisible on
 *   screen — the two characters look nearly identical at 19px. We straighten
 *   them in a transaction filter, before they can ever reach the document, and
 *   say so. This is not a nicety; it is the difference between a kid debugging
 *   their logic and a kid debugging a character they cannot see.
 * - **Autocorrect, autocapitalise and spellcheck must all be off.** iOS will
 *   otherwise capitalise `forward` at the start of a line, and `Forward()` is a
 *   ReferenceError that reads as the machine being arbitrary.
 * - **Reformatting happens on idle, never mid-keystroke.** Fixing indentation
 *   while a thumb is still moving feels like the editor is fighting back.
 */
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  Decoration,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { autoDeclare } from "./runtime";

/**
 * A light theme, deliberately. The surrounding surface is paper-coloured and
 * the room has windows; a dark editor next to a bright canvas makes the eye
 * jump between two exposures all afternoon.
 */
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "#7c3aed", fontWeight: "600" },
  { tag: [t.number, t.bool], color: "#0f766e", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "#b45309" },
  { tag: t.comment, color: "#8b93a1", fontStyle: "italic" },
  { tag: t.function(t.variableName), color: "#1d4ed8", fontWeight: "600" },
  { tag: t.operator, color: "#0e7490" },
  { tag: t.propertyName, color: "#1d4ed8" },
  { tag: t.variableName, color: "#10151c" },
]);

const SMART: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201B]/g, "'"],
  [/[\u201C\u201D\u201F]/g, '"'],
  [/[\u2013\u2014]/g, "-"],
  [/\u2026/g, "..."],
  [/\u00A0/g, " "],
];

const setBlame = StateEffect.define<{ line: number; bad: boolean } | null>();

const blameField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setBlame)) continue;
      if (e.value == null) {
        deco = Decoration.none;
      } else {
        const n = Math.max(1, Math.min(e.value.line, tr.state.doc.lines));
        deco = Decoration.set([
          Decoration.line({
            class: e.value.bad ? "studio-blame" : "studio-step",
          }).range(tr.state.doc.line(n).from),
        ]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface EditorHandle {
  view: EditorView;
  text: () => string;
  setText: (text: string) => void;
  blame: (line: number | null, bad?: boolean) => void;
}

export interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  /** Fires on every keystroke. Cheap — used to mark the recording stale. */
  onChange: (text: string) => void;
  /** Fires after the idle reformat, with any names that gained a `let`. */
  onTidy: (born: string[]) => void;
  /** Fires when iOS smart punctuation was straightened, with what it caught. */
  onStraighten: (caught: string) => void;
  /**
   * "Is something running right now?" The idle reformat asks before rewriting
   * the document: replacing the text mid-playback moves the lines the scrubber
   * is pointing at, so the highlight lands on the wrong statement.
   */
  busy?: () => boolean;
}

export function mountEditor(opts: EditorOptions): EditorHandle {
  const punctuationGuard = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    let caught: string | null = null;
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, ins) => {
      const s = ins.toString();
      let fixed = s;
      for (const [re, to] of SMART) fixed = fixed.replace(re, to);
      if (fixed !== s) caught = s.trim().slice(0, 12) || s;
      changes.push({ from: fromA, to: toA, insert: fixed });
    });
    if (!caught) return tr;
    const what = caught;
    queueMicrotask(() => opts.onStraighten(what));
    return { changes, scrollIntoView: tr.scrollIntoView };
  });

  let tidyTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleTidy = () => {
    if (tidyTimer) clearTimeout(tidyTimer);
    tidyTimer = setTimeout(tidy, 900);
  };

  const view = new EditorView({
    doc: opts.doc,
    parent: opts.parent,
    extensions: [
      lineNumbers(),
      history(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      javascript(),
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      blameField,
      punctuationGuard,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        opts.onChange(u.state.doc.toString());
        scheduleTidy();
      }),
      EditorView.contentAttributes.of({
        autocorrect: "off",
        autocapitalize: "off",
        autocomplete: "off",
        spellcheck: "false",
        "data-gramm": "false",
      }),
      EditorView.theme({
        "&": { height: "100%" },
        ".cm-scroller": { overflow: "auto", overscrollBehavior: "contain" },
      }),
    ] as Extension[],
  });

  /**
   * Tidy indentation and add any missing `let`. Runs only when the scholar has
   * paused, and never while an IME composition is open.
   */
  function tidy() {
    if ((view as unknown as { composing?: boolean }).composing) return;
    // A rewrite mid-run would shift the lines the scrubber is pointing at.
    // Wait; the next keystroke reschedules us.
    if (opts.busy?.()) return;
    const before = view.state.doc.toString();
    const born: string[] = [];
    const declared = autoDeclare(before, born);

    let depth = 0;
    const after = declared
      .split("\n")
      .map((raw) => {
        const l = raw
          .trim()
          .replace(/\s+/g, " ")
          .replace(/ ?([,;]) ?/g, "$1 ")
          .replace(/,\s+$/, ",");
        if (l.startsWith("}")) depth = Math.max(0, depth - 1);
        const out = l === "" ? "" : "  ".repeat(depth) + l;
        depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
        if (depth < 0) depth = 0;
        return out;
      })
      .join("\n");

    if (after === before) return;

    // Keep the caret where the scholar left it rather than at the end, or the
    // next keystroke lands somewhere they did not ask for.
    const head = view.state.selection.main.head;
    view.dispatch({
      changes: { from: 0, to: before.length, insert: after },
      selection: { anchor: Math.min(head, after.length) },
      scrollIntoView: false,
    });
    if (born.length) opts.onTidy(born);
  }

  return {
    view,
    text: () => view.state.doc.toString(),
    setText(text: string) {
      if (tidyTimer) clearTimeout(tidyTimer);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: Math.min(text.length, text.length) },
      });
    },
    blame(line: number | null, bad = false) {
      view.dispatch({ effects: setBlame.of(line == null ? null : { line, bad }) });
    },
  };
}
