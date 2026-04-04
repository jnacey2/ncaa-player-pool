require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('./db');

// All known 2026 NCAA tournament dates — only generate commentary on these days
const TOURNAMENT_DATES = new Set([
  '20260318',             // First Four
  '20260319', '20260320', // First Round
  '20260321', '20260322', // Second Round
  '20260326', '20260327', // Sweet 16
  '20260328', '20260329', // Elite Eight
  '20260404',             // Final Four
  '20260407',             // Championship
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

  // Find which players have actually played at least one tournament game
  // (have any non-null pts in player_round_scores, blacked_out or not)
  const { rows: scoredPlayers } = await pool.query(
    `SELECT DISTINCT player_id FROM player_round_scores
     WHERE pts IS NOT NULL`
  );
  const hasPlayedSet = new Set(scoredPlayers.map(r => r.player_id));

  // Get player IDs so we can check hasPlayedSet
  const { rows: playerIds } = await pool.query(
    `SELECT id, owner, name FROM players`
  );
  const playerIdMap = {};
  playerIds.forEach(p => { playerIdMap[`${p.owner}:${p.name}`] = p.id; });

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
    const alive = teamPlayers.filter(p => !p.is_eliminated);
    const eliminated = teamPlayers.filter(p => p.is_eliminated);

    // Split alive players into: played (have actual game stats) vs waiting (game not yet played)
    const played = alive.filter(p => {
      const pid = playerIdMap[`${p.owner}:${p.name}`];
      return pid && hasPlayedSet.has(pid);
    });
    const waiting = alive.filter(p => {
      const pid = playerIdMap[`${p.owner}:${p.name}`];
      return !pid || !hasPlayedSet.has(pid);
    });

    const topScorer = [...teamPlayers].sort((a, b) => b.total_pts - a.total_pts)[0];

    summary += `#${rank} ${team.display_name}: ${team.total_pts} pts, ${team.players_remaining}/10 players alive\n`;

    if (played.length > 0) {
      summary += `  Played so far: ${played.map(p => `${p.name} [${p.ncaa_team}] (${p.total_pts} pts)`).join(', ')}\n`;
    }
    if (waiting.length > 0) {
      summary += `  Waiting to play: ${waiting.map(p => `${p.name} [${p.ncaa_team}]`).join(', ')}\n`;
    }
    if (eliminated.length > 0) {
      summary += `  Eliminated: ${eliminated.map(p => `${p.name} [${p.ncaa_team}]`).join(', ')}\n`;
    }
    if (topScorer && topScorer.total_pts > 0) {
      summary += `  Top scorer so far: ${topScorer.name} (${topScorer.total_pts} pts)\n`;
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

CRITICAL RULE — THE A$$: The person who finishes DEAD LAST in this pool is crowned "The A$$" and must pay DOUBLE the pool fees for THIS tournament — right now, this year, this pool. Not next year. They owe double immediately. This is the ultimate shame. Whenever you reference the last-place owner or anyone in serious danger of finishing last, you MUST work in the A$$ stakes. Make it clear what's at risk financially, right now.

Your job is to roast these people. This is a friend group — nobody is off limits. Mock bad draft decisions, celebrate lucky punts that paid off, skewer anyone whose team collapsed early. Think Bill Simmons meets a group chat that has gone completely off the rails. Be specific about player names and real draft decisions. The funnier and more cutting, the better — but keep it about basketball, not personal.

IMPORTANT CONTEXT — each owner's players are split into "Played so far" and "Waiting to play." An owner with 0 points but all their players still "Waiting to play" is NOT necessarily bad — their players just haven't tipped off yet. Reserve your harshest roasts for owners whose players HAVE played and still scored 0 or very little, or for owners who lost players to early eliminations. Don't mock someone for being at zero if their games literally haven't happened yet — mock them for who they drafted instead.

${standingsSummary}

Please write tournament commentary with four parts:

1. A "narrative" — 2-3 paragraphs of sharp, funny roast-style commentary. Mock the leaders for being lucky, mock the losers for their terrible picks, call out anyone whose "strategy" is clearly just vibes. Reference specific players and owners. No softballs — if someone's team got knocked out in the First Four, absolutely bury them. And make sure to flag whoever is currently in A$$ territory and what it means for their wallet.

2. A "team_blurbs" object — 1-2 sentences per owner that roasts their current situation. Praise is allowed only if it's backhanded. Zero-point teams deserve zero mercy. If an owner is near last place, mention the A$$ stakes explicitly. Use the display names provided.

3. A "top_3" array — your picks for the 3 owners most likely to WIN. Give a reason that's both accurate and a little snarky — even the winners deserve to be teased.

4. A "bottom_3" array — your picks for the 3 owners most likely to become The A$$ and owe double fees for THIS pool. Be brutally specific about why they're heading toward paying double right now.

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

function buildAnalyticsPrompt(standingsSummary) {
  return `You are a data analyst for the "Convertibles NCAA Tournament Player Pool 2026" — a fantasy basketball pool where 13 friends drafted 10 players each. Scoring = actual basketball points scored in each tournament game.

${standingsSummary}

Analyze this data and produce a structured analytics report. Be precise with numbers — use the data provided, do not fabricate stats. Where data is insufficient (e.g. no games played yet), say so honestly.

Return ONLY valid JSON:
{
  "player_leaders": [
    {"rank": 1, "name": "Player Name", "team": "NCAA Team", "owner": "Display Name", "pts": 22},
    ... (top 10 scorers across all owners, sorted by pts desc)
  ],
  "team_efficiency": [
    {"owner": "Display Name", "total_pts": 44, "players_played": 3, "avg_per_player": 14.7, "players_remaining": 9},
    ... (all 13 owners, sorted by avg_per_player desc)
  ],
  "round_summary": [
    {"round": "Play-In", "total_pts": 30, "games_completed": 2, "top_scorer": "Player Name", "top_scorer_pts": 25, "top_owner": "Display Name"},
    {"round": "R1", "total_pts": 450, "games_completed": 16, "top_scorer": "Player Name", "top_scorer_pts": 28, "top_owner": "Display Name"},
    ... (only rounds that have at least some completed games)
  ],
  "elimination_impact": [
    {"owner": "Display Name", "players_lost": 2, "names_lost": ["Player 1", "Player 2"], "impact": "Lost their highest-ceiling player early"},
    ... (only owners who have lost players, sorted by players_lost desc)
  ],
  "momentum": [
    {"owner": "Display Name", "trend": "up", "reason": "3 players scored 15+ in R1"},
    {"owner": "Display Name", "trend": "down", "reason": "Lost 2 players and top scorer only had 4 pts"},
    ... (all 13 owners, sorted: up first, then flat, then down)
  ],
  "matchups": [
    {"team1": "Display Name 1", "team2": "Display Name 2", "analysis": "Both have 8 players alive but Team1 has the higher ceiling with Duke players still in"},
    ... (2-3 interesting head-to-head matchups worth watching)
  ]
}`;
}

function extractJSON(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in Claude response');
  return JSON.parse(raw.slice(start, end + 1));
}

async function generateCommentary() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[commentary] No ANTHROPIC_API_KEY set — skipping');
    return;
  }

  console.log('[commentary] Generating commentary + analytics with Claude...');
  try {
    const standingsSummary = await buildStandingsSummary();
    const client = new Anthropic({ apiKey });

    // Generate commentary and analytics in parallel
    const [commentaryResult, analyticsResult] = await Promise.all([
      client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 2500,
        messages: [{ role: 'user', content: buildPrompt(standingsSummary) }],
      }),
      client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 3000,
        messages: [{ role: 'user', content: buildAnalyticsPrompt(standingsSummary) }],
      }),
    ]);

    const commentaryParsed = extractJSON(commentaryResult.content[0]?.text || '');
    if (!commentaryParsed.narrative || !commentaryParsed.team_blurbs) {
      throw new Error('Claude response missing narrative or team_blurbs');
    }

    let analyticsParsed = null;
    try {
      analyticsParsed = extractJSON(analyticsResult.content[0]?.text || '');
    } catch (err) {
      console.error('[commentary] Analytics parse error (non-fatal):', err.message);
    }

    await pool.query(
      `INSERT INTO commentary (narrative, team_blurbs, top_3, bottom_3, analytics) VALUES ($1, $2, $3, $4, $5)`,
      [
        commentaryParsed.narrative,
        JSON.stringify(commentaryParsed.team_blurbs),
        JSON.stringify(commentaryParsed.top_3 || []),
        JSON.stringify(commentaryParsed.bottom_3 || []),
        analyticsParsed ? JSON.stringify(analyticsParsed) : null,
      ]
    );

    console.log('[commentary] Commentary + analytics saved successfully');
  } catch (err) {
    console.error('[commentary] Error generating commentary:', err.message);
  }
}

function scheduleCommentary() {
  // Auto-generation suspended — commentary only updates when a user clicks Regenerate.
  // Re-enable the setInterval below when tournament games resume.
  console.log('[commentary] Auto-generation suspended — use Regenerate button for manual updates');
}

module.exports = { generateCommentary, scheduleCommentary };
