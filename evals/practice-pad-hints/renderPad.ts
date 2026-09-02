import { PNG } from "pngjs";

const GLYPHS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
  "-": ["000", "000", "111", "000", "000"],
  "=": ["000", "111", "000", "111", "000"],
  "/": ["001", "001", "010", "100", "100"],
  "x": ["101", "101", "010", "101", "101"],
  ">": ["100", "010", "001", "010", "100"],
  ".": ["000", "000", "000", "000", "010"],
  "(": ["010", "100", "100", "100", "010"],
  ")": ["010", "001", "001", "001", "010"],
  ":": ["000", "010", "000", "010", "000"],
  "o": ["000", "111", "101", "101", "111"],
  "n": ["000", "110", "101", "101", "101"],
  "e": ["000", "111", "110", "100", "111"],
  "s": ["000", "111", "100", "011", "111"],
  " ": ["000", "000", "000", "000", "000"],
};

export function renderPadPng(lines: string[]): Buffer {
  const scale = 8;
  const glyphW = 3 * scale;
  const glyphH = 5 * scale;
  const spacing = scale;
  const width = Math.max(...lines.map((line) => line.length)) * (glyphW + spacing) + 64;
  const height = lines.length * (glyphH + 3 * spacing) + 64;
  const png = new PNG({ width, height, colorType: 6 });
  png.data.fill(255);

  const setPixel = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    png.data[index] = 35;
    png.data[index + 1] = 55;
    png.data[index + 2] = 105;
    png.data[index + 3] = 255;
  };

  lines.forEach((line, lineIndex) => {
    let x = 32;
    const y = 32 + lineIndex * (glyphH + 3 * spacing);
    for (const raw of line) {
      const glyph = GLYPHS[raw.toLowerCase()] ?? GLYPHS[" "];
      glyph.forEach((row, gy) => {
        [...row].forEach((cell, gx) => {
          if (cell !== "1") return;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              setPixel(x + gx * scale + sx, y + gy * scale + sy);
            }
          }
        });
      });
      x += glyphW + spacing;
    }
  });
  return PNG.sync.write(png);
}
