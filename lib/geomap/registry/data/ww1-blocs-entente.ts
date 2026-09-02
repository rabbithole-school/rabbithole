/**
 * Triple Entente participants that entered the opening 1914 declaration chain.
 * Geometry is reused verbatim from europe-1914.ts so bloc tint and border layers
 * cannot drift apart.
 */
import type { RegistryEntry } from "../index";
import { selectEurope1914Countries } from "./europe-1914";

export const ww1BlocsEntente: RegistryEntry = {
  id: "ww1-blocs-entente",
  label: "Entente powers",
  kind: "overlay",
  source:
    "Country membership hand-curated from the July–August 1914 alignment; geometry reused from this repo's europe-1914 dataset",
  license: "original work (this repo)",
  notes:
    "Shows France, the Russian Empire, the United Kingdom, Serbia, and Montenegro for the opening 1914 chain. It is not a complete map of every later Allied belligerent.",
  data: {
    type: "FeatureCollection",
    features: selectEurope1914Countries(
      new Set(["france", "russia", "united-kingdom", "serbia", "montenegro"]),
    ),
  },
};
