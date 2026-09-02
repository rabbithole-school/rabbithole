import { describe, expect, test } from "vitest";
import { quipHtmlToMarkdown } from "../canvasHtml";

// A synthetic quip-style canvas HTML page (NOT real canvas content — public
// repo hygiene). Exercises headings, paragraphs with inline formatting, an
// empty line, a blockquote, unordered + ordered lists, a horizontal rule, a
// <br>, and HTML entities.
const FIXTURE = `<!DOCTYPE html><html><head><style>.x{}</style></head><body>
<div class="quip-canvas-content">
  <h1 id="temp:C:aaa"><span>Spring Info Sessions</span></h1>
  <p class="line">Welcome to <b>Rabbithole</b> &amp; our <i>spring</i> series.</p>
  <p class="line"></p>
  <p class="line">Register at <a href="https://ex.com/e?a=1&amp;b=2">Eventbrite</a>.</p>
  <h2><span>What to bring</span></h2>
  <ul>
    <li class="line">A <b>notebook</b></li>
    <li class="line">Questions</li>
  </ul>
  <blockquote><p class="line">Seats are limited.</p></blockquote>
  <h2>Schedule</h2>
  <ol>
    <li>Doors open</li>
    <li>Welcome<br>and intros</li>
  </ol>
  <hr/>
  <p class="line">See you there.</p>
</div>
</body></html>`;

describe("quipHtmlToMarkdown", () => {
  const md = quipHtmlToMarkdown(FIXTURE);

  test("converts headings at the right level", () => {
    expect(md).toContain("# Spring Info Sessions");
    expect(md).toContain("## What to bring");
    expect(md).toContain("## Schedule");
  });

  test("converts inline bold, italic and decodes entities", () => {
    expect(md).toContain("Welcome to **Rabbithole** & our *spring* series.");
  });

  test("converts links and decodes the ampersand in the href", () => {
    expect(md).toContain("[Eventbrite](https://ex.com/e?a=1&b=2)");
  });

  test("converts unordered and ordered lists", () => {
    expect(md).toContain("- A **notebook**");
    expect(md).toContain("- Questions");
    expect(md).toContain("1. Doors open");
    expect(md).toContain("2. Welcome");
  });

  test("preserves a <br> inside a list item", () => {
    expect(md).toContain("2. Welcome\nand intros");
  });

  test("converts blockquotes and horizontal rules", () => {
    expect(md).toContain("> Seats are limited.");
    expect(md).toContain("\n---\n");
  });

  test("drops the empty paragraph without leaving a blank markdown line run", () => {
    expect(md).not.toMatch(/\n{3,}/);
  });

  test("strips the surrounding HTML page (no tags survive)", () => {
    expect(md).not.toMatch(/<[^>]+>/);
    expect(md).not.toContain(".x{}");
  });

  test("returns empty string for empty input", () => {
    expect(quipHtmlToMarkdown("")).toBe("");
  });
});
