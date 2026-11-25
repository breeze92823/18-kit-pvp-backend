// Keep in step with the client's src/config.js by hand.
// Kit PvP room size (players per arena; 2-100 for Bloxity party play). Also the deploy's roomSize.
export const ROOM_MAX_CLIENTS = 20;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// Presence (presence.ts): the Bloxity avatar JSON relayed for the others to draw, the most pets
// drawn per player, and the pose bounds (|x|, |y| and z up to `xy` m; z down to -`z` m: a race's
// track runs far down -Z; speed in m/s).
export const AVATAR_MAX_LEN = 3000;
export const PRESENCE_PETS_MAX = 8;
export const POSE_BOUNDS = { xy: 5000, z: 1e8, speed: 2000 };

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot store a bogus number. Generous
// ceilings, not game rules: the dearest engine costs ~3.6e28 Wins (client ENGINE gems).
export const CURRENCY_MAX = 1e33; // trophies (Wins), gems, lightning (energy)
export const REBIRTHS_MAX = 1e9;
export const DISTANCE_MAX = 1e15; // personal best race distance, studs
export const PLAY_SECONDS_MAX = 31_536_000; // ~1 year

// Owned catalog ids (client BOATS.list ~20, ENGINE ~34, PARTNER ~20, TRAILS ~29), with slack.
export const OWNED_MAX = 256;
// Pets (client PETS): at most PETS_MAX owned, PET_TIERS_MAX craft tiers, slots / storage the
// counters can grow to.
export const PETS_MAX = 1000;
export const PET_TIERS_MAX = 16;
export const PET_SLOTS_MAX = 50;
// Online Gifts (client GIFTS.list, 12 of them): claimed indexes and potion counts.
export const GIFTS_MAX = 64;
export const POTION_KINDS_MAX = 32;
export const POTION_COUNT_MAX = 1e9;
// Daily Reward (client DAILY.days): days in one calendar cycle.
export const DAILY_DAYS = 7;

// Spin wheel (client SPIN in config.js; spin.ts): one free spin every SPIN_EVERY_MS, stored up
// to SPIN_CAP; a new player starts with SPIN_START. SPINS_MAX bounds a saved count.
export const SPIN_EVERY_MS = 15 * 60 * 1000;
export const SPIN_CAP = 5;
export const SPIN_START = 1;
export const SPINS_MAX = 1e6;
// The wedges' prizes and odds (weights in %). Ids match the client's SPIN.wedges; the client
// decides what each prize is, the server only which one is won.
export const SPIN_WEDGES = [
  { id: "doubleWins", weight: 35 },
  { id: "wins50", weight: 25 },
  { id: "luck", weight: 35 },
  { id: "wins250", weight: 4.9 },
  { id: "hugePet", weight: 0.1 },
] as const;

// Leaderboards (leaderboard.ts; client plaza.js boards): the saved doc fields ranked (Rebirth,
// Wins, Power, Playtime), rows per board and how often the lists are re-read and re-sent.
export const LEADERBOARD_STATS = ["rebirths", "trophies", "energy", "playtime"] as const;
export type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Ids from the client's catalogs (boats, engines incl. `ladder-N`, partners, trails, pet kinds,
// potions): camelCase slugs, so nothing odd is stored.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";

// Gold a verified rewarded ad pays (the client grants it; the server only checks the ad token).
export const AD_REWARD_GOLD = 150;

// --- Kit PvP (KitRoom.ts, kitRelay.ts). Keep in step with the client's src/net.js + combat.js.
export const KIT = {
  // rewarded ads (boxity/ads.ts): placement name, Gold paid, per-session cooldown and cap
  ad: { placement: "bonus-gold", gold: AD_REWARD_GOLD, cooldownMs: 60_000, maxPerSession: 20 },
  killGapMs: 3000, // at most one counted player kill per killer per this long (Boxity stats/boards/badges)
  emotesPerSecond: 1, // Boxity emote relay (opaque 24-hex catalogue ids)
  zones: ["lobby", "drop", "arena", "dead", "duel"],
  // damage kinds (client combat.js damage() opts.kind)
  kinds: ["melee", "arrow", "projectile", "explosion", "fire", "poison", "lightning", "magic", "sting", "fall", "lava", "void"],
  statuses: ["slow", "freeze", "root", "invis", "mark", "speed", "shieldBroken"],
  bounds: { xz: 900, yMin: -400, yMax: 200, speed: 80 }, // the duel platforms sit at x ~ 400..700
  maxHit: 40, // largest single hit (before the victim's armor)
  hitRange: 48, // m between attacker and victim (arrows, tridents, sonic booms)
  hitsPerSecond: 25, // per sender (bees, turrets and areas add up)
  actsPerSecond: 20,
  fxPerSecond: 30,
  fxBytes: 2048, // one cosmetic event
  botsBytes: 16384, // one bots snapshot from the host
  reconnectSeconds: 10,
  // saves (kitStore.ts)
  save: { goldMax: 1e12, levelMax: 100000, countMax: 1e9, playtimeMax: 31_536_000 },
  saveEveryMs: 2000, // a session's saves are written at most this often
  boardSize: 10,
  boardEveryMs: 30_000, // leaderboard cache + broadcast
  // duels (KitRoom.ts): 1v1 on one of `slots` platforms (the client's DUEL.slots), first to `wins`
  duel: { slots: 4, wins: 3, countdownMs: 3000, betweenMs: 2500, k: 32, startRating: 1000, ratingMin: 100, ratingMax: 4000 },
};
