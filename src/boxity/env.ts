// Boxity hosting environment (read on every call so tests can change it). Never hardcode hosts:
// BLOXITY_API_URL is the API of the environment this deploy runs in (prod or stage).
export interface BoxityEnv {
  apiUrl: string;
  gameSlug: string; // BLOXITY_GAME_SLUG, else BLOXITY_GAME_ID, else "18-kit-pvp" (auth.ts uses the same default)
  gameSlugSet: boolean; // BLOXITY_GAME_SLUG was actually provided (badges send it only then)
  gameId: string; // "" when not deployed by Boxity hosting
  reportToken: string; // "" when not deployed by Boxity hosting
}

export function boxityEnv(): BoxityEnv {
  const slug = process.env.BLOXITY_GAME_SLUG || "";
  return {
    apiUrl: (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, ""),
    // this game's slug = its hosting id (LEGION_GAME_ID). "kit-pvp" is ANOTHER game on Boxity.
    gameSlug: slug || process.env.BLOXITY_GAME_ID || "18-kit-pvp",
    gameSlugSet: !!slug,
    gameId: process.env.BLOXITY_GAME_ID || "",
    reportToken: process.env.BLOXITY_REPORT_TOKEN || "",
  };
}

// The reporting credentials, or null in local development (every reporter is then a no-op).
export function reportEnv(): (BoxityEnv & { gameId: string; reportToken: string }) | null {
  const e = boxityEnv();
  return e.gameId && e.reportToken ? e : null;
}

export interface HttpResult {
  status: number;
  body: any;
}

// POST JSON with a hard timeout. Never throws: a network failure is { status: 0 }.
export async function postJson(url: string, body: unknown, token: string, timeoutMs: number): Promise<HttpResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let parsed: any = null;
    try {
      parsed = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, body: parsed };
  } catch {
    return { status: 0, body: null };
  }
}

export const legionId = (userId: string) => `legion_${userId}`;
