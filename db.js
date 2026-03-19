const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fantasy_teams (
      id SERIAL PRIMARY KEY,
      owner VARCHAR(100) UNIQUE NOT NULL,
      total_pts INTEGER DEFAULT 0,
      players_remaining INTEGER DEFAULT 10
    );

    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      owner VARCHAR(100) NOT NULL REFERENCES fantasy_teams(owner) ON DELETE CASCADE,
      fantrax_id VARCHAR(50),
      name VARCHAR(200) NOT NULL,
      ncaa_team VARCHAR(50) NOT NULL,
      position VARCHAR(20),
      draft_pick INTEGER,
      is_eliminated BOOLEAN DEFAULT FALSE,
      is_playing_now BOOLEAN DEFAULT FALSE,
      total_pts INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS player_round_scores (
      id SERIAL PRIMARY KEY,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      round_num INTEGER NOT NULL CHECK (round_num BETWEEN 1 AND 6),
      pts INTEGER,
      blacked_out BOOLEAN DEFAULT FALSE,
      UNIQUE (player_id, round_num)
    );

    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      espn_game_id VARCHAR(50) UNIQUE NOT NULL,
      round_num INTEGER,
      home_team VARCHAR(100),
      away_team VARCHAR(100),
      home_score INTEGER DEFAULT 0,
      away_score INTEGER DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pre',
      tip_time TIMESTAMPTZ,
      game_date DATE,
      display_clock VARCHAR(20),
      period INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bracket_slots (
      id SERIAL PRIMARY KEY,
      espn_team_id VARCHAR(50) UNIQUE,
      team_name VARCHAR(100),
      team_abbrev VARCHAR(20),
      seed INTEGER,
      region VARCHAR(50),
      current_round INTEGER DEFAULT 1,
      is_eliminated BOOLEAN DEFAULT FALSE,
      eliminated_in_round INTEGER
    );

    CREATE TABLE IF NOT EXISTS scrape_log (
      id SERIAL PRIMARY KEY,
      scraped_at TIMESTAMPTZ DEFAULT NOW(),
      status VARCHAR(20) DEFAULT 'ok',
      message TEXT
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      type VARCHAR(30) NOT NULL,
      message TEXT NOT NULL,
      owner VARCHAR(100),
      player_name VARCHAR(200),
      seen BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS commentary (
      id SERIAL PRIMARY KEY,
      generated_at TIMESTAMPTZ DEFAULT NOW(),
      narrative TEXT,
      team_blurbs JSONB,
      top_3 JSONB,
      bottom_3 JSONB
    );

    CREATE TABLE IF NOT EXISTS team_mappings (
      id SERIAL PRIMARY KEY,
      csv_abbrev VARCHAR(20) UNIQUE NOT NULL,
      espn_abbrev VARCHAR(20),
      espn_name VARCHAR(150),
      confirmed BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Migrations: add columns / constraints that may not exist on older DB instances
  await pool.query(`
    ALTER TABLE players ADD COLUMN IF NOT EXISTS draft_pick INTEGER;
  `);
  await pool.query(`
    ALTER TABLE fantasy_teams ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);
  `);
  await pool.query(`
    ALTER TABLE commentary ADD COLUMN IF NOT EXISTS top_3 JSONB;
    ALTER TABLE commentary ADD COLUMN IF NOT EXISTS bottom_3 JSONB;
  `);
  await pool.query(`
    ALTER TABLE players ADD COLUMN IF NOT EXISTS espn_name VARCHAR(200);
  `);
  await pool.query(`
    ALTER TABLE team_mappings ADD COLUMN IF NOT EXISTS confirmed BOOLEAN DEFAULT FALSE;
  `);
  // Restore ALL blacked-out cells for non-eliminated players.
  // Only truly eliminated players should ever have black cells.
  await pool.query(`
    UPDATE player_round_scores SET blacked_out = FALSE, pts = NULL
    WHERE blacked_out = TRUE
    AND player_id IN (SELECT id FROM players WHERE is_eliminated = FALSE)
  `);

  // Fix scores stored in wrong round due to ESPN "Championship" title matching.
  // Mar 20-21 = First Round (1), Mar 22-23 = Second Round (2), etc.
  // Any scores/game records written to round 6 on these dates are misassigned.
  await pool.query(`
    UPDATE games SET round_num = 1
    WHERE round_num = 6 AND game_date IN ('2026-03-20'::date, '2026-03-21'::date);
  `);
  await pool.query(`
    UPDATE games SET round_num = 2
    WHERE round_num = 6 AND game_date IN ('2026-03-22'::date, '2026-03-23'::date);
  `);
  await pool.query(`
    UPDATE games SET round_num = 3
    WHERE round_num = 6 AND game_date IN ('2026-03-27'::date, '2026-03-28'::date);
  `);
  await pool.query(`
    UPDATE games SET round_num = 4
    WHERE round_num = 6 AND game_date IN ('2026-03-29'::date, '2026-03-30'::date);
  `);
  await pool.query(`
    UPDATE games SET round_num = 5
    WHERE round_num = 6 AND game_date = '2026-04-05'::date;
  `);

  // Move any player_round_scores that were written to round 6 but belong to
  // earlier rounds. We do this by copying pts to the correct round and clearing
  // the bad round-6 entry, for players whose team played on each date.
  // The next scrape will re-write the correct values automatically, so this
  // just ensures a clean state for the round columns in the UI.
  await pool.query(`
    UPDATE player_round_scores AS dest
    SET pts = src.pts, blacked_out = FALSE
    FROM player_round_scores AS src
    JOIN players p ON p.id = src.player_id
    WHERE src.round_num = 6
      AND src.pts IS NOT NULL
      AND dest.player_id = src.player_id
      AND dest.round_num = 1
      AND dest.pts IS NULL
      AND p.is_eliminated = FALSE;
  `);
  await pool.query(`
    UPDATE player_round_scores SET pts = NULL
    WHERE round_num = 6 AND pts IS NOT NULL
    AND player_id IN (
      SELECT player_id FROM player_round_scores
      WHERE round_num = 1 AND pts IS NOT NULL
    );
  `);
  // Fix play-in scores incorrectly stored as round 6 due to ESPN label matching bug.
  // Strategy: for any player who has pts in round_num=6 but the Championship
  // hasn't happened yet (Apr 7), copy those pts into their round_num=0 row,
  // then clear the round_num=6 pts.
  // We use UPDATE not INSERT because seed pre-creates all round rows with pts=NULL.
  await pool.query(`
    UPDATE player_round_scores AS dest
    SET pts = src.pts, blacked_out = FALSE
    FROM player_round_scores AS src
    WHERE src.player_id = dest.player_id
      AND src.round_num = 6
      AND src.pts IS NOT NULL
      AND dest.round_num = 0
      AND dest.pts IS NULL;
  `);
  // Clear the incorrectly stored round_num=6 pts (Championship is Apr 7 — none yet)
  await pool.query(`
    UPDATE player_round_scores SET pts = NULL
    WHERE round_num = 6 AND pts IS NOT NULL
      AND player_id IN (
        SELECT player_id FROM player_round_scores
        WHERE round_num = 0 AND pts IS NOT NULL
      );
  `);
  // Fix games table round_num for Mar 18-19 games misidentified as Championship
  await pool.query(`
    UPDATE games SET round_num = 0
    WHERE round_num = 6
      AND game_date IN ('2026-03-18'::date, '2026-03-19'::date);
  `);
  // Widen round_num check to include 0 (Play-In / First Four games)
  await pool.query(`
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE player_round_scores
          DROP CONSTRAINT player_round_scores_round_num_check;
      EXCEPTION WHEN undefined_object THEN NULL;
      END;
      BEGIN
        ALTER TABLE player_round_scores
          ADD CONSTRAINT player_round_scores_round_num_check
          CHECK (round_num BETWEEN 0 AND 6);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    END $$;
  `);
  // Migrate unique constraint: fantrax_id alone → (fantrax_id, owner) composite
  // This allows the same player to appear on multiple fantasy teams
  await pool.query(`
    DO $$
    BEGIN
      -- Drop old single-column constraint if present
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'players_fantrax_id_key' AND conrelid = 'players'::regclass
      ) THEN
        ALTER TABLE players DROP CONSTRAINT players_fantrax_id_key;
      END IF;
      -- Add composite constraint if not already present
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'players_fantrax_id_owner_key' AND conrelid = 'players'::regclass
      ) THEN
        ALTER TABLE players ADD CONSTRAINT players_fantrax_id_owner_key UNIQUE (fantrax_id, owner);
      END IF;
    END $$;
  `);
}

module.exports = { pool, initSchema };
