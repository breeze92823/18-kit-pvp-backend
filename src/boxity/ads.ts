import { KIT } from "../constants.js";
import { boxityEnv, postJson } from "./env.js";

// Rewarded ads (docs: add rewarded ads): the client shows the ad, sends the reward token here, the
// server checks it with Boxity (each token works once, for this game, within 5 minutes) and tells the
// client to grant the Gold. The save is client-authoritative, so the server never writes gold itself.
export type AdDenied = "placement" | "guest" | "cooldown" | "limit" | "token" | "invalid";

// Per-session cooldown + cap.
export class AdGate {
  private state = new Map<string, { last: number; count: number }>();
  // null = allowed (and the attempt counted); otherwise why not
  check(sid: string, now = Date.now()): "cooldown" | "limit" | null {
    const s = this.state.get(sid) ?? { last: -Infinity, count: 0 };
    if (s.count >= KIT.ad.maxPerSession) return "limit";
    if (now - s.last < KIT.ad.cooldownMs) return "cooldown";
    this.state.set(sid, { last: now, count: s.count + 1 });
    return null;
  }
  // a rejected token does not burn the cooldown
  refund(sid: string) {
    const s = this.state.get(sid);
    if (s) this.state.set(sid, { last: -Infinity, count: Math.max(0, s.count - 1) });
  }
  forget(sid: string) {
    this.state.delete(sid);
  }
}

// POST {api}/v1/ads/reward/verify { gameSlug, rewardToken } -> valid only on `valid: true`.
export async function verifyAdToken(token: string): Promise<boolean> {
  const env = boxityEnv();
  const res = await postJson(`${env.apiUrl}/v1/ads/reward/verify`, { gameSlug: env.gameSlug, rewardToken: token }, "", 5000);
  return res.status >= 200 && res.status < 300 && res.body?.valid === true;
}
