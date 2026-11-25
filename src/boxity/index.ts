import { declareBadges } from "./badgeClient.js";
import { reportEnv } from "./env.js";
import { flushLeaderboards } from "./leaderboards.js";
import { pruneMirrors } from "./mirror.js";
import { flushStats } from "./stats.js";

// Starts the Boxity reporters (stats every 60 s, leaderboards every 15 s, badge declaration) and
// drains them on shutdown. A no-op outside Boxity hosting (no BLOXITY_REPORT_TOKEN / BLOXITY_GAME_ID).
export function installBoxityReporters(): void {
  if (!reportEnv()) return;
  void declareBadges();
  const boards = setInterval(() => void flushLeaderboards(), 15_000);
  // departed players keep their mirror until their final stats went out
  const stats = setInterval(() => void flushStats().then(pruneMirrors), 60_000);
  boards.unref();
  stats.unref();
  let draining = false;
  const drain = () => {
    if (draining) return;
    draining = true;
    void Promise.allSettled([flushLeaderboards(), flushStats()]);
  };
  process.once("SIGTERM", drain);
  process.once("SIGINT", drain);
}
export { flushLeaderboards } from "./leaderboards.js";
export { badgeCheck, badgeJoin } from "./badgeClient.js";
