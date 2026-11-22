import type { Viewport } from "next";
import type { ReactNode } from "react";
import { NoAccountAnalytics } from "@/components/analytics/NoAccountAnalytics";
import { WorksheetProviders } from "@/components/mathWorksheets/WorksheetProviders";
import { schoolCredit } from "@/lib/mathWorksheets/credit";
import "./worksheets.css";

/**
 * /math-worksheets: the free, public worksheet maker. No sign-in, no Convex
 * read, no tenant; every page here is built from pure code (the skill graph
 * and the problem templates). Keep it that way: no useCurrentUser, no
 * useQuery, nothing that needs a session or an institution. These routes are
 * listed in lib/lightPublicRoutes.ts, so they render without the app's
 * providers at all (no Convex client, no sign-in code, no Chakra).
 */

/** Parents read these on phones and zoom into problems; the app's no-zoom viewport doesn't apply. */
export const viewport: Viewport = { maximumScale: 5, userScalable: true };

/** The one-line install front door: a parent who likes the worksheets can run the whole tutor themselves. */
const DRINK_ME_URL = "https://drink-me.rabbithole.school";
export default function MathWorksheetsLayout({ children }: { children: ReactNode }) {
  const credit = schoolCredit();
  return (
    <WorksheetProviders>
    <NoAccountAnalytics />
    <div className="mw-root">
      <div className="mw-wrap">
        {children}
        <footer className="mw-surface mw-noprint">
          <p className="mw-p" style={{ margin: 0 }}>
            Free to use and print, with no account. A note for grown-ups: nothing about your child is asked for,
            there are no ads, and we count visits anonymously.
          </p>
          <p className="mw-credit">
            {credit ? (
              <>
                Made at {credit.url ? <a href={credit.url}>{credit.name}</a> : credit.name}, where our students practice
                with these same problems in{" "}
              </>
            ) : (
              <>Made with </>
            )}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- the app home runs on the app providers these pages skip; a full page load is the right way there. */}
            <a href="/">Rabbithole</a>.
          </p>
          <p className="mw-credit">
            Rabbithole is an AI tutor that answers a kid&apos;s question with a better question, and you can run your
            own copy at home tonight. <a href={DRINK_ME_URL}>Follow the white rabbit</a>.
          </p>
        </footer>
      </div>
    </div>
    </WorksheetProviders>
  );
}
