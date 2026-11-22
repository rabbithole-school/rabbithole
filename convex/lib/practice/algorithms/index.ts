/**
 * The algorithms strand of discrete-math: counting an algorithm's steps and
 * naming how the count grows (big-O), with short Python listings in the stems.
 *
 * Like the Algebra 2 families, these are functions of a small kit rather than
 * importers of `templates.ts`, because the registry there spreads them in.
 */
import type { Algebra2Kit, Template } from "../templates";
import { growthTemplates } from "./growth";
import { stepCountingTemplates } from "./stepCounting";

export function algorithmsTemplates(kit: Algebra2Kit): Template[] {
  return [...stepCountingTemplates(kit), ...growthTemplates(kit)];
}
