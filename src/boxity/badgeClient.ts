import { BADGES, badgesFor } from "./badges.js";
import { legionId, postJson, reportEnv } from "./env.js";
import type { Mirror } from "./mirror.js";

// Boxity badges (docs: add badges): declared once at start, `owned` read when a signed-in player
// joins, `award` sent when a server-owned counter reaches a rule. Every failure is swallowed: a
// badge call must never disturb the game. A 403 (the dev channel on production) stops all of it.
let disabled = false;
let declared = false;
let declaring: Promise<void> | null = null;
const owned = new Map<string, Set<string>>(); // bare user id -> keys held (only once `owned` answered)
const loading = new Map<string, Promise<void>>();

const base = () => {
  const env = reportEnv();
  return env ? { env, url: `${env.apiUrl}/v1/game-badges/hosted/${env.gameId}` } : null;
};
const withSlug = (body: object) => {
  const e = reportEnv();
  return e?.gameSlugSet ? { ...body, gameSlug: e.gameSlug } : body;
};
function forbidden(status: number): boolean {
  if (status !== 403) return false;
  if (!disabled) console.warn("[boxity badges] 403 (dev channel on production?): badges are off for this process");
  disabled = true;
  return true;
}

// Declares the full list; retries every 30 s until it succeeds. Never throws.
export function declareBadges(retryMs = 30_000): Promise<void> {
  const b = base();
  if (!b) return Promise.resolve();
  return (declaring ??= (async () => {
    while (!declared && !disabled) {
      const res = await postJson(`${b.url}/declare`, withSlug({ badges: BADGES }), b.env.reportToken, 8000);
      console.log("[boxity badges] declare", res.status);
      if (res.status >= 200 && res.status < 300) declared = true;
      else if (!forbidden(res.status)) await new Promise((r) => setTimeout(r, retryMs).unref?.());
    }
  })());
}

// A signed-in player joined: learn what they hold, then award what their counters already reached.
export function badgeJoin(m: Mirror): void {
  const b = base();
  if (!b || disabled || owned.has(m.userId) || loading.has(m.userId)) return;
  const task = (async () => {
    await declareBadges();
    if (disabled) return;
    const res = await postJson(`${b.url}/owned`, withSlug({ userIds: [legionId(m.userId)] }), b.env.reportToken, 8000);
    if (forbidden(res.status)) return;
    if (res.status < 200 || res.status >= 300) return; // not loaded: a later check retries the join
    const map = res.body?.owned ?? {};
    const keys: unknown = map[legionId(m.userId)] ?? map[m.userId] ?? [];
    owned.set(m.userId, new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : []));
    await badgeCheck(m);
  })()
    .catch(() => {})
    .finally(() => void loading.delete(m.userId));
  loading.set(m.userId, task);
}

// Award every badge the counters have reached and the player does not hold. Never throws.
export async function badgeCheck(m: Mirror): Promise<void> {
  const b = base();
  if (!b || disabled) return;
  const set = owned.get(m.userId);
  if (!set) return badgeJoin(m); // `owned` has not answered yet
  const fresh = badgesFor(m).filter((k) => !set.has(k));
  if (!fresh.length) return;
  for (const k of fresh) set.add(k); // first, so each is sent once
  try {
    const res = await postJson(`${b.url}/award`, withSlug({ awards: fresh.map((key) => ({ userId: legionId(m.userId), key })) }), b.env.reportToken, 8000);
    if (res.status >= 200 && res.status < 300) return;
    forbidden(res.status);
  } catch {
    /* retried below */
  }
  for (const k of fresh) set.delete(k); // failed: the next check sends them again
}

export function forgetBadges(userId: string): void {
  owned.delete(userId);
}

// Test-only
export function __resetBadgeClient(): void {
  disabled = false;
  declared = false;
  declaring = null;
  owned.clear();
  loading.clear();
}
