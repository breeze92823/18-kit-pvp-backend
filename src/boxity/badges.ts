// Badges this game gives (declared to Boxity on start, boxity/badgeClient.ts) and the rules that
// earn them. The rules are a pure function of SERVER-owned counters, never of a client message.
export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export interface BadgeDef {
  key: string; // permanent: never rename or reuse
  name: string;
  description: string;
  icon: string; // an emoji (no image files)
  rarity: Rarity;
}

export const BADGES: BadgeDef[] = [
  { key: "welcome", name: "Welcome", description: "Join Kit PvP.", icon: "👋", rarity: "common" },
  { key: "first_blood", name: "First Blood", description: "Defeat another player in the arena.", icon: "🩸", rarity: "common" },
  { key: "hunter", name: "Hunter", description: "25 player kills.", icon: "🏹", rarity: "uncommon" },
  { key: "slayer", name: "Slayer", description: "100 player kills.", icon: "⚔️", rarity: "rare" },
  { key: "warlord", name: "Warlord", description: "500 player kills.", icon: "👑", rarity: "epic" },
  { key: "streak_5", name: "On Fire", description: "Reach a 5 kill streak.", icon: "🔥", rarity: "uncommon" },
  { key: "streak_10", name: "Unstoppable", description: "Reach a 10 kill streak.", icon: "☄️", rarity: "epic" },
  { key: "duelist", name: "Duelist", description: "Win a duel.", icon: "🤺", rarity: "common" },
  { key: "champion", name: "Champion", description: "Win 10 duels.", icon: "🏆", rarity: "rare" },
  { key: "gold_rank", name: "Gold Rank", description: "Reach 1200 duel rating.", icon: "🥇", rarity: "epic" },
  { key: "legend", name: "Legend", description: "Reach 1400 duel rating.", icon: "🐉", rarity: "legendary" },
];

export interface BadgeCounters {
  pvpKills: number;
  bestStreak: number;
  duelsWon: number;
  rating: number;
}

// Every badge key these counters have reached (a signed-in player always has "welcome").
export function badgesFor(c: BadgeCounters): string[] {
  const out = ["welcome"];
  if (c.pvpKills >= 1) out.push("first_blood");
  if (c.pvpKills >= 25) out.push("hunter");
  if (c.pvpKills >= 100) out.push("slayer");
  if (c.pvpKills >= 500) out.push("warlord");
  if (c.bestStreak >= 5) out.push("streak_5");
  if (c.bestStreak >= 10) out.push("streak_10");
  if (c.duelsWon >= 1) out.push("duelist");
  if (c.duelsWon >= 10) out.push("champion");
  if (c.rating >= 1200) out.push("gold_rank");
  if (c.rating >= 1400) out.push("legend");
  return out;
}
