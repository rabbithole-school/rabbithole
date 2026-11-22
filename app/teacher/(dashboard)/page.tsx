import type { Metadata } from "next";
import TodayPage from "./TodayPage";

// Server wrapper so the route can carry a tab title; the dashboard layout is
// a client component and cannot export metadata.
export const metadata: Metadata = { title: "Today" };

export default TodayPage;
