/**
 * Central alliance participants in the opening 1914 declaration chain.
 * Geometry is reused verbatim from europe-1914.ts so bloc tint and border layers
 * cannot drift apart.
 */
import type { RegistryEntry } from "../index";
import { selectEurope1914Countries } from "./europe-1914";

export const ww1BlocsAlliance: RegistryEntry = {
  id: "ww1-blocs-alliance",
  label: "Central alliance",
  kind: "overlay",
  source:
    "Country membership hand-curated from the July–August 1914 alignment; geometry reused from this repo's europe-1914 dataset",
  license: "original work (this repo)",
  notes:
    "Shows the German Empire and Austria-Hungary. Italy is deliberately excluded because it remained neutral when war began in 1914 despite its prewar Triple Alliance membership.",
  data: {
    type: "FeatureCollection",
    features: selectEurope1914Countries(new Set(["germany", "austria-hungary"])),
  },
};
