// Bluffer daily leaderboard.
// GET  /api/scores?day=3                       -> { top: [...] }
// POST /api/scores {day,name,bet,named,rare}  -> { ok, top, rank }
// POST /api/scores {type:"play",day,bet,named,rare,id} -> { pct, total }  (every finished game, for "better than X%")
// Storage: Upstash Redis (free) connected through Vercel. One sorted set per day: "lb:<day>".

const URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const LAUNCH = Date.UTC(2026, 9, 23); // day 1 = 23 Oct 2026
const STAKE = 150, EXTRA = 25, RARE = 100;

// scores added by hand (kept even if the database is empty)
const SEED = {
  3: [{ name: "Andrew Gough", bet: 30, named: 33, score: 4575 }],
};

// ---- name filter ----
// Bad anywhere in the name, even inside another word or with the spaces taken out (f u c k, fuuuck, f4ck).
const BAD_PART = ("fuck fuk fck phuk phuck fuq shit sht cunt kunt nigg niga nigr nigerz faggot fagot bitch biatch whore hoar slut rapey " +
  "nazi hitler heil swastika penis peen vagina vajay pussy pusy porn retard foreskin fourskin forskin jizz jism dildo " +
  "boob titty tittie titties wank twat bollock testic scrotum nutsack ballsack clit horny orgasm ejacul masturb fap " +
  "blowjob handjob rimjob footjob cumshot cumslut cumdump creampie bukake bukkake gangbang threesome deepthroat " +
  "molest incest bestial paedo pedophil pedofil kiddie nonce groomer " +
  "chink kike gook wetback tranny lesbo shemale coon " +
  "asshole arsehole bastard bellend skank schlong boner erection butthole buttplug butsex sperm semen condom viagra " +
  "nipple genital labia pubic pube hentai onlyfans milf dilf gilf bdsm fetish bondage stripper hooker prostitut " +
  "killyourself kys suicid selfharm cutyourself isis jihad terroris taliban alqaeda kkk klan whitepower siegheil 1488 " +
  "cocksuck dicksuck dickhead dickface cockhead knobhead fuckhead shithead motherf mofo wanker tosser minge fanny " +
  "pissflap pisshead cumbubble ballbag nobhead smegma pussi poonani punani bendover hughjass hughjazz mikehunt mikeoxlong mikeoxmall ligma sugma deeznut imahoe").split(" ");
// Bad only as a whole word (these show up inside real names: Hancock, Dickson, Cassidy, Scunthorpe...)
const BAD_WORD = new Set(("dick dicks cock cocks cum cums ass arse arses tit tits anal anus sex sexy sexx homo fag fags gay gays dyke poof poofter " +
  "spic spik paki pakis negro hoe hoes thot slag shag shagger prick pricks knob nob nobs muff gash poo poop piss crap turd fart farts " +
  "rape raped raping rapist nut nuts balls bum bums butt butts pedo kill die tard spaz spastic mong cripple jap japs nig wog wogs abo boong " +
  "loser idiot moron stupid dumb dumbass hore 69 420 666 admin bluffer moderator").split(" "));
const LEET = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "8": "b", "9": "g", "2": "z", "6": "g" };
const LOOK = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "к": "k", "м": "m", "н": "h", "т": "t", "в": "b", "ѕ": "s", "ԁ": "d", "ɡ": "g", "п": "n", "ґ": "r" };
function variants(name) {
  let t = String(name).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  t = t.replace(/./gu, (c) => LOOK[c] || c);
  const leet = t.replace(/./g, (c) => LEET[c] || c);
  const out = new Set();
  for (const x of [t, leet]) {
    const words = x.split(/[^a-z0-9]+/).filter(Boolean);
    const squash = words.join("");
    const dedup = squash.replace(/(.)\1+/g, "$1");
    out.add(JSON.stringify({ words, squash, dedup, wdedup: words.map((w) => w.replace(/(.)\1+/g, "$1")) }));
  }
  return [...out].map((j) => JSON.parse(j));
}
function isBad(name) {
  for (const v of variants(name)) {
    for (const p of BAD_PART) if (v.squash.includes(p) || (!/(.)\1/.test(p) && v.dedup.includes(p))) return true;
    for (const w of v.words.concat(v.wdedup)) if (BAD_WORD.has(w)) return true;
    // whole name squashed into one bad word ("d i c k", "c.u.m")
    if (BAD_WORD.has(v.squash) || BAD_WORD.has(v.dedup)) return true;
  }
  return false;
}
const BLOCK = { test: isBad };

async function redis(cmd) {
  const r = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error("db " + r.status);
  return (await r.json()).result;
}

const score = (bet, named, rare = 0) => (named >= bet ? bet * STAKE + (named - bet) * EXTRA : -(bet - named) * STAKE) + rare * RARE;
const today = () => Math.floor((Date.now() - LAUNCH) / 864e5) + 1;

async function top(day, n = 3) {
  let rows = [];
  if (URL && TOKEN) {
    const raw = await redis(["ZRANGE", `lb:${day}`, 0, n + 19, "REV", "WITHSCORES"]);
    for (let i = 0; i < raw.length; i += 2) {
      try {
        const r = { ...JSON.parse(raw[i]), score: Number(raw[i + 1]) };
        // bad names already on the board get removed for good
        if (isBad(r.name)) { redis(["ZREM", `lb:${day}`, raw[i]]).catch(() => {}); continue; }
        rows.push(r);
      } catch (e) {}
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
      const rare = Math.max(0, parseInt(b.rare, 10) || 0);
      // every finished game (anonymous) -> percentile
      if (b.type === "play") {
        const id = String(b.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 24);
        if (!(day >= today() - 1 && day <= today() + 1)) return res.status(400).json({ error: "closed" });
        if (!(bet >= 1 && bet <= 250 && named >= 0 && named <= 400 && rare <= Math.min(named, 6) && id.length >= 8)) return res.status(400).json({ error: "Invalid" });
        const ipp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
        const np = await redis(["INCR", `pl:${day}:${ipp}`]);
        if (np === 1) await redis(["EXPIRE", `pl:${day}:${ipp}`, 172800]);
        if (np > 60) return res.status(429).json({ error: "slow down" });
        const pts = score(bet, named, rare);
        await redis(["ZADD", `all:${day}`, pts, id]);
        await redis(["EXPIRE", `all:${day}`, 60 * 60 * 24 * 120]);
        const total = Number(await redis(["ZCARD", `all:${day}`]));
        const lower = Number(await redis(["ZCOUNT", `all:${day}`, "-inf", `(${pts}`]));
        const pct = total > 1 ? Math.round((lower / (total - 1)) * 100) : 100;
        return res.status(200).json({ pct, total });
      }
      const name = String(b.name || "").replace(/[^\p{L}\p{N} .'_-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 18);

      // only today's game (allowing for time zones), sensible numbers, a real name
      if (!(day >= today() - 1 && day <= today() + 1)) return res.status(400).json({ error: "That day's board is closed" });
      if (!(bet >= 1 && bet <= 250 && named >= 0 && named <= 400 && rare <= Math.min(named, 6))) return res.status(400).json({ error: "Invalid score" });
      if (name.length < 2) return res.status(400).json({ error: "Name needs at least 2 letters" });
      if (BLOCK.test(name)) return res.status(400).json({ error: "Pick a different name" });

      // spam guard: up to 5 submissions per connection per day (flatmates on the same wifi still get a go).
      // Each phone is also limited to one submission by the game itself.
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
      const n = await redis(["INCR", `ip:${day}:${ip}`]);
      if (n === 1) await redis(["EXPIRE", `ip:${day}:${ip}`, 172800]);
      if (n > 5) return res.status(429).json({ error: "Too many submissions from this connection today" });

      const pts = score(bet, named, rare);
      const member = JSON.stringify({ name, bet, named, rare, t: Date.now() });
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
