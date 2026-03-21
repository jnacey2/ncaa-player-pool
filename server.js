require('dotenv').config();
const express = require('express');
const path = require('path');
const { pool, initSchema } = require('./db');
const { seed } = require('./seed');
const { startScheduler } = require('./scraper');
const { generateCommentary, scheduleCommentary } = require('./commentary');
const { resolveTeamMappings, getTeamMappings, resolvePlayerNames, refreshAllPlayerNames } = require('./mapping');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/standings — all fantasy teams with per-player, per-round breakdown
app.get('/api/standings', async (req, res) => {
  try {
    const { rows: teams } = await pool.query(
      `SELECT owner, COALESCE(display_name, owner) AS display_name, total_pts, players_remaining
       FROM fantasy_teams
       ORDER BY total_pts DESC, display_name ASC`
    );

    const { rows: players } = await pool.query(
      `SELECT p.id, p.owner, p.name, p.ncaa_team, p.position,
              p.draft_pick, p.is_eliminated, p.is_playing_now, p.total_pts
       FROM players p
       ORDER BY p.owner, p.draft_pick ASC NULLS LAST`
    );

    const { rows: roundScores } = await pool.query(
      `SELECT prs.player_id, prs.round_num, prs.pts, prs.blacked_out
       FROM player_round_scores prs`
    );

    // Build lookup: playerId → { round_num: { pts, blacked_out } }
    const scoreMap = {};
    for (const rs of roundScores) {
      if (!scoreMap[rs.player_id]) scoreMap[rs.player_id] = {};
      scoreMap[rs.player_id][rs.round_num] = {
        pts: rs.pts,
        blacked_out: rs.blacked_out,
      };
    }

    // Attach players + round scores to teams
    const teamMap = {};
    for (const team of teams) {
      teamMap[team.owner] = { ...team, players: [] };
    }

    for (const player of players) {
      const rounds = scoreMap[player.id] || {};
      const roundData = [];
      for (let r = 0; r <= 6; r++) {
        roundData.push({
          round: r,
          pts: rounds[r]?.pts ?? null,
          blacked_out: rounds[r]?.blacked_out ?? false,
        });
      }
      if (teamMap[player.owner]) {
        teamMap[player.owner].players.push({ ...player, rounds: roundData });
      }
    }

    // Compute ceiling (max possible score) for each team
    const DEFAULT_PPG = 10; // fallback when a player has no games yet
    const result = Object.values(teamMap).map(team => {
      let ceiling = team.total_pts;
      for (const player of team.players) {
        if (player.is_eliminated) continue;
        const gamesPlayed = player.rounds.filter(r => !r.blacked_out && r.pts !== null).length;
        const avgPpg = gamesPlayed > 0 ? player.total_pts / gamesPlayed : DEFAULT_PPG;
        const roundsLeft = player.rounds.filter(r => !r.blacked_out && r.pts === null).length;
        ceiling += avgPpg * roundsLeft;
      }
      return { ...team, max_possible_pts: Math.round(ceiling) };
    });

    res.json(result);
  } catch (err) {
    console.error('/api/standings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/games — tournament games grouped by date
app.get('/api/games', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT espn_game_id, round_num, home_team, away_team,
              home_score, away_score, status, tip_time, game_date,
              display_clock, period, tv_network, home_seed, away_seed
       FROM games
       ORDER BY
         CASE status WHEN 'live' THEN 0 WHEN 'pre' THEN 1 ELSE 2 END,
         game_date ASC,
         tip_time ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('/api/games error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bracket — all bracket slot data
app.get('/api/bracket', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT espn_team_id, team_name, team_abbrev, seed, region,
              current_round, is_eliminated, eliminated_in_round
       FROM bracket_slots
       ORDER BY region, seed`
    );
    res.json(rows);
  } catch (err) {
    console.error('/api/bracket error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/last-updated — timestamp of last successful scrape
app.get('/api/last-updated', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT scraped_at, status, message
       FROM scrape_log
       ORDER BY scraped_at DESC
       LIMIT 1`
    );
    res.json(rows[0] || { scraped_at: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/commentary — most recent commentary
app.get('/api/commentary', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT narrative, team_blurbs, top_3, bottom_3, analytics, generated_at
       FROM commentary
       ORDER BY generated_at DESC
       LIMIT 1`
    );
    res.json(rows[0] || { narrative: null, team_blurbs: null, generated_at: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/commentary/regenerate — manually trigger a new generation
app.post('/api/commentary/regenerate', async (req, res) => {
  try {
    res.json({ ok: true, message: 'Regenerating commentary in background...' });
    generateCommentary(); // fire and forget
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mapping/refresh-names — full re-scan of all player names via Claude
// Returns a summary of format fixes (espn_name only) and nickname fixes (name + CSV updated)
app.post('/api/mapping/refresh-names', async (req, res) => {
  try {
    res.json({ ok: true, message: 'Player name refresh started — check server logs for results.' });
    const changes = await refreshAllPlayerNames();
    console.log('[server] Player name refresh done:', JSON.stringify(changes));
  } catch (err) {
    console.error('[server] Player name refresh error:', err.message);
  }
});

// GET /api/analytics — computed from real DB data (not LLM-generated)
app.get('/api/analytics', async (req, res) => {
  try {
    // Top scorers: individual players ranked by total_pts
    const { rows: playerLeaders } = await pool.query(`
      SELECT p.name, p.ncaa_team AS team,
             COALESCE(ft.display_name, p.owner) AS owner,
             p.total_pts AS pts, p.is_eliminated
      FROM players p
      JOIN fantasy_teams ft ON ft.owner = p.owner
      WHERE p.total_pts > 0
      ORDER BY p.total_pts DESC
      LIMIT 10
    `);

    // Team efficiency: per-owner stats
    const { rows: teamEfficiency } = await pool.query(`
      SELECT
        COALESCE(ft.display_name, ft.owner) AS owner,
        ft.total_pts,
        ft.players_remaining,
        (SELECT COUNT(*) FROM players p2
         JOIN player_round_scores prs ON prs.player_id = p2.id
         WHERE p2.owner = ft.owner AND prs.pts IS NOT NULL
         GROUP BY p2.owner) AS players_played,
        CASE
          WHEN (SELECT COUNT(DISTINCT p3.id) FROM players p3
                JOIN player_round_scores prs2 ON prs2.player_id = p3.id
                WHERE p3.owner = ft.owner AND prs2.pts IS NOT NULL) > 0
          THEN ROUND(ft.total_pts::numeric / (
            SELECT COUNT(DISTINCT p3.id) FROM players p3
            JOIN player_round_scores prs2 ON prs2.player_id = p3.id
            WHERE p3.owner = ft.owner AND prs2.pts IS NOT NULL
          ), 1)
          ELSE 0
        END AS avg_per_player
      FROM fantasy_teams ft
      ORDER BY avg_per_player DESC
    `);

    // Round breakdown: actual pts per round from player_round_scores
    const { rows: roundBreakdown } = await pool.query(`
      SELECT
        prs.round_num,
        SUM(prs.pts) AS total_pts,
        COUNT(DISTINCT prs.player_id) AS players_scored
      FROM player_round_scores prs
      WHERE prs.pts IS NOT NULL AND prs.blacked_out = FALSE
      GROUP BY prs.round_num
      ORDER BY prs.round_num
    `);

    // Top scorer per round
    const { rows: roundTopScorers } = await pool.query(`
      SELECT DISTINCT ON (prs.round_num)
        prs.round_num, prs.pts AS top_pts,
        p.name AS top_scorer, p.ncaa_team AS top_team,
        COALESCE(ft.display_name, p.owner) AS top_owner
      FROM player_round_scores prs
      JOIN players p ON p.id = prs.player_id
      JOIN fantasy_teams ft ON ft.owner = p.owner
      WHERE prs.pts IS NOT NULL AND prs.blacked_out = FALSE
      ORDER BY prs.round_num, prs.pts DESC
    `);

    const ROUND_NAMES = ['Play-In', 'R1', 'R2', 'S16', 'E8', 'F4', 'Champ'];
    const roundSummary = roundBreakdown.map(r => {
      const topScorer = roundTopScorers.find(ts => ts.round_num === r.round_num);
      return {
        round: ROUND_NAMES[r.round_num] || `Round ${r.round_num}`,
        round_num: r.round_num,
        total_pts: parseInt(r.total_pts),
        players_scored: parseInt(r.players_scored),
        top_scorer: topScorer?.top_scorer || null,
        top_scorer_team: topScorer?.top_team || null,
        top_scorer_pts: topScorer?.top_pts || null,
        top_owner: topScorer?.top_owner || null,
      };
    });

    // Elimination impact: who lost players
    const { rows: elimImpact } = await pool.query(`
      SELECT
        COALESCE(ft.display_name, p.owner) AS owner,
        COUNT(*) AS players_lost,
        ARRAY_AGG(p.name ORDER BY p.name) AS names_lost
      FROM players p
      JOIN fantasy_teams ft ON ft.owner = p.owner
      WHERE p.is_eliminated = TRUE
      GROUP BY ft.display_name, p.owner
      ORDER BY COUNT(*) DESC
    `);

    // Pool-wide stats
    const { rows: poolStats } = await pool.query(`
      SELECT
        (SELECT SUM(total_pts) FROM fantasy_teams) AS pool_total_pts,
        (SELECT COUNT(*) FROM players WHERE is_eliminated = TRUE) AS total_eliminated,
        (SELECT COUNT(*) FROM players WHERE is_eliminated = FALSE) AS total_alive,
        (SELECT COUNT(DISTINCT player_id) FROM player_round_scores WHERE pts IS NOT NULL) AS total_players_scored,
        (SELECT COUNT(*) FROM games WHERE status = 'final') AS games_completed,
        (SELECT COUNT(*) FROM games WHERE status = 'live') AS games_live
    `);

    res.json({
      pool_stats: poolStats[0] || {},
      player_leaders: playerLeaders,
      team_efficiency: teamEfficiency,
      round_summary: roundSummary,
      elimination_impact: elimImpact,
    });
  } catch (err) {
    console.error('/api/analytics error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/team-mappings — learned CSV abbrev → ESPN team name mappings
app.get('/api/team-mappings', async (req, res) => {
  try {
    const mappings = await getTeamMappings();
    res.json(mappings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/debug — diagnostic snapshot for bug investigation
app.get('/api/debug', async (req, res) => {
  try {
    const [alertCounts, recentAlerts, playingNow, bracketElim, stuckPlayers] = await Promise.all([
      pool.query(`SELECT type, COUNT(*) FROM alerts GROUP BY type ORDER BY type`),
      pool.query(`SELECT type, message, created_at FROM alerts ORDER BY created_at DESC LIMIT 20`),
      pool.query(`SELECT p.name, p.ncaa_team, ft.display_name AS owner FROM players p JOIN fantasy_teams ft ON ft.owner = p.owner WHERE p.is_playing_now = TRUE`),
      pool.query(`SELECT team_abbrev, team_name, eliminated_in_round FROM bracket_slots WHERE is_eliminated = TRUE ORDER BY team_name`),
      pool.query(`SELECT p.name, p.ncaa_team, ft.display_name AS owner, p.is_eliminated FROM players p JOIN fantasy_teams ft ON ft.owner = p.owner WHERE p.is_eliminated = FALSE AND p.ncaa_team IN (SELECT DISTINCT p2.ncaa_team FROM players p2 JOIN bracket_slots bs ON LOWER(bs.team_abbrev) = LOWER(p2.ncaa_team) WHERE bs.is_eliminated = TRUE)`),
    ]);
    res.json({
      alertCounts: alertCounts.rows,
      recentAlerts: recentAlerts.rows,
      playingNow: playingNow.rows,
      bracketEliminated: bracketElim.rows,
      possiblyMissedEliminations: stuckPlayers.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Catch-all: serve index.html for client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  // Init DB schema
  await initSchema();
  console.log('Database schema initialized');

  // Always run seed — it upserts by fantrax_id so it's safe to re-run.
  // This ensures draft_pick and any future CSV fields stay in sync.
  console.log('Syncing teams and draft order from CSV...');
  await seed();

  // Start ESPN scraper
  startScheduler();

  // Start Claude commentary scheduler
  scheduleCommentary();

  // Resolve team mappings using Claude (runs once per new unmapped team)
  resolveTeamMappings().catch(err => console.error('[mapping] team startup error:', err.message));

  // Resolve player name overrides using Claude (runs once, skips already-reviewed players)
  resolvePlayerNames().catch(err => console.error('[mapping] player startup error:', err.message));

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});
