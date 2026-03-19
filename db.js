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
  // Fix games table round_num using the authoritative date-based mapping.
  // Previous code used text-based detection which matched "Championship" from
  // ESPN's generic tournament title, misassigning all rounds to round 6.
  await pool.query(`
    UPDATE games SET round_num = 0 WHERE game_date IN ('2026-03-18'::date,'2026-03-19'::date) AND round_num != 0;
    UPDATE games SET round_num = 1 WHERE game_date IN ('2026-03-20'::date,'2026-03-21'::date) AND round_num != 1;
    UPDATE games SET round_num = 2 WHERE game_date IN ('2026-03-22'::date,'2026-03-23'::date) AND round_num != 2;
    UPDATE games SET round_num = 3 WHERE game_date IN ('2026-03-27'::date,'2026-03-28'::date) AND round_num != 3;
    UPDATE games SET round_num = 4 WHERE game_date IN ('2026-03-29'::date,'2026-03-30'::date) AND round_num != 4;
    UPDATE games SET round_num = 5 WHERE game_date = '2026-04-05'::date AND round_num != 5;
    UPDATE games SET round_num = 6 WHERE game_date = '2026-04-07'::date AND round_num != 6;
  `);

  // Clean slate for player_round_scores: wipe all pts so the scraper can
  // repopulate them correctly. The scraper re-fetches ALL final game box scores
  // on every cycle, so no data is permanently lost. This eliminates corrupted
  // data from previous round-detection bugs (round 6 used as a catch-all,
  // play-in migration copying those pts to round 0, etc.).
  // Preserve blacked_out state for truly eliminated players.
  await pool.query(`
    UPDATE player_round_scores SET pts = NULL
    WHERE pts IS NOT NULL
    AND player_id IN (SELECT id FROM players WHERE is_eliminated = FALSE);
  `);
  // Also restore any blacked-out cells for non-eliminated players
  await pool.query(`
    UPDATE player_round_scores SET blacked_out = FALSE
    WHERE blacked_out = TRUE
    AND player_id IN (SELECT id FROM players WHERE is_eliminated = FALSE);
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
