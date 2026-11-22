import { describe, expect, it } from "vitest";
import { buildReader, linkRulesPassively, mapAppCode, openParts, readerBlocks, ruleNote, scanJsLines } from "./appCodeMap";

const tiles = (src: string, rules?: { name: string; value: unknown }[]) => {
  const m = mapAppCode(src, { rules });
  let next = 0;
  for (const p of m.parts) {
    expect(p.start).toBe(next);
    expect(p.end).toBeGreaterThanOrEqual(p.start);
    next = p.end + 1;
  }
  expect(next).toBe(m.lines.length);
  return m;
};

// A race app shaped like the builder's real output: rules table, a helper
// that decides with them, a loop, drawing, and bridge plumbing.
const RACE = `<!DOCTYPE html><html><head><style>
#track{background:#7cc576}
</style></head><body>
<button id="go">Start race</button>
<script>
const racers=[
{name:"Cheetah",speed:20,power:"Sprint"},
{name:"Turtle",speed:5,power:"Shell boost"},
{name:"Horse",speed:15,power:"Gallop"}];
const rh=window.rabbithole;
function pub(p){rh&&rh.setState(p)}
function rulesList(){return racers.map(r=>({name:r.name+" speed",value:r.speed}))}
function speedAt(r,t){if(r.power==="Sprint"&&t<2)return r.speed*2;return r.speed}
function step(){racers.forEach(r=>{r.x+=speedAt(r,1)});requestAnimationFrame(step)}
function draw(){racers.forEach(r=>{r.el.style.left=r.x+'px'})}
document.getElementById('go').onclick=step;
</script></body></html>`;

const RULES = [
  { name: "Cheetah speed", value: 20 },
  { name: "Turtle speed", value: 5 },
  { name: "Cheetah power", value: "Sprint" },
  { name: "Turtle power", value: "Shell boost" },
];

describe("mapAppCode", () => {
  it("tiles every line and folds the page around the script", () => {
    const m = tiles(RACE);
    expect(m.parts[0]).toMatchObject({ lang: "html", title: "Colors and layout" });
    expect(m.parts[1]).toMatchObject({ lang: "html", title: "What's on the screen" });
  });

  it("without published rules, opens the rules table and every 'when' part", () => {
    const m = tiles(RACE);
    const open = openParts(m);
    const titles = m.parts.filter((p) => open.has(p.start)).map((p) => p.title);
    expect(titles).toEqual(["Numbers in your game", "rulesList", "speedAt", "step"]);
  });

  it("with published rules, opens only the rules and the code that decides with them", () => {
    const m = tiles(RACE, RULES);
    const open = openParts(m);
    const titles = m.parts.filter((p) => open.has(p.start)).map((p) => p.title);
    // rulesList only copies values out; draw only places sprites.
    expect(titles).toEqual(["Numbers in your game", "speedAt"]);
  });

  it("doesn't open code that only glues a rule's value into text", () => {
    const src = RACE.replace(
      "function draw()",
      "function card(r){el.innerHTML='<b>'+r.name+'</b> speed '+r.speed+'<br>'}\nfunction draw()",
    );
    const m = tiles(src, RULES);
    const open = openParts(m);
    expect(m.parts.filter((p) => open.has(p.start)).map((p) => p.title)).toEqual(["Numbers in your game", "speedAt"]);
  });

  it("finds each rule's starting value on its line", () => {
    const m = mapAppCode(RACE, { rules: RULES });
    const at = (name: string) => [...m.ruleLines].find(([, names]) => names.includes(name))?.[0];
    expect(m.lines[at("Cheetah speed")!]).toContain('name:"Cheetah",speed:20');
    expect(m.lines[at("Turtle power")!]).toContain('"Shell boost"');
  });

  it("uses the builder's own comment as a title", () => {
    const src = RACE.replace("function speedAt", "// how fast a racer goes right now\nfunction speedAt");
    const part = tiles(src).parts.find((p) => p.title.startsWith("how fast"))!;
    expect(part).toMatchObject({ kind: "when", titleIsCode: false });
  });

  it("does not split inside a multi-line block", () => {
    const js = tiles("<script>\nfunction tick(){\nif(a){\nb();\n}\n}\n</script>").parts.filter((p) => p.lang === "js");
    expect(js).toHaveLength(1);
  });

  it("handles a script that starts on the tag's line", () => {
    tiles(`<html><body><script>const x=1;\nfunction go(){if(x)y()}</script></body></html>`);
  });
});

describe("linkRulesPassively", () => {
  it("leaves a rule unlinked when two lines fit it equally", () => {
    const lines = ["{name:'Horse',speed:7}", "{name:'Falcon',speed:7}"];
    const { ruleLines } = linkRulesPassively(lines, [{ name: "Power lasts", value: 7 }]);
    expect(ruleLines.size).toBe(0);
  });
});

describe("call sites", () => {
  it("shows the lines that run a part, verbatim, and skips strings", () => {
    const m = mapAppCode(RACE, { rules: RULES });
    const site = (name: string) => m.parts.find((p) => p.title === name)?.calledFrom;
    expect(site("speedAt")).toEqual(["function step(){racers.forEach(r=>{r.x+=speedAt(r,1)});requestAnimationF…"]);
    expect(site("step")).toEqual(["document.getElementById('go').onclick=step;"]);
    // "Sprint" mentions inside strings never count as calls
    const src = RACE.replace('const rh=window.rabbithole;', 'const rh=window.rabbithole;const tip="press step to go";');
    expect(mapAppCode(src).parts.find((p) => p.title === "step")?.calledFrom).toEqual(["document.getElementById('go').onclick=step;"]);
  });

  it("cuts a long line around the mention", () => {
    const pad = "x".repeat(200);
    const m = mapAppCode(`<script>\nfunction go(){if(a)b()}\nconst q="${pad}";btn.onclick=go;const z="${pad}";\n</script>`);
    const [site] = m.parts.find((p) => p.title === "go")!.calledFrom!;
    expect(site).toContain("btn.onclick=go");
    expect(site.length).toBeLessThanOrEqual(74);
  });
});

describe("readerBlocks", () => {
  it("opens the rules and their users, and folds each run under the names inside", () => {
    const blocks = readerBlocks(mapAppCode(RACE, { rules: RULES }));
    expect(blocks.map((b) => [b.kind, b.kind === "part" ? b.part.title : b.title])).toEqual([
      ["rest", "Page style and layout"],
      ["part", "The rules"],
      ["rest", "rh, pub, rulesList"],
      ["part", "speedAt"],
      ["rest", "step, draw"],
    ]);
    // the blocks still tile the file
    let next = 0;
    for (const b of blocks) {
      expect(b.start).toBe(next);
      next = b.end + 1;
    }
    expect(next).toBe(RACE.split("\n").length);
  });
});

describe("ruleNote", () => {
  it("says where the rule starts, who set it, and where it changes", () => {
    expect(ruleNote("Cheetah speed", "9", { value: 9, by: "guess" })).toBe(
      "Cheetah speed starts at 9. I picked this one. Change it on its card in your app.",
    );
    expect(ruleNote("Turtle speed", "2", { value: 6, by: "scholar" })).toBe(
      "Turtle speed starts at 2. It's 6 now. You set this one. Change it on its card in your app.",
    );
  });
});

describe("buildReader", () => {
  it("finds rules by their starting value even after a scholar changed them", () => {
    const now = [{ name: "Cheetah speed", value: 30, by: "scholar" }];
    const start = [{ name: "Cheetah speed", value: 20, by: "guess" }];
    const r = buildReader(RACE, now, start);
    const line = [...r.map.ruleLines].find(([, n]) => n.includes("Cheetah speed"))![0];
    const tok = r.tokens.get(line)!.find((t) => t.text === "20")!;
    expect(r.ruleFor(line, tok)).toBe("Cheetah speed");
    expect(r.noteFor("Cheetah speed")).toBe(
      "Cheetah speed starts at 20. It's 30 now. You set this one. Change it on its card in your app.",
    );
  });
});

describe("buildReader with repeated values", () => {
  const SRC = '<script>\nconst ball={name:"Ball",speed:5,size:5};\nfunction move(b){if(b.speed>1)b.x+=b.speed}\n</script>';
  const fives = (rules: { name: string; value: unknown }[]) => {
    const r = buildReader(SRC, rules, rules);
    const line = 1;
    return r.tokens.get(line)!.filter((t) => t.text === "5").map((t) => r.ruleFor(line, t));
  };

  it("gives each value the rule named by its key", () => {
    expect(fives([{ name: "Ball speed", value: 5 }, { name: "Ball size", value: 5 }])).toEqual(["Ball speed", "Ball size"]);
  });

  it("tints nothing it can't tell apart", () => {
    // Only "Ball speed" is published: the size's 5 must not claim it.
    expect(fives([{ name: "Ball speed", value: 5 }])).toEqual(["Ball speed", undefined]);
    // A rule named without its field: two 5s, no way to choose.
    expect(fives([{ name: "Ball bounce", value: 5 }])).toEqual([undefined, undefined]);
  });
});

describe("statement splitting", () => {
  it("keeps a multi-line comment with the function under it", () => {
    const src = RACE.replace("function speedAt", "// how fast a racer goes\n// right now, with its power\nfunction speedAt");
    const part = tiles(src, RULES).parts.find((p) => p.title === "how fast a racer goes")!;
    expect(part.kind).toBe("when");
    expect(src.split("\n").slice(part.start, part.end + 1).join("\n")).toContain("function speedAt");
  });

  it("never starts a part inside a template string or block comment", () => {
    const src = "<script>\nconst HELP = `\nRace to the finish!\nif (you win) cheer\n`;\n/* notes\nif (a) b\n*/\nfunction go(){if(x)y()}\n</script>";
    const js = tiles(src).parts.filter((p) => p.lang === "js");
    expect(js.map((p) => p.start)).not.toContain(3);
    expect(js.map((p) => p.start)).not.toContain(7);
  });
});

describe("rule values", () => {
  it("reads a negative starting value as one literal and tints it", () => {
    const src = "<script>\nconst jumper={name:'Frog',jump:-12};\nfunction hop(f){f.vy+=f.jump}\n</script>";
    const rules = [{ name: "Frog jump", value: -12 }];
    const r = buildReader(src, rules, rules);
    const tok = r.tokens.get(1)!.find((t) => t.text === "-12")!;
    expect(r.ruleFor(1, tok)).toBe("Frog jump");
  });

  it("does not take 9.5 for 9", () => {
    const lines = ["{name:'Horse',speed:9.5}"];
    expect(linkRulesPassively(lines, [{ name: "Horse speed", value: 9 }]).ruleLines.size).toBe(0);
  });

  it("keeps subtraction as subtraction", () => {
    const [scan] = scanJsLines(["x = a - 3"]);
    expect(scan.tokens.some((t) => t.text === "-3")).toBe(false);
  });
});

describe("scanJsLines", () => {
  it("colors strings, numbers, comments and keywords, across lines", () => {
    const [a, b] = scanJsLines(["const s = 'a{b' + 12; /* open", "still comment */ x"]);
    expect(a.tokens.map((t) => t.kind)).toEqual(["keyword", "text", "string", "text", "number", "text", "comment"]);
    expect(b.tokens[0]).toEqual({ kind: "comment", text: "still comment */" });
    // the brace inside the string does not count toward depth
    expect(b.depth).toBe(0);
  });
});
