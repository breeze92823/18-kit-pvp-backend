import { legionId, postJson, reportEnv } from "./env.js";
import { allMirrors, pruneMirrors, type Mirror } from "./mirror.js";

// "Only in this game" profile stats (Boxity docs: report your game's stats). Every value comes from
// the server's own counters (mirror.ts): current values, never a client number.
export const STAT_DEFS = [
  { key: "pvp_kills", label: "Player Kills", type: "number", sortOrder: 1 },
  { key: "best_streak", label: "Best Killstreak", type: "number", sortOrder: 2 },
  { key: "duels_won", label: "Duels Won", type: "number", sortOrder: 3 },
  { key: "duels_lost", label: "Duels Lost", type: "number", sortOrder: 4 },
  { key: "rating", label: "Duel Rating", type: "number", sortOrder: 5 },
] as const;

const CEILING = 1_000_000_000; // type "number"
export const STAT_BATCH = 200;

export interface StatPlayer {
  userId: string;
  values: Record<string, number>;
}

const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= CEILING;

// Players -> request rows: signed-in only (mirrors are only made for verified users), invalid
// values omitted, batches of STAT_BATCH.
export function buildStatBatches(mirrors: Mirror[]): StatPlayer[][] {
  const rows: StatPlayer[] = [];
  for (const m of mirrors) {
    if (!m.userId) continue;
    const raw = { pvp_kills: m.pvpKills, best_streak: m.bestStreak, duels_won: m.duelsWon, duels_lost: m.duelsLost, rating: m.rating };
    const values: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (ok(v)) values[k] = v;
    if (Object.keys(values).length) rows.push({ userId: legionId(m.userId), values });
  }
  const batches: StatPlayer[][] = [];
  for (let i = 0; i < rows.length; i += STAT_BATCH) batches.push(rows.slice(i, i + STAT_BATCH));
  return batches;
}

// POSTs every batch. No-op without the hosting credentials. Never throws.
export async function flushStats(): Promise<void> {
  const env = reportEnv();
  if (!env) return;
  try {
    for (const players of buildStatBatches(allMirrors())) {
      const res = await postJson(`${env.apiUrl}/v1/games/${env.gameId}/stats`, { definitions: STAT_DEFS, players }, env.reportToken, 8000);
      console.log("[boxity stats]", res.status, JSON.stringify(res.body));
    }
  } catch (err) {
    console.warn("[boxity stats] failed", err);
  }
}
