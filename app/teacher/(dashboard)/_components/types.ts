// Shared types + helpers for the teacher dashboard tab routes. Extracted from
// the old monolithic TeacherDashboard.tsx so the per-route pages and the
// command palette can share one Scholar shape.

export interface Scholar {
  id: string;
  username?: string | null;
  name?: string;
  image?: string;
  institutionId?: string | null;
  institutionSlug?: string | null;
  institutionName?: string | null;
  institutionKind?: "school" | "guest" | "community" | null;
  enrollmentStanding: "enrolled" | "program_guest";
  readingLevel: string | null;
  dateOfBirth: string | null;
  sessionCount: number;
  messageCount: number;
  lastActive: number;
  statusSummary: string | null;
  pulseScore: number | null;
  lastMessage: string | null;
  lastMessageAt: number | null;
  lastSessionTitle: string | null;
  processStep: string | null;
  processTitle: string | null;
}

export type UnitInfo = {
  _id: string;
  title: string;
  slug?: string;
  emoji?: string;
  description?: string;
  subject?: string;
  processId?: string | null;
  durationMinutes?: number;
};

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
