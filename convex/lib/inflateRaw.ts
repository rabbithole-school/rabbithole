// Pure-JS raw DEFLATE (RFC 1951) decompressor.
//
// The Convex isolate runtime has NO `DecompressionStream`/`zlib`, so we can't
// lean on a Web/Node API to inflate the deflate-compressed parts of a .docx
// (a ZIP). This is a self-contained port of Joergen Ibsen's `tinf` (a.k.a.
// tiny-inflate, MIT) — a small, well-worn reference INFLATE that handles all
// three DEFLATE block types (stored / fixed-Huffman / dynamic-Huffman) and
// runs anywhere a plain Uint8Array does. Kept dependency-free on purpose.

class Tree {
  table = new Uint16Array(16); // number of codes of each length
  trans = new Uint16Array(288); // code -> symbol translation
}

class InflateState {
  s: Uint8Array;
  i = 0;
  t = 0;
  bitcount = 0;
  dest: Uint8Array;
  destLen = 0;
  ltree = new Tree();
  dtree = new Tree();
  constructor(source: Uint8Array, dest: Uint8Array) {
    this.s = source;
    this.dest = dest;
  }
}

const sltree = new Tree();
const sdtree = new Tree();

const lengthBits = new Uint8Array(30);
const lengthBase = new Uint16Array(30);
const distBits = new Uint8Array(30);
const distBase = new Uint16Array(30);

// special ordering of code-length codes
const clcidx = new Uint8Array([
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
]);

const codeTree = new Tree();
const lengths = new Uint8Array(288 + 32);
const offs = new Uint16Array(16);

function buildBitsBase(
  bits: Uint8Array,
  base: Uint16Array,
  delta: number,
  first: number,
): void {
  let i: number;
  let sum: number;
  for (i = 0; i < delta; ++i) bits[i] = 0;
  for (i = 0; i < 30 - delta; ++i) bits[i + delta] = Math.floor(i / delta);
  for (sum = first, i = 0; i < 30; ++i) {
    base[i] = sum;
    sum += 1 << bits[i];
  }
}

function buildFixedTrees(lt: Tree, dt: Tree): void {
  let i: number;
  for (i = 0; i < 7; ++i) lt.table[i] = 0;
  lt.table[7] = 24;
  lt.table[8] = 152;
  lt.table[9] = 112;
  for (i = 0; i < 24; ++i) lt.trans[i] = 256 + i;
  for (i = 0; i < 144; ++i) lt.trans[24 + i] = i;
  for (i = 0; i < 8; ++i) lt.trans[24 + 144 + i] = 280 + i;
  for (i = 0; i < 112; ++i) lt.trans[24 + 144 + 8 + i] = 144 + i;
  for (i = 0; i < 5; ++i) dt.table[i] = 0;
  dt.table[5] = 32;
  for (i = 0; i < 32; ++i) dt.trans[i] = i;
}

function buildTree(
  t: Tree,
  lens: Uint8Array,
  off: number,
  num: number,
): void {
  let i: number;
  let sum: number;
  for (i = 0; i < 16; ++i) t.table[i] = 0;
  for (i = 0; i < num; ++i) t.table[lens[off + i]]++;
  t.table[0] = 0;
  for (sum = 0, i = 0; i < 16; ++i) {
    offs[i] = sum;
    sum += t.table[i];
  }
  for (i = 0; i < num; ++i) {
    if (lens[off + i]) t.trans[offs[lens[off + i]]++] = i;
  }
}

function getBit(d: InflateState): number {
  if (!d.bitcount--) {
    d.t = d.s[d.i++];
    d.bitcount = 7;
  }
  const bit = d.t & 1;
  d.t >>>= 1;
  return bit;
}

function readBits(d: InflateState, num: number, base: number): number {
  if (!num) return base;
  while (d.bitcount < 24) {
    d.t |= d.s[d.i++] << d.bitcount;
    d.bitcount += 8;
  }
  const val = d.t & (0xffff >>> (16 - num));
  d.t >>>= num;
  d.bitcount -= num;
  return val + base;
}

function decodeSymbol(d: InflateState, t: Tree): number {
  while (d.bitcount < 24) {
    d.t |= d.s[d.i++] << d.bitcount;
    d.bitcount += 8;
  }
  let sum = 0;
  let cur = 0;
  let len = 0;
  let tag = d.t;
  do {
    cur = 2 * cur + (tag & 1);
    tag >>>= 1;
    ++len;
    sum += t.table[len];
    cur -= t.table[len];
  } while (cur >= 0);
  d.t = tag;
  d.bitcount -= len;
  return t.trans[sum + cur];
}

function decodeTrees(d: InflateState, lt: Tree, dt: Tree): void {
  let num: number;
  let length: number;
  let i: number;
  const hlit = readBits(d, 5, 257);
  const hdist = readBits(d, 5, 1);
  const hclen = readBits(d, 4, 4);
  for (i = 0; i < 19; ++i) lengths[i] = 0;
  for (i = 0; i < hclen; ++i) {
    lengths[clcidx[i]] = readBits(d, 3, 0);
  }
  buildTree(codeTree, lengths, 0, 19);
  for (num = 0; num < hlit + hdist; ) {
    const sym = decodeSymbol(d, codeTree);
    switch (sym) {
      case 16: {
        const prev = lengths[num - 1];
        for (length = readBits(d, 2, 3); length; --length) lengths[num++] = prev;
        break;
      }
      case 17:
        for (length = readBits(d, 3, 3); length; --length) lengths[num++] = 0;
        break;
      case 18:
        for (length = readBits(d, 7, 11); length; --length) lengths[num++] = 0;
        break;
      default:
        lengths[num++] = sym;
        break;
    }
  }
  buildTree(lt, lengths, 0, hlit);
  buildTree(dt, lengths, hlit, hdist);
}

function inflateBlockData(d: InflateState, lt: Tree, dt: Tree): void {
  for (;;) {
    let sym = decodeSymbol(d, lt);
    if (sym === 256) return;
    // A degenerate/malformed Huffman tree can make decodeSymbol return an
    // out-of-range index (undefined) or a reserved code (286/287). Left
    // unchecked that lands in the length branch with a NaN length — which
    // writes nothing, so the output bound below never trips and the loop spins
    // forever. Valid literal/length symbols are 0..285; anything else is
    // malformed → throw so the caller degrades gracefully.
    if (!(sym >= 0 && sym <= 285)) {
      throw new Error("inflate: invalid literal/length symbol");
    }
    if (sym < 256) {
      // Bounds the loop: on a valid stream a literal is only written while
      // destLen < expectedSize, so this never fires; on a stream that emits
      // more output than declared it throws, so the caller's try/catch can
      // degrade gracefully instead of the isolate OOMing.
      if (d.destLen >= d.dest.length) {
        throw new Error("inflate: output exceeds expected size");
      }
      d.dest[d.destLen++] = sym;
    } else {
      sym -= 257;
      const length = readBits(d, lengthBits[sym], lengthBase[sym]);
      const dist = decodeSymbol(d, dt);
      if (!(dist >= 0 && dist <= 29)) {
        throw new Error("inflate: invalid distance symbol");
      }
      const offset = d.destLen - readBits(d, distBits[dist], distBase[dist]);
      if (offset < 0) {
        throw new Error("inflate: back-reference before start of output");
      }
      for (let i = offset; i < offset + length; ++i) {
        if (d.destLen >= d.dest.length) {
          throw new Error("inflate: output exceeds expected size");
        }
        d.dest[d.destLen++] = d.dest[i];
      }
    }
  }
}

function inflateUncompressedBlock(d: InflateState): void {
  while (d.bitcount > 8) {
    d.i--;
    d.bitcount -= 8;
  }
  let length = d.s[d.i + 1];
  length = 256 * length + d.s[d.i];
  let invlength = d.s[d.i + 3];
  invlength = 256 * invlength + d.s[d.i + 2];
  if (length !== (~invlength & 0x0000ffff)) {
    throw new Error("inflate: stored-block length mismatch");
  }
  d.i += 4;
  for (let i = length; i; --i) {
    if (d.destLen >= d.dest.length) {
      throw new Error("inflate: output exceeds expected size");
    }
    d.dest[d.destLen++] = d.s[d.i++];
  }
  d.bitcount = 0;
}

// Hard ceiling on the inflated output buffer. A .docx `word/document.xml` is
// plain text XML — even an enormous unit is a few MB at most (embedded media
// lives in SEPARATE ZIP entries we never inflate). The cap exists so an
// attacker-controlled `uncompressedSize` from the ZIP central directory (a raw
// uint32, up to ~4 GB) or a zip-bomb stream can't force a giant allocation /
// OOM in the memory-constrained Convex isolate; combined with the per-write
// bound in inflateBlockData, oversized input fails into the caller's caught
// "[Could not extract text]" note instead of crashing the stream.
const MAX_INFLATE_BYTES = 16 * 1024 * 1024;

/**
 * Inflate a raw DEFLATE stream (no zlib header). `expectedSize` is the entry's
 * uncompressed byte length (docx ZIP entries carry it in the central
 * directory), used to size the output buffer — but it's clamped to
 * MAX_INFLATE_BYTES since it's attacker-controlled. A stream that tries to
 * produce more than the (clamped) size throws rather than overflowing.
 */
export function inflateRaw(
  source: Uint8Array,
  expectedSize: number,
): Uint8Array {
  const size = Math.min(expectedSize >>> 0, MAX_INFLATE_BYTES);
  const d = new InflateState(source, new Uint8Array(size));
  let bfinal: number;
  do {
    bfinal = getBit(d);
    const btype = readBits(d, 2, 0);
    if (btype === 0) inflateUncompressedBlock(d);
    else if (btype === 1) inflateBlockData(d, sltree, sdtree);
    else if (btype === 2) {
      decodeTrees(d, d.ltree, d.dtree);
      inflateBlockData(d, d.ltree, d.dtree);
    } else {
      throw new Error("inflate: invalid block type");
    }
  } while (!bfinal);
  return d.destLen === d.dest.length ? d.dest : d.dest.subarray(0, d.destLen);
}

// static-table init (runs once at module load)
buildFixedTrees(sltree, sdtree);
buildBitsBase(lengthBits, lengthBase, 4, 3);
buildBitsBase(distBits, distBase, 2, 1);
lengthBits[28] = 0;
lengthBase[28] = 258;
