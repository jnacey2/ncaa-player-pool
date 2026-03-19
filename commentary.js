require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('./db');

// All known 2026 NCAA tournament dates — only generate commentary on these days
const TOURNAMENT_DATES = new Set([
  '20260318', '20260319',
  '20260320', '20260321',
  '20260322', '20260323',
  '20260327', '20260328',
  '20260329', '20260330',
  '20260405',
  '20260407',
]);

function isTournamentDay() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    .replace(/-/g, '');
  return TOURNAMENT_DATES.has(today);
}

// Build the standings summary to inject into the prompt
async function buildStandingsSummary() {
  const { rows: teams } = await pool.query(
    `SELECT ft.owner, COALESCE(ft.display_name, ft.owner) AS display_name,
            ft.total_pts, ft.players_remaining
     FROM fantasy_teams ft
     ORDER BY ft.total_pts DESC`
  );

  const { rows: players } = await pool.query(
    `SELECT p.owner, p.name, p.ncaa_team, p.is_eliminated, p.total_pts, p.is_playing_now
     FROM players p
     ORDER BY p.owner, p.draft_pick ASC NULLS LAST`
  );

  const { rows: recentAlerts } = await pool.query(
    `SELECT message FROM alerts
     ORDER BY created_at DESC LIMIT 10`
  );

  // Build per-team player lists
  const playersByOwner = {};
  players.forEach(p => {
    if (!playersByOwner[p.owner]) playersByOwner[p.owner] = [];
    playersByOwner[p.owner].push(p);
  });

  let summary = 'CURRENT STANDINGS:\n\n';
  teams.forEach((team, idx) => {
    const rank = idx + 1;
    const teamPlayers = playersByOwner[team.owner] || [];
    const alive = teamPlayers.filter(p => !p.is_eliminated).map(p => p.name);
    const eliminated = teamPlayers.filter(p => p.is_eliminated).map(p => p.name);
    const topScorer = [...teamPlayers].sort((a, b) => b.total_pts - a.total_pts)[0];

    summary += `#${rank} ${team.display_name}: ${team.total_pts} pts, ${team.players_remaining}/10 players alive\n`;
    summary += `  Alive: ${alive.join(', ') || 'none'}\n`;
    if (eliminated.length) summary += `  Eliminated: ${eliminated.join(', ')}\n`;
    if (topScorer && topScorer.total_pts > 0) {
      summary += `  Top scorer: ${topScorer.name} (${topScorer.total_pts} pts)\n`;
    }
    summary += '\n';
  });

  if (recentAlerts.length) {
    summary += 'RECENT EVENTS:\n';
    recentAlerts.forEach(a => { summary += `- ${a.message}\n`; });
  }

  return summary;
}

function buildPrompt(standingsSummary) {
  return `You are a savage but lovable sports commentator covering the "Convertibles NCAA Tournament Player Pool 2026" — a fantasy basketball pool where 13 friends drafted 10 players each. Scoring is simple: you earn the actual points your players score in each tournament game. Eliminated teams score nothing going forward.

Your job is to roast these people. This is a friend group — nobody is off limits. Mock bad draft decisions, celebrate lucky punts that paid off, skewer anyone whose team collapsed early, and mercilessly mock anyone sitting at zero points. Think Bill Simmons meets a group chat that has gone completely off the rails. Be specific about player names and real draft decisions. The funnier and more cutting, the better — but keep it about basketball, not personal.

${standingsSummary}

Please write tournament commentary with four parts:

1. A "narrative" — 2-3 paragraphs of sharp, funny roast-style commentary. Mock the leaders for being lucky, mock the losers for their terrible picks, call out anyone whose "strategy" is clearly just vibes. Reference specific players and owners. No softballs — if someone's team got knocked out in the First Four, absolutely bury them.

2. A "team_blurbs" object — 1-2 sentences per owner that roasts their current situation. Praise is allowed only if it's backhanded. Zero-point teams deserve zero mercy. Use the display names provided.

3. A "top_3" array — your picks for the 3 owners most likely to WIN. Give a reason that's both accurate and a little snarky — even the winners deserve to be teased.

4. A "bottom_3" array — your picks for the 3 owners most likely to finish last. Be brutally honest about why their team is cooked.

Return ONLY valid JSON in this exact format, with no markdown code fences or extra text:
{
  "narrative": "paragraph one\\n\\nparagraph two\\n\\nparagraph three",
  "team_blurbs": {
    "DisplayName1": "blurb text",
    "DisplayName2": "blurb text"
  },
  "top_3": [
    { "owner": "DisplayName", "reason": "one sentence why they will win" },
    { "owner": "DisplayName", "reason": "one sentence why they will win" },
    { "owner": "DisplayName", "reason": "one sentence why they will win" }
  ],
  "bottom_3": [
    { "owner": "DisplayName", "reason": "one sentence why they are in trouble" },
    { "owner": "DisplayName", "reason": "one sentence why they are in trouble" },
    { "owner": "DisplayName", "reason": "one sentence why they are in trouble" }
  ]
}`;
}

async function generateCommentary() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[commentary] No ANTHROPIC_API_KEY set — skipping');
    return;
  }

  console.log('[commentary] Generating commentary with Claude...');
  try {
    const standingsSummary = await buildStandingsSummary();
    const prompt = buildPrompt(standingsSummary);

    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0]?.text || '';

    // Extract the outermost JSON object regardless of surrounding text or markdown
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found in Claude response');
    const parsed = JSON.parse(raw.slice(start, end + 1));

    if (!parsed.narrative || !parsed.team_blurbs) {
      throw new Error('Claude response missing narrative or team_blurbs');
    }

    await pool.query(
      `INSERT INTO commentary (narrative, team_blurbs, top_3, bottom_3) VALUES ($1, $2, $3, $4)`,
      [
        parsed.narrative,
        JSON.stringify(parsed.team_blurbs),
        JSON.stringify(parsed.top_3 || []),
        JSON.stringify(parsed.bottom_3 || []),
      ]
    );

    console.log('[commentary] Commentary saved successfully');
  } catch (err) {
    console.error('[commentary] Error generating commentary:', err.message);
  }
}

function scheduleCommentary() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[commentary] No API key — commentary scheduler disabled');
    return;
  }

  // Run every 2 hours, but only on tournament days
  setInterval(() => {
    if (isTournamentDay()) {
      generateCommentary();
    } else {
      console.log('[commentary] Not a tournament day — skipping scheduled generation');
    }
  }, 2 * 60 * 60 * 1000);

  console.log('[commentary] Scheduler started — will generate every 2h on game days');

  // Generate once on startup if it's a tournament day and no recent commentary exists
  if (isTournamentDay()) {
    pool.query(`SELECT generated_at FROM commentary ORDER BY generated_at DESC LIMIT 1`)
      .then(({ rows }) => {
        const lastGenerated = rows[0]?.generated_at;
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        if (!lastGenerated || new Date(lastGenerated) < twoHoursAgo) {
          console.log('[commentary] Generating initial commentary on startup...');
          generateCommentary();
        }
      })
      .catch(() => generateCommentary());
  }
}

module.exports = { generateCommentary, scheduleCommentary };
