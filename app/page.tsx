import type { Metadata } from "next";
import { HomeLanding } from "./HomeLanding";

/**
 * `/`. The landing page is a client component (it routes signed-in people to
 * their home), so this server file exists to give the page its own title and
 * description for search results and link previews.
 */

const TITLE = "Rabbithole, the AI tutor that makes kids think harder";
const DESCRIPTION =
  "Rabbithole is an AI tutor that answers a child's question with a better question. Teachers write the prompts, set the checkpoints and read every conversation. Free printable math worksheets too.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/", siteName: "Rabbithole", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export default function Home() {
  return <HomeLanding />;
}
