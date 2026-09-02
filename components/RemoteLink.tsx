"use client";

import Link, { type LinkProps } from "next/link";
import type { ComponentProps } from "react";
import { useRemote } from "@/hooks/useRemote";

type RemoteLinkProps = Omit<ComponentProps<typeof Link>, "href"> & {
  href: string;
};

/**
 * Drop-in replacement for `next/link` that preserves the `?remote=`
 * query param when the page is being viewed by a teacher inspecting
 * a scholar. Without this, every hand-built `<Link href="/scholar/...">`
 * silently bounces the teacher back into their own view.
 *
 * Only accepts string hrefs — the `LinkProps["href"]` UrlObject shape
 * isn't worth supporting since every call site in this codebase uses
 * strings. Cast to LinkProps to keep the rest of the props identical.
 */
export function RemoteLink({ href, ...rest }: RemoteLinkProps) {
  const { stamp } = useRemote();
  const stamped = stamp(href);
  return <Link href={stamped} {...(rest as Omit<LinkProps, "href">)} />;
}
