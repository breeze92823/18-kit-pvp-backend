// Kit PvP relay rules (KitRoom.ts): bounds every message a client sends before it is stored
// in the roster or forwarded. The game is client-authoritative (the victim's client applies
// damage with its own armor/shield/kit powers); the server only keeps the numbers sane, checks
// that attacker and victim are both in the arena and near each other, and rate-limits hits.
import { KIT } from "./constants.js";
import type { KitPlayer } from "./rooms/schema/KitState.js";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const num = (v: unknown, min: number, max: number, dflt = 0) => (finite(v) ? clamp(v, min, max) : dflt);
const isId = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9_]{1,32}$/.test(v);

// `pose` (~15/s): position, look, hp, flags and what is in hand.
export function applyPose(p: KitPlayer, m: unknown): void {
  if (!m || typeof m !== "object") return;
  const o = m as Record<string, unknown>;
  const B = KIT.bounds;
  if (finite(o.x)) p.x = clamp(o.x, -B.xz, B.xz);
  if (finite(o.y)) p.y = clamp(o.y, B.yMin, B.yMax);
  if (finite(o.z)) p.z = clamp(o.z, -B.xz, B.xz);
  if (finite(o.yaw)) p.yaw = Math.atan2(Math.sin(o.yaw), Math.cos(o.yaw));
  if (finite(o.pitch)) p.pitch = clamp(o.pitch, -1.6, 1.6);
  if (finite(o.speed)) p.speed = clamp(o.speed, 0, B.speed);
  if (finite(o.vx)) p.vx = clamp(o.vx, -B.speed, B.speed);
  if (finite(o.vy)) p.vy = clamp(o.vy, -B.speed, B.speed);
  if (finite(o.vz)) p.vz = clamp(o.vz, -B.speed, B.speed);
  if (finite(o.hp)) p.hp = clamp(o.hp, -10, 40);
  if (Number.isInteger(o.flags)) p.flags = clamp(o.flags as number, 0, 0xffff);
  if (Number.isInteger(o.swing)) p.swing = (o.swing as number) & 255;
  if (typeof o.zone === "string" && (KIT.zones as readonly string[]).includes(o.zone)) p.zone = o.zone;
  if (isId(o.kit)) p.kit = o.kit;
  if (o.item === "" || isId(o.item)) p.item = o.item as string;
}

// The extra hit options a client may forward (combat.js damage() opts), bounded.
const BOOL_OPTS = ["crit", "sprint", "noKb", "noFlinch", "ignoreIframes", "ignoreShield", "pierce", "weaponHit"] as const;
export function sanitizeHit(m: unknown): { amount: number; opts: Record<string, unknown> } | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  const amount = num(o.amount, 0, KIT.maxHit, -1);
  if (amount < 0) return null;
  const src = (o.opts && typeof o.opts === "object" ? o.opts : {}) as Record<string, unknown>;
  const opts: Record<string, unknown> = {};
  opts.kind = typeof src.kind === "string" && (KIT.kinds as readonly string[]).includes(src.kind) ? src.kind : "melee";
  for (const k of BOOL_OPTS) if (src[k] === true) opts[k] = true;
  if (finite(src.kb)) opts.kb = clamp(src.kb, 0, 4);
  if (finite(src.kbScale)) opts.kbScale = clamp(src.kbScale, 0, 5);
  if (finite(src.upScale)) opts.upScale = clamp(src.upScale, 0, 3);
  for (const k of ["dir", "from"] as const) {
    const v = src[k] as Record<string, unknown> | undefined;
    if (v && finite(v.x) && finite(v.z)) opts[k] = { x: clamp(v.x, -KIT.bounds.xz, KIT.bounds.xz), z: clamp(v.z, -KIT.bounds.xz, KIT.bounds.xz) };
  }
  return { amount, opts };
}

// `act`: a status / ignite / push / teleport on someone else (abilities, on-hit effects).
export function sanitizeAct(m: unknown): Record<string, unknown> | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case "status":
      if (typeof o.key !== "string" || !(KIT.statuses as readonly string[]).includes(o.key)) return null
      return { type: "status", key: o.key, s: num(o.s, 0, 12) };
    case "ignite":
      return { type: "ignite", s: num(o.s, 0, 12), mul: num(o.mul, 0, 3, 1) };
    case "push":
      return { type: "push", x: num(o.x, -40, 40), y: num(o.y, -40, 40), z: num(o.z, -40, 40) };
    case "teleport": {
      const B = KIT.bounds;
      if (!finite(o.x) || !finite(o.y) || !finite(o.z)) return null;
      return { type: "teleport", x: clamp(o.x, -B.xz, B.xz), y: clamp(o.y, B.yMin, B.yMax), z: clamp(o.z, -B.xz, B.xz) };
    }
  }
  return null;
}

// Cosmetic payloads (`fx`, `bots`) are relayed as sent, only size-capped.
export const fitsBytes = (m: unknown, max: number): boolean => {
  try {
    return JSON.stringify(m).length <= max;
  } catch {
    return false;
  }
};

export const cleanName = (v: unknown): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f<>]/g, "").slice(0, 40) : "");

// Sliding one-second window: at most `max` events per sender.
export class RateLimit {
  private hits = new Map<string, number[]>();
  constructor(private max: number) {}
  allow(id: string, now = Date.now()): boolean {
    const list = (this.hits.get(id) ?? []).filter((t) => now - t < 1000);
    if (list.length >= this.max) {
      this.hits.set(id, list);
      return false;
    }
    list.push(now);
    this.hits.set(id, list);
    return true;
  }
  forget(id: string) {
    this.hits.delete(id);
  }
}
