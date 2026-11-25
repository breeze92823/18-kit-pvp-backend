// Bloxity identity: the client sends Legion.SDK.auth.getToken() in its join options and the
// server checks it with the Bloxity API (docs: POST {BLOXITY_API_URL}/v1/auth/game-token/verify,
// Authorization: Bearer <token>, body { gameSlug }). Only the verified user is trusted; no token,
// a bad token or no network = a guest. Never take an id or a name for granted from the client.
export type VerifiedUser = { id: string; name: string };

const API = () => (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");
const SLUG = () => process.env.BLOXITY_GAME_SLUG || "kit-pvp";

export async function verifyToken(token: unknown): Promise<VerifiedUser | null> {
  if (typeof token !== "string" || token.length < 10 || token.length > 4096) return null;
  try {
    const res = await fetch(`${API()}/v1/auth/game-token/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ gameSlug: SLUG() }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { valid?: boolean; user?: { _id?: string; username?: string; displayName?: string } };
    const u = body?.user;
    if (!body?.valid || !u?._id) return null;
    const name = (u.displayName || u.username || "Player").replace(/[\u0000-\u001f<>]/g, "").slice(0, 40);
    return { id: String(u._id), name };
  } catch {
    return null;
  }
}
