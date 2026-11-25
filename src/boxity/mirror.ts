import { KIT } from "../constants.js";

// In-memory mirror of one signed-in player's SERVER-owned counters (loaded from the save doc on
// join, updated only by events the server itself observed). Stats, leaderboards and badges read
// from here, never from a client message. Shared by every room in the process.
export interface Mirror {
  userId: string; // bare Bloxity id (verified, auth.ts)
  sessions: number; // live sessions using this mirror
  pvpKills: number;
  bestStreak: number; // all-time best killstreak (badges, stats)
  duelsWon: number;
  duelsLost: number;
  rating: number;
  // leaderboard bookkeeping: what Boxity has not been told yet
  pendingKills: number; // 'sum' board: kills since the last successful flush
  pendingDuels: number; // 'sum' board
  streakBest: number; // this session's best killstreak ('best' weekly board)
  streakDirty: boolean;
  ratingDirty: boolean;
}

const mirrors = new Map<string, Mirror>();
export const allMirrors = () => [...mirrors.values()];

export interface SavedCounters {
  pvpKills?: number;
  pvpBestStreak?: number;
  duelsWon?: number;
  duelsLost?: number;
  rating?: number;
}
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// A session joined: attach to (or create) the user's mirror, seeded from the saved doc.
export function attachMirror(userId: string, doc?: SavedCounters | null): Mirror {
  let m = mirrors.get(userId);
  if (!m) {
    m = {
      userId,
      sessions: 0,
      pvpKills: num(doc?.pvpKills),
      bestStreak: num(doc?.pvpBestStreak),
      duelsWon: num(doc?.duelsWon),
      duelsLost: num(doc?.duelsLost),
      rating: typeof doc?.rating === "number" ? doc.rating : KIT.duel.startRating,
      pendingKills: 0,
      pendingDuels: 0,
      streakBest: 0,
      streakDirty: false,
      ratingDirty: typeof doc?.rating === "number" && doc.rating !== KIT.duel.startRating,
    };
    mirrors.set(userId, m);
  }
  m.sessions++;
  return m;
}
export function detachMirror(userId: string): void {
  const m = mirrors.get(userId);
  if (m) m.sessions = Math.max(0, m.sessions - 1);
}
// Drop mirrors nobody uses and nothing is pending for (called after a flush).
export function pruneMirrors(): void {
  for (const [id, m] of mirrors) if (m.sessions === 0 && !m.pendingKills && !m.pendingDuels && !m.streakDirty && !m.ratingDirty) mirrors.delete(id);
}

export function recordKill(m: Mirror, streak: number): void {
  m.pvpKills++;
  m.pendingKills++;
  if (streak > m.bestStreak) m.bestStreak = streak;
  if (streak > m.streakBest) {
    m.streakBest = streak;
    m.streakDirty = true;
  }
}
export function recordDuel(m: Mirror, won: boolean, rating: number): void {
  if (won) {
    m.duelsWon++;
    m.pendingDuels++;
  } else m.duelsLost++;
  m.rating = rating;
  m.ratingDirty = true;
}

// At most one counted player kill per killer per KIT.killGapMs.
export class KillGate {
  private last = new Map<string, number>();
  allow(id: string, now = Date.now()): boolean {
    const prev = this.last.get(id);
    if (prev !== undefined && now - prev < KIT.killGapMs) return false;
    this.last.set(id, now);
    return true;
  }
  forget(id: string) {
    this.last.delete(id);
  }
}

// Test-only
export function __resetMirrors(): void {
  mirrors.clear();
}
