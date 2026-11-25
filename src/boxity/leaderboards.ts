import { BOARDS } from "./boards.js";
import { KIT } from "../constants.js";
import { legionId, postJson, reportEnv } from "./env.js";
import { allMirrors, type Mirror } from "./mirror.js";

// Leaderboard scores from server-owned state (docs: add leaderboards, hosted report). 'sum' boards
// (kills, duels) send what was gained since the last successful flush and keep it on failure; 'best'
// boards send the current value: streak = this session's best (it feeds a weekly board, so the
// all-time best must not be re-sent), rating = once rated away from the start rating.
export const SCORE_BATCH = 200;

export interface Score {
  board: string;
  userId: string;
  score: number;
}
export interface ScoreBatch {
  scores: Score[];
  commit: () => void; // the batch landed: forget what it carried
}

export function buildScoreBatches(mirrors: Mirror[]): ScoreBatch[] {
  const entries: { score: Score; commit: () => void }[] = [];
  for (const m of mirrors) {
    if (!m.userId) continue;
    const userId = legionId(m.userId);
    if (m.pendingKills > 0) {
      const sent = m.pendingKills;
      entries.push({ score: { board: "kills", userId, score: sent }, commit: () => void (m.pendingKills -= sent) });
    }
    if (m.streakDirty && m.streakBest > 0) {
      const sent = m.streakBest;
      entries.push({ score: { board: "streak", userId, score: sent }, commit: () => void (m.streakDirty = m.streakBest !== sent) });
    }
    if (m.pendingDuels > 0) {
      const sent = m.pendingDuels;
      entries.push({ score: { board: "duels", userId, score: sent }, commit: () => void (m.pendingDuels -= sent) });
    }
    if (m.ratingDirty && m.rating !== KIT.duel.startRating) {
      const sent = m.rating;
      entries.push({ score: { board: "rating", userId, score: sent }, commit: () => void (m.ratingDirty = m.rating !== sent) });
    } else if (m.ratingDirty) m.ratingDirty = false; // back at the start rating: nothing to rank
  }
  const batches: ScoreBatch[] = [];
  for (let i = 0; i < entries.length; i += SCORE_BATCH) {
    const part = entries.slice(i, i + SCORE_BATCH);
    batches.push({ scores: part.map((e) => e.score), commit: () => part.forEach((e) => e.commit()) });
  }
  return batches;
}

let flushing: Promise<void> | null = null;
// POSTs every pending batch. No-op without the hosting credentials. Never throws; concurrent calls share one run.
export function flushLeaderboards(): Promise<void> {
  return (flushing ??= run().finally(() => void (flushing = null)));
}
async function run(): Promise<void> {
  const env = reportEnv();
  if (!env) return;
  try {
    for (const batch of buildScoreBatches(allMirrors())) {
      const res = await postJson(`${env.apiUrl}/v1/leaderboards/hosted/${env.gameId}/report`, { boards: BOARDS, scores: batch.scores }, env.reportToken, 8000);
      console.log("[boxity boards]", res.status, JSON.stringify(res.body));
      if (res.status >= 200 && res.status < 300 && res.body?.ok !== false) batch.commit();
    }
  } catch (err) {
    console.warn("[boxity boards] failed", err);
  }
}
