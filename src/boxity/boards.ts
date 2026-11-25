// The leaderboards this game declares to Boxity. The CLIENT passes the same array to
// Legion.SDK.leaderboard.define() (Bowling-roll/src/config.js BOARDS): keep the two identical, the
// first declaration creates each board and later changes are made in the Boxity dashboard.
export interface BoardDef {
  id: string;
  label: string;
  order: "desc" | "asc";
  mode: "best" | "sum" | "latest";
  format: "number" | "compact" | "time";
  reset: "none" | "daily" | "weekly" | "monthly";
}

export const BOARDS: BoardDef[] = [
  { id: "kills", label: "Player kills", order: "desc", mode: "sum", format: "number", reset: "weekly" },
  { id: "streak", label: "Best killstreak", order: "desc", mode: "best", format: "number", reset: "weekly" },
  { id: "duels", label: "Duels won", order: "desc", mode: "sum", format: "number", reset: "none" },
  { id: "rating", label: "Duel rating", order: "desc", mode: "best", format: "number", reset: "none" },
];
