import Link from "next/link";

/**
 * A missing worksheet page. Plain markup on purpose: the app's root not-found
 * page is built from Chakra and expects the app's providers, which these
 * routes skip (lib/lightPublicRoutes.ts). This one renders inside the
 * worksheet layout instead.
 */
export default function WorksheetNotFound() {
  return (
    <main>
      <div className="mw-surface">
        <h1 className="mw-h1">We couldn&rsquo;t find that worksheet</h1>
        <p className="mw-lede">
          The link may have a typo in it. Every skill is listed on the <Link href="/math-worksheets">math worksheets</Link>{" "}
          page.
        </p>
      </div>
    </main>
  );
}
