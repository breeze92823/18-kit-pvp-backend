// Kit PvP progress (KitRoom.ts): the save of each verified Bloxity user in Mongo (collection
// `kitpvp`, db.ts), the bounds a client save must fit (sanitizeKitSave), and the leaderboards.
// The client is authoritative for its own progress (like the rest of the game); the server owns
// the ranked rating and the duel record, which a client save can never carry.
import { KIT } from "./constants.js";
import { getKitPlayers } from "./db.js";

export interface KitDoc {
  _id: string; // Bloxity user id (verified, auth.ts)
  name?: string;
  gold?: number;
  level?: number;
  xp?: number;
  kills?: number;
  killstreak?: number;
  bestStreak?: number;
  playtime?: number; // s
  kits?: string[];
  kit?: string;
  looks?: string[];
  look?: string;
  hotbar?: ({ id: string; count: number } | null)[];
  selected?: number;
  daily?: { last: number; streak: number };
  seen?: Record<string, boolean>;
  settings?: Record<string, number | boolean>;
  boostKills?: number;
  mastery?: Record<string, number>; // kit id -> kills with it (client config MASTERY)
  borrow?: { id: string; kind: "trial" | "rent"; paid: number; used: boolean } | null; // a kit for one arena life (client KIT_TRIAL)
  trialDay?: number; // UTC day index the Kit of the Day trial was last used
  // server-only (never carried by a client save; they feed Boxity stats, leaderboards and badges)
  rating?: number;
  duelsWon?: number;
  duelsLost?: number;
  pvpKills?: number; // kills of other players the server credited (KitRoom.report)
  pvpBestStreak?: number; // best killstreak the server saw
  updatedAt?: Date;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isId = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9_]{1,32}$/.test(v);
const ids = (v: unknown, max = 128) => (Array.isArray(v) ? [...new Set(v.filter(isId))].slice(0, max) : undefined);

// The client's save (state.js), bounded. Unknown keys are dropped; the rating never passes.
export function sanitizeKitSave(m: unknown): Partial<KitDoc> | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  const B = KIT.save;
  const out: Partial<KitDoc> = {};
  const num = (k: keyof KitDoc, lo: number, hi: number, int = true) => {
    const v = o[k];
    if (finite(v)) (out as Record<string, number>)[k] = int ? Math.floor(clamp(v, lo, hi)) : clamp(v, lo, hi);
  };
  num("gold", 0, B.goldMax);
  num("level", 1, B.levelMax);
  num("xp", 0, B.goldMax);
  num("kills", 0, B.countMax);
  num("killstreak", 0, B.countMax);
  num("bestStreak", 0, B.countMax);
  num("playtime", 0, B.playtimeMax);
  num("boostKills", 0, 10000);
  num("selected", 0, 8);
  if (out.killstreak !== undefined) out.bestStreak = Math.max(out.bestStreak ?? 0, out.killstreak);
  const kits = ids(o.kits);
  if (kits) out.kits = kits;
  const looks = ids(o.looks);
  if (looks) out.looks = looks;
  if (isId(o.kit) && (!out.kits || out.kits.includes(o.kit))) out.kit = o.kit;
  if (isId(o.look) && (!out.looks || out.looks.includes(o.look))) out.look = o.look;
  if (Array.isArray(o.hotbar)) {
    out.hotbar = o.hotbar.slice(0, 9).map((s) => {
      const it = s as { id?: unknown; count?: unknown } | null;
      return it && isId(it.id) && finite(it.count) ? { id: it.id, count: Math.floor(clamp(it.count, 1, 9999)) } : null;
    });
    while (out.hotbar.length < 9) out.hotbar.push(null);
  }
  const d = o.daily as { last?: unknown; streak?: unknown } | undefined;
  if (d && finite(d.last) && finite(d.streak)) out.daily = { last: clamp(d.last, 0, 1e14), streak: Math.floor(clamp(d.streak, 0, 1000)) };
  // kit mastery: kills per kit id
  if (o.mastery && typeof o.mastery === "object" && !Array.isArray(o.mastery)) {
    const r: Record<string, number> = {};
    for (const [k, v] of Object.entries(o.mastery as Record<string, unknown>).slice(0, 128)) if (isId(k) && finite(v)) r[k] = Math.floor(clamp(v, 0, B.countMax));
    out.mastery = r;
  }
  // a borrowed kit (Kit of the Day trial / Gold rental) for the next arena life; null = none
  if (o.borrow === null) out.borrow = null;
  else if (o.borrow && typeof o.borrow === "object") {
    const b = o.borrow as Record<string, unknown>;
    if (isId(b.id) && (b.kind === "trial" || b.kind === "rent")) out.borrow = { id: b.id, kind: b.kind, paid: finite(b.paid) ? Math.floor(clamp(b.paid, 0, B.goldMax)) : 0, used: b.used === true };
  }
  num("trialDay", 0, 1e7);
  for (const key of ["seen", "settings"] as const) {
    const v = o[key];
    if (!v || typeof v !== "object") continue;
    const r: Record<string, number | boolean> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 16)) {
      if (!/^[a-zA-Z0-9_]{1,24}$/.test(k)) continue;
      if (typeof x === "boolean") r[k] = x;
      else if (finite(x)) r[k] = clamp(x, -1e6, 1e6);
    }
    (out as Record<string, unknown>)[key] = r;
  }
  return out;
}

export async function loadKit(userId: string): Promise<KitDoc | null | "error"> {
  const col = getKitPlayers();
  if (!col) return null;
  try {
    return (await col.findOne({ _id: userId })) ?? null;
  } catch (err) {
    console.warn("[kitStore] load failed", err);
    return "error";
  }
}
export async function saveKit(userId: string, name: string, patch: Partial<KitDoc>): Promise<boolean> {
  const col = getKitPlayers();
  if (!col) return false;
  try {
    await col.updateOne({ _id: userId }, { $set: { ...patch, name, updatedAt: new Date() } }, { upsert: true });
    return true;
  } catch (err) {
    console.warn("[kitStore] save failed", err);
    return false;
  }
}
// Server-only fields (rating, duel record).
export async function saveRating(userId: string, rating: number, won: boolean): Promise<void> {
  const col = getKitPlayers();
  if (!col) return;
  try {
    await col.updateOne({ _id: userId }, { $set: { rating }, $inc: won ? { duelsWon: 1 } : { duelsLost: 1 } }, { upsert: true });
  } catch (err) {
    console.warn("[kitStore] rating save failed", err);
  }
}

// Server-only: a credited player kill (+1) and the best killstreak so far.
export async function savePvpKill(userId: string, streak: number): Promise<void> {
  const col = getKitPlayers();
  if (!col) return;
  try {
    await col.updateOne({ _id: userId }, { $inc: { pvpKills: 1 }, $max: { pvpBestStreak: streak } }, { upsert: true });
  } catch (err) {
    console.warn("[kitStore] kill save failed", err);
  }
}

// --- Leaderboards: top saved players per stat, cached process-wide ----------------------------
export type BoardRow = { name: string; level: number; value: number };
export const BOARD_STATS = ["kills", "playtime", "gold", "rating"] as const;
export type BoardStat = (typeof BOARD_STATS)[number];
let cache: { at: number; boards: Record<BoardStat, (BoardRow & { id: string })[]> } | null = null;
export async function savedTops(now = Date.now()): Promise<Record<BoardStat, (BoardRow & { id: string })[]>> {
  if (cache && now - cache.at < KIT.boardEveryMs) return cache.boards;
  const boards = { kills: [], playtime: [], gold: [], rating: [] } as Record<BoardStat, (BoardRow & { id: string })[]>;
  const col = getKitPlayers();
  if (col) {
    for (const stat of BOARD_STATS) {
      try {
        const docs = await col.find({ [stat]: { $gt: 0 } }).sort({ [stat]: -1 }).limit(KIT.boardSize).toArray();
        boards[stat] = docs.map((d) => ({ id: d._id, name: d.name || "Player", level: d.level ?? 1, value: (d[stat] as number) ?? 0 }));
      } catch (err) {
        console.warn(`[kitStore] top ${stat} failed`, err);
      }
    }
  }
  cache = { at: now, boards };
  return boards;
}
export function __clearBoardCache() {
  cache = null;
}
