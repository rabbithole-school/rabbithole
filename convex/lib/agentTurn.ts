// Which turn of a conversation an agent tool call belongs to, as a number
// that grows with every new user message. Two-phase writes (admissions,
// class plans) commit only from a turn later than the one that planned them,
// so a model can't plan and confirm in one breath. Set by the surface, never
// by the model.

/** A Slack ts ("1728600000.123456") as an exact integer of microseconds. */
export function slackTsToTurnOrder(ts: string): number {
  const [secs, frac = ""] = ts.split(".");
  const s = Number(secs);
  const us = Number(frac.padEnd(6, "0").slice(0, 6));
  if (!Number.isFinite(s) || !Number.isFinite(us)) throw new Error(`Bad Slack ts: ${ts}`);
  return s * 1_000_000 + us;
}

/** The in-app aide's turn: one request per user message. */
export function appTurnOrder(now = Date.now()): number {
  return now * 1000;
}
