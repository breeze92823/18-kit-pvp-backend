// Duels (KitRoom.ts): 1v1 matchmaking per mode, platform slots, rounds and the ranked rating.
// Pure bookkeeping, no timers or networking here (the room drives it), so it is easy to test.
import { KIT } from "./constants.js";

export type DuelMode = "casual" | "ranked";
export interface Duel {
  id: string;
  slot: number;
  mode: DuelMode;
  players: [string, string]; // sessionIds, side 0 and side 1
  score: [number, number];
  round: number;
  phase: "countdown" | "fight" | "between" | "over";
}

// Elo: the winner gains what the loser loses, more for beating a stronger player.
export function eloDelta(winner: number, loser: number, k = KIT.duel.k): number {
  const expected = 1 / (1 + 10 ** ((loser - winner) / 400));
  return Math.max(1, Math.round(k * (1 - expected)));
}

export class DuelBook {
  queue: Record<DuelMode, string[]> = { casual: [], ranked: [] };
  duels = new Map<string, Duel>();
  private seq = 0;

  enqueue(id: string, mode: DuelMode): boolean {
    if (this.duelOf(id) || this.queuedMode(id)) return false;
    this.queue[mode].push(id);
    return true;
  }
  dequeue(id: string) {
    for (const m of ["casual", "ranked"] as const) this.queue[m] = this.queue[m].filter((s) => s !== id);
  }
  queuedMode(id: string): DuelMode | null {
    for (const m of ["casual", "ranked"] as const) if (this.queue[m].includes(id)) return m;
    return null;
  }
  duelOf(id: string): Duel | undefined {
    for (const d of this.duels.values()) if (d.players.includes(id)) return d;
    return undefined;
  }
  private freeSlot(): number {
    const used = new Set([...this.duels.values()].map((d) => d.slot));
    for (let s = 0; s < KIT.duel.slots; s++) if (!used.has(s)) return s;
    return -1;
  }
  // Pairs the two longest-waiting players of a mode on a free platform, or null.
  match(mode: DuelMode): Duel | null {
    const q = this.queue[mode];
    if (q.length < 2) return null;
    const slot = this.freeSlot();
    if (slot < 0) return null;
    const [a, b] = q.splice(0, 2);
    const duel: Duel = { id: `d${++this.seq}`, slot, mode, players: [a, b], score: [0, 0], round: 0, phase: "countdown" };
    this.duels.set(duel.id, duel);
    return duel;
  }
  // The player on `side` lost the round: returns the winning side, and whether the duel is over.
  roundLost(duel: Duel, side: 0 | 1): { winner: 0 | 1; over: boolean } {
    const winner = (1 - side) as 0 | 1;
    duel.score[winner]++;
    const over = duel.score[winner] >= KIT.duel.wins;
    duel.phase = over ? "over" : "between";
    return { winner, over };
  }
  end(duel: Duel) {
    duel.phase = "over";
    this.duels.delete(duel.id);
  }
}
