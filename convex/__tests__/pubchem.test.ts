import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import {
  moleculeResolutionMessage,
  resolvePubChemMolecule,
} from "../lib/pubchem";

const sucroseSdf = readFileSync(
  new URL("../../lib/manipulative/__tests__/fixtures/sucrose-2d.sdf", import.meta.url),
  "utf8",
);

const request = {
  kind: "molecule",
  concept: "Glycosidic bonds",
  prompt: "Find the oxygen that joins the two rings.",
  query: "sugar",
  highlight: { kind: "bridgingOxygen" },
};

function propertyResponse(
  title = "Sucrose",
  formula = "C12H22O11",
): Response {
  return Response.json({
    PropertyTable: {
      Properties: [{ CID: 5988, Title: title, MolecularFormula: formula }],
    },
  });
}

function carbonChainSdf(atomCount: number): string {
  const atoms = Array.from({ length: atomCount }, (_, index) =>
    `${index.toFixed(4).padStart(10)}${"0.0000".padStart(10)}${"0.0000".padStart(10)} C   0  0  0  0  0  0  0  0  0  0  0  0`,
  );
  return [
    "Large fixture",
    "  pubchem.test",
    "",
    `${String(atomCount).padStart(3)}${"0".padStart(3)}  0  0  0  0            999 V2000`,
    ...atoms,
    "M  END",
    "",
  ].join("\n");
}

describe("resolvePubChemMolecule", () => {
  test("resolves the first name CID and hydrates real structure data", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/name/sugar/cids/TXT")) return new Response("5988\n123\n");
      if (url.includes("/cid/5988/SDF")) return new Response(sucroseSdf);
      if (url.includes("/property/")) return propertyResponse();
      return new Response("unexpected", { status: 500 });
    });

    const result = await resolvePubChemMolecule(request, { fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec).toMatchObject({
      query: "sugar",
      resolvedName: "Sucrose",
      cid: 5988,
      formula: "C12H22O11",
      highlight: { kind: "bridgingOxygen" },
    });
    expect(result.spec.atoms).toHaveLength(45);
    expect(result.spec.bonds).toHaveLength(46);
    expect(result.message).toBe(
      "Resolved 'sugar' → Sucrose (CID 5988, C12H22O11).",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("accepts a numeric CID without calling the name endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/cid/5988/SDF")) return new Response(sucroseSdf);
      if (url.includes("/property/")) return propertyResponse();
      return new Response("unexpected", { status: 500 });
    });

    const result = await resolvePubChemMolecule(
      { ...request, query: "5988" },
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.some(([input]) => String(input).includes("/name/")),
    ).toBe(false);
  });

  test("rejects non-2xx and 200 plain-text error bodies instead of storing empties", async () => {
    const notFoundFetch = vi.fn<typeof fetch>(async () =>
      new Response("PUGREST.NotFound", { status: 404 }),
    );
    const notFound = await resolvePubChemMolecule(request, {
      fetchImpl: notFoundFetch,
    });
    expect(notFound).toEqual({
      ok: false,
      reason:
        'PubChem has no compound named "sugar" — try the IUPAC or common name.',
    });

    const badBodyFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/name/")) return new Response("5988\n");
      if (url.includes("/property/")) return propertyResponse();
      return new Response("PUGREST.NotFound\nNo structure");
    });
    const badBody = await resolvePubChemMolecule(request, {
      fetchImpl: badBodyFetch,
    });
    expect(badBody).toMatchObject({ ok: false });
    if (!badBody.ok) expect(badBody.reason).toMatch(/unusable 2D structure/);
  });

  test("refuses model-authored geometry and times out with an actionable reason", async () => {
    const authored = await resolvePubChemMolecule({
      ...request,
      atoms: [],
    });
    expect(authored).toEqual({
      ok: false,
      reason:
        "Do not author molecule.atoms; provide only query and let the server resolve the real PubChem structure.",
    });

    const fetchImpl = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const timeout = await resolvePubChemMolecule(request, {
      fetchImpl,
      timeoutMs: 5,
    });
    expect(timeout).toEqual({
      ok: false,
      reason:
        'PubChem took too long to resolve "sugar" — try again or use a CID.',
    });
  });

  test("refuses more than 200 heavy atoms on the fetch path", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/cid/999/SDF")) {
        return new Response(carbonChainSdf(201));
      }
      if (url.includes("/property/")) return propertyResponse("Large molecule", "C201");
      return new Response("unexpected", { status: 500 });
    });
    const result = await resolvePubChemMolecule(
      { ...request, query: "999" },
      { fetchImpl },
    );
    expect(result).toEqual({
      ok: false,
      reason:
        "PubChem returned a structure Rabbithole cannot render: molecule has 201 heavy atoms; the limit is 200. Try a smaller compound.",
    });
  });

  test("refuses a PubChem metadata formula that disagrees with the structure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/name/")) return new Response("5988\n");
      if (url.includes("/cid/5988/SDF")) return new Response(sucroseSdf);
      if (url.includes("/property/")) {
        return propertyResponse("Sucrose", "C12H22O10");
      }
      return new Response("unexpected", { status: 500 });
    });
    const result = await resolvePubChemMolecule(request, { fetchImpl });
    expect(result).toEqual({
      ok: false,
      reason:
        "PubChem's formula C12H22O10 does not match the structure-derived formula C12H22O11 for \"sugar\" — try another name or CID.",
    });
  });

  test("formats the resolved-compound echo from hydrated data", () => {
    expect(
      moleculeResolutionMessage({
        query: "sugar",
        resolvedName: "sucrose",
        cid: 5988,
        formula: "C12H22O11",
      }),
    ).toBe("Resolved 'sugar' → sucrose (CID 5988, C12H22O11).");
  });
});
