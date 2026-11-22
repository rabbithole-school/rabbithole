/**
 * The Algebra 2 template families, one file per strand.
 *
 * Each strand file is a function of a small kit rather than an importer of
 * `templates.ts`: the registry there spreads these families in, so a value
 * import back would be a cycle. Types are imported type-only.
 */
import type { Algebra2Kit, Template } from "../templates";
import { complexQuadraticsTemplates } from "./complexQuadratics";
import { expLogTemplates } from "./expLog";
import { functionsTemplates } from "./functions";
import { graphNodeTemplates } from "./graphNodes";
import { polynomialsTemplates } from "./polynomials";
import { radicalsTemplates } from "./radicals";
import { rationalTemplates } from "./rational";
import { sequencesTemplates } from "./sequences";

export function algebra2Templates(kit: Algebra2Kit): Template[] {
  return [
    ...functionsTemplates(kit),
    ...complexQuadraticsTemplates(kit),
    ...polynomialsTemplates(kit),
    ...rationalTemplates(kit),
    ...radicalsTemplates(kit),
    ...expLogTemplates(kit),
    ...sequencesTemplates(kit),
    ...graphNodeTemplates(kit),
  ];
}
