// Bluffer daily leaderboard.
// GET  /api/scores?day=3                       -> { top: [...] }
// POST /api/scores {day,name,bet,named}       -> { ok, top, rank }
// Storage: Upstash Redis (free) connected through Vercel. One sorted set per day: "lb:<day>".

const URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const LAUNCH = Date.UTC(2026, 9, 23); // day 1 = 23 Oct 2026
const STAKE = 150, EXTRA = 25;

// scores added by hand (kept even if the database is empty)
const SEED = {
  3: [{ name: "Andrew Gough", bet: 30, named: 33, score: 4575 }],
};

const BLOCK = /(fuck|shit|cunt|nigg|fag|bitch|whore|slut|rape|nazi|hitler|penis|vagina|dick|cock|pussy|porn|retard)/i;

async function redis(cmd) {
  const r = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error("db " + r.status);
  return (await r.json()).result;
}

const score = (bet, named) => (named >= bet ? bet * STAKE + (named - bet) * EXTRA : -(bet - named) * STAKE);
const today = () => Math.floor((Date.now() - LAUNCH) / 864e5) + 1;

async function top(day, n = 10) {
  let rows = [];
  if (URL && TOKEN) {
    const raw = await redis(["ZRANGE", `lb:${day}`, 0, n - 1, "REV", "WITHSCORES"]);
    for (let i = 0; i < raw.length; i += 2) {
      try { rows.push({ ...JSON.parse(raw[i]), score: Number(raw[i + 1]) }); } catch (e) {}
    }
  }
  rows = rows.concat(SEED[day] || []);
  rows.sort((a, b) => b.score - a.score || a.bet - b.bet);
  return rows.slice(0, n).map(({ name, bet, named, score }) => ({ name, bet, named, score }));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method === "GET") {
      const day = parseInt(req.query.day, 10) || today();
      return res.status(200).json({ day, top: await top(day) });
    }

    if (req.method === "POST") {
      if (!URL || !TOKEN) return res.status(503).json({ error: "Leaderboard isn't connected yet" });
      const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const day = parseInt(b.day, 10);
      const bet = parseInt(b.bet, 10);
      const named = parseInt(b.named, 10);
      const name = String(b.name || "").replace(/[^\p{L}\p{N} .'_-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 18);

      // only today's game (allowing for time zones), sensible numbers, a real name
      if (!(day >= today() - 1 && day <= today() + 1)) return res.status(400).json({ error: "That day's board is closed" });
      if (!(bet >= 1 && bet <= 250 && named >= 0 && named <= 400)) return res.status(400).json({ error: "Invalid score" });
      if (name.length < 2) return res.status(400).json({ error: "Name needs at least 2 letters" });
      if (BLOCK.test(name)) return res.status(400).json({ error: "Pick a different name" });

      // spam guard: up to 5 submissions per connection per day (flatmates on the same wifi still get a go).
      // Each phone is also limited to one submission by the game itself.
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
      const n = await redis(["INCR", `ip:${day}:${ip}`]);
      if (n === 1) await redis(["EXPIRE", `ip:${day}:${ip}`, 172800]);
      if (n > 5) return res.status(429).json({ error: "Too many submissions from this connection today" });

      const pts = score(bet, named);
      const member = JSON.stringify({ name, bet, named, t: Date.now() });
      await redis(["ZADD", `lb:${day}`, pts, member]);
      await redis(["EXPIRE", `lb:${day}`, 60 * 60 * 24 * 120]);
      const higher = Number(await redis(["ZCOUNT", `lb:${day}`, `(${pts}`, "+inf"])) + (SEED[day] || []).filter((r) => r.score > pts).length;
      const rank = higher + 1;
      return res.status(200).json({ ok: true, rank, score: pts, top: await top(day) });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: "Leaderboard is having a moment, try again" });
  }
};
