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
  `);

  // Migrations: add columns / constraints that may not exist on older DB instances
  await pool.query(`
    ALTER TABLE players ADD COLUMN IF NOT EXISTS draft_pick INTEGER;
  `);
  // Add unique constraint on fantrax_id if not already present
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'players_fantrax_id_key' AND conrelid = 'players'::regclass
      ) THEN
        ALTER TABLE players ADD CONSTRAINT players_fantrax_id_key UNIQUE (fantrax_id);
      END IF;
    END $$;
  `);
}

module.exports = { pool, initSchema };
