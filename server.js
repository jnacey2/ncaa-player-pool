require('dotenv').config();
const express = require('express');
const path = require('path');
const { pool, initSchema } = require('./db');
const { seed } = require('./seed');
const { startScheduler } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/standings — all fantasy teams with per-player, per-round breakdown
app.get('/api/standings', async (req, res) => {
  try {
    const { rows: teams } = await pool.query(
      `SELECT owner, total_pts, players_remaining
       FROM fantasy_teams
       ORDER BY total_pts DESC, owner ASC`
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
      for (let r = 1; r <= 6; r++) {
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

    res.json(Object.values(teamMap));
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
              display_clock, period
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

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});
