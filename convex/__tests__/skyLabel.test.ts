/**
 * The label tidy for a kid's own Sky (TRA-699, lib/skyLabel.ts): capitals and
 * spacing fixed, a keyboard mash hidden, the kid's spelling left alone. Every
 * string here is made up.
 */
import { describe, expect, test } from "vitest";
import { isKeyboardMash, tidySkyLabel } from "../lib/skyLabel";

describe("tidySkyLabel", () => {
  test("collapses stray spacing and the space before punctuation", () => {
    expect(tidySkyLabel("  why do   owls hoot ?  ")).toEqual({
      label: "why do owls hoot?",
      hidden: false,
    });
    expect(tidySkyLabel("dragons\n\tand  ( fire )").label).toBe("dragons and (fire)");
  });

  test("an ALL-CAPS label becomes sentence case, with I kept", () => {
    expect(tidySkyLabel("WHY IS THE SKY BLUE").label).toBe("Why is the sky blue");
    expect(tidySkyLabel("CAN I BUILD A ROBOT?").label).toBe("Can I build a robot?");
    expect(tidySkyLabel("MY VOLCANO GAME!!").label).toBe("My volcano game!!");
  });

  test("a short acronym and a mixed-case label keep their capitals", () => {
    expect(tidySkyLabel("DNA").label).toBe("DNA");
    expect(tidySkyLabel("How does DNA copy itself?").label).toBe(
      "How does DNA copy itself?",
    );
    expect(tidySkyLabel("my Minecraft city").label).toBe("my Minecraft city");
  });

  test("leaves the kid's spelling alone", () => {
    expect(tidySkyLabel("do sharcks sleep").label).toBe("do sharcks sleep");
    expect(tidySkyLabel("WHY DO CATS PURRR").label).toBe("Why do cats purrr");
    expect(tidySkyLabel("dinosors").hidden).toBe(false);
  });

  test("hides a keyboard mash", () => {
    for (const mash of [
      "asdfghjkl",
      "asdf",
      "sdfjkl",
      "jjjjjjjj",
      "asdkjfhaskdjfh",
      "qwertyqwerty",
      "lkjhgf",
      "fjdkslfjdksl",
      "1 + 1 = ? asdfghjkl",
      "",
      "   ",
    ]) {
      expect(tidySkyLabel(mash), mash).toMatchObject({ hidden: true });
    }
  });

  test("numbers and symbols are a real question, never a mash", () => {
    for (const math of [
      "1 + 1 = ?",
      "2+2",
      "12 × 12 = ?",
      "√16 = ?",
      "3/4 > 2/3 ?",
      "100%",
      "???",
      "7 - 3 = 4!",
    ]) {
      expect(tidySkyLabel(math), math).toMatchObject({ hidden: false });
    }
    expect(tidySkyLabel("1 + 1 = ?").label).toBe("1 + 1 = ?");
  });

  test("odd spelling in a real question stays visible", () => {
    for (const question of [
      "wy do ducks quak",
      "how do u mak slime",
      "whats bigr infinty or a googol",
      "can cats se in the drak",
      "how meny legs does a centipeed hav",
      "do pyramidz have secrit rooms",
    ]) {
      expect(tidySkyLabel(question), question).toMatchObject({ hidden: false });
    }
  });

  test("keeps real titles, one-word ones included", () => {
    for (const real of [
      "Dragons",
      "Minecraft",
      "rhythm game",
      "My strengths",
      "Catchphrase quiz",
      "property of water",
      "Twelfths and fractions",
      "Szczepan's castle",
      "Why do glaciers move?",
      "Kīlauea lava",
      "火山",
      "A",
      "DNA",
    ]) {
      expect(tidySkyLabel(real), real).toMatchObject({ hidden: false });
    }
  });

  test("a label that is half mash or more is hidden; a little mash is not", () => {
    expect(isKeyboardMash("cats asdfghjkl")).toBe(true);
    expect(isKeyboardMash("why do cats and dogs fight sdfg")).toBe(false);
  });

  test("is deterministic", () => {
    expect(tidySkyLabel("HOW BIG IS THE SUN")).toEqual(tidySkyLabel("HOW BIG IS THE SUN"));
  });
});
