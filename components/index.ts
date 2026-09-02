// Barrel of *primary feature entry points* only — intentionally NOT a
// re-export of every component. The house convention is to import
// components directly from their file (`@/components/Foo`), which the
// codebase does ~114:3 over this barrel. Direct imports keep the
// dependency graph explicit and sidestep the circular-import / weakened
// tree-shaking that a 70+ component barrel invites. Add a name here only
// when it's a top-level feature surface that benefits from a stable
// `@/components` entry point; otherwise import directly.
export { SessionInterface } from "./SessionInterface";
export { SessionHeader } from "./SessionHeader";
export { ScholarProfile } from "./ScholarProfile";
export type { ScholarTabKey } from "./ScholarProfile";
export type { ScholarAddAction } from "./ScholarProfile";
export { EntityManager } from "./EntityManager";
export { ProcessPanel } from "./ProcessPanel";
