import { notFound } from "next/navigation";

/**
 * Anything deeper than a skill page (/math-worksheets/<skill>/<more>) is not a
 * page. Without this route Next would fall back to the app's root not-found
 * page, which needs the providers these routes skip; notFound() here renders
 * app/math-worksheets/not-found.tsx inside the worksheet layout.
 */
export default function NoDeeperPage(): never {
  notFound();
}
