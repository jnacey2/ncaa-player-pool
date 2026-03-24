# Convertibles NCAA Tournament Player Pool 2026

A live web app that tracks a 13-team fantasy player pool through the NCAA Men's Basketball Tournament. Each owner drafted 10 players; scoring is based on actual basketball points scored in each tournament game.

**Live site**: [ncaa-player-pool.onrender.com](https://ncaa-player-pool.onrender.com)

---

## Features

### Leaderboard
- Ranked table showing all 13 owners with total points, ceiling score (max possible), and players remaining
- Ceiling computed from each alive player's average PPG x rounds remaining
- Click any owner to scroll to their team card

### Team Cards
- Per-round scoring grid: Play-In | R1 | R2 | S16 | E8 | F4 | Champ | Total
- Players listed in draft order
- Live players highlighted in green with pulsing dot
- Eliminated players dimmed with strikethrough; future rounds blacked out
- Claude-generated per-team blurb (roast-style)

### Tournament Games Sidebar
- All games grouped by date with live/upcoming/final states
- Live games auto-expanded showing drafted pool players with their current points
- Team seeds and TV network displayed on each game card
- Click any game to see which pool players are involved

### Tournament Commentary (Claude-Powered)
- Roast-style narrative covering the pool standings, hot streaks, and collapses
- Claude's Top 3 to Win and Most Likely to Become "The A$$" (last place pays double)
- Regenerate button for on-demand fresh commentary
- Auto-generates every 2 hours on game days (can be suspended between rounds)

### LLM-Powered Mapping
- Claude resolves CSV team abbreviations to ESPN team names on startup
- Claude reviews all 130 player names for ESPN display name differences (Jr., nicknames, etc.)
- Full player name refresh available via `POST /api/mapping/refresh-names`

---

## Architecture

```
ESPN API (every 30s when live, 60s idle)
    |
    v
[Scraper] ---> [PostgreSQL]
    |               |
    |               v
    |          [Express Server]
    |               |
    |               v
    |          [REST API]
    |               |
    v               v
[Claude API]   [Vanilla JS Frontend]
(commentary,    (auto-polls every 30s)
 team mapping,
 player names)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Database | PostgreSQL (Render managed) |
| Scraping | axios + ESPN public API |
| Name Matching | Fuse.js (fuzzy) + espn_name overrides |
| AI Commentary | Anthropic Claude Sonnet 4.5 |
| AI Mapping | Anthropic Claude Haiku 4.5 |
| Frontend | Vanilla JS + CSS Grid (no framework) |
| Hosting | Render (Web Service + PostgreSQL) |

---

## Scoring Rules

- Each player earns fantasy points equal to the **actual basketball points they score** in each tournament game
- Points accumulate by round (Play-In through Championship)
- No multipliers — only raw points count
- When a player's NCAA team is eliminated, all future round cells are **blacked out**
- **The A$$**: The person who finishes dead last pays double pool fees

---

## Data Flow

### ESPN Scraping
The scraper (`scraper.js`) runs on a dynamic loop:
- **30 seconds** when any game is live
- **60 seconds** when idle (to catch game starts quickly)

Each cycle:
1. Fetches all tournament events across known game dates from ESPN's scoreboard API
2. Upserts game records (scores, status, clock, TV, seeds, tip time)
3. Updates bracket_slots with elimination data
4. Loads the `round_num` from the `games` table (date-based, not ESPN text labels)
5. Fetches box scores for all live/final games
6. Fuzzy-matches player names to pool roster with three validation layers:
   - Fuse.js score < 0.3 on `espn_name` (2x weight) + `name`
   - Team validation: box score team abbreviation must resolve to the player's `ncaa_team`
   - Last-name validation: last names must match (stripping Jr./Sr./II/III/IV suffixes)
7. Only processes box score sections for teams in our pool (null `csvTeam` = skip)
8. Credits all matching players (handles duplicates like Graham Ike on two teams)
9. Runs elimination detection and cleanup
10. Recomputes all totals

### Player Name Resolution
- `espn_name` column overrides the fuzzy search (e.g. "Solomon Ball" → "Solo Ball", "Michael Collins" → "MJ Collins Jr.")
- `resolvePlayerNames()` asks Claude to review all 130 names on startup
- `refreshAllPlayerNames()` does a full re-scan (triggered via API)

### Team Mapping
- `resolveTeamMappings()` asks Claude to match CSV abbreviations (e.g. "Mia-FL") to ESPN display names (e.g. "Miami Hurricanes")
- Stored in `team_mappings` table with `confirmed` flag
- Unconfirmed mappings get re-resolved once the team appears in `bracket_slots`
- Hardcoded `ESPN_TO_CSV_ABBREV` table as fallback

### Elimination Detection
- `updateEliminationStatus()`: checks `bracket_slots` for eliminated teams, resolves ESPN abbreviations via LLM mappings + hardcoded table, marks players eliminated, blacks out future rounds
- `cleanupFalseEliminations()`: reverses any incorrect eliminations by cross-referencing against confirmed `bracket_slots` data
- Uses `== null` (not `!`) to correctly handle round 0 (First Four) eliminations

---

## Database Schema

| Table | Purpose |
|-------|---------|
| `fantasy_teams` | 13 owners with display_name, total_pts, players_remaining |
| `players` | 130 players with owner, ncaa_team, draft_pick, espn_name, is_eliminated, is_playing_now |
| `player_round_scores` | Per-player, per-round points (round 0-6) with blacked_out flag |
| `games` | All tournament games with ESPN data (scores, status, clock, TV, seeds, tip time) |
| `bracket_slots` | ESPN bracket data for elimination tracking |
| `team_mappings` | LLM-resolved CSV abbreviation → ESPN team name mappings |
| `commentary` | Claude-generated narratives, team blurbs, top 3, bottom 3, analytics |
| `scrape_log` | Last 24h of scrape history (auto-pruned) |
| `alerts` | Legacy alert table (feature removed, table kept) |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/standings` | All 13 teams with per-player, per-round breakdown + ceiling scores |
| GET | `/api/games` | All tournament games (sorted: live first, then upcoming, then final) |
| GET | `/api/commentary` | Latest narrative, team_blurbs, top_3, bottom_3, analytics |
| GET | `/api/team-mappings` | LLM-resolved CSV → ESPN team name map |
| GET | `/api/analytics` | DB-computed analytics (top scorers, efficiency, round breakdown, eliminations) |
| GET | `/api/last-updated` | Timestamp of last successful scrape |
| GET | `/api/debug` | Diagnostic snapshot (alert counts, playing now, bracket eliminated, missed eliminations) |
| POST | `/api/commentary/regenerate` | Manually trigger Claude commentary + analytics generation |
| POST | `/api/mapping/refresh-names` | Full Claude re-scan of all 130 player names for ESPN mismatches |

---

## Project Structure

```
ncaa-player-pool/
├── server.js              # Express server + all API routes + startup orchestration
├── scraper.js             # ESPN scraping + dynamic scheduler (30s live / 60s idle)
├── commentary.js          # Claude commentary + analytics generation + scheduling
├── mapping.js             # Claude team mapping + player name resolution
├── db.js                  # PostgreSQL schema + migrations
├── seed.js                # CSV parser + DB seeder (runs every boot, idempotent)
├── public/
│   ├── index.html         # App shell: header, sidebar, leaderboard, commentary, cards
│   ├── style.css          # Dark navy/gold theme, responsive grid layout
│   └── app.js             # Fetch APIs, render all views, 30s auto-poll
├── data/
│   └── draft-results.csv  # Fantrax draft export (13 owners, 10 players each)
├── render.yaml            # Render blueprint (web service + PostgreSQL)
├── package.json
└── .env.example
```

---

## Setup (Local)

### Prerequisites
- Node.js 18+
- PostgreSQL database

### Steps

1. **Clone and install**
   ```bash
   git clone https://github.com/jnacey2/ncaa-player-pool.git
   cd ncaa-player-pool
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env:
   # DATABASE_URL=postgresql://user:password@host:5432/ncaa_pool
   # ANTHROPIC_API_KEY=sk-ant-...  (optional, for commentary + mapping)
   ```

3. **Start the server**
   ```bash
   npm start
   ```
   On boot the server will:
   - Initialize/migrate the database schema
   - Seed 13 fantasy teams and 130 players from `data/draft-results.csv`
   - Resolve team mappings and player names via Claude (if API key set)
   - Start the ESPN scraper (30s/60s dynamic loop)
   - Start the commentary scheduler (if enabled)

4. **Open** `http://localhost:3000`

---

## Deploy to Render

1. Push this repo to GitHub
2. In [Render](https://render.com), click **New → Blueprint** and select the repo
3. Render reads `render.yaml` and creates:
   - A **Web Service** (Node.js, `node server.js`)
   - A **PostgreSQL** database (free tier)
4. Add `ANTHROPIC_API_KEY` in the Render dashboard under Environment variables
5. Deploy — `DATABASE_URL` is automatically wired up

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | HTTP port (default: 3000) |
| `ANTHROPIC_API_KEY` | No | Enables Claude commentary, team mapping, and player name resolution |

---

## Tournament Dates (2026)

| Round | Dates | round_num |
|-------|-------|-----------|
| First Four | March 18 | 0 |
| First Round | March 19-20 | 1 |
| Second Round | March 21-22 | 2 |
| Sweet 16 | March 26-27 | 3 |
| Elite Eight | March 28-29 | 4 |
| Final Four | April 5 | 5 |
| Championship | April 7 | 6 |

---

## Fantasy Team Owners

| Fantrax Username | Display Name |
|-----------------|--------------|
| AJA2026 | Alpert |
| benkunk | Kunkel |
| Bradfrey | Frey |
| DamatoN | D'Amato |
| DAvart | Avart |
| Dgross21 | GrossBot |
| Dignazio | Dignazio |
| Haron | Haron |
| jmiano | Miano |
| Jnacey2 | Nacey |
| Mcriqui | Criqui |
| michaelfer | Ferry |
| sniels100 | Nielson |

---

## Known ESPN Name Overrides

These players have `espn_name` overrides because ESPN displays them differently:

| CSV Name | ESPN Name | Team |
|----------|-----------|------|
| Nicholas Boyd | Nick Boyd | Wisc |
| Solomon Ball | Solo Ball | UConn |
| Michael Collins | MJ Collins Jr. | UtSt |
| Kevin Miller | Boopie Miller | SMU |
| Jaron Pierre | Jaron Pierre Jr. | SMU |

Additional overrides are auto-detected by `resolvePlayerNames()` on startup.

---

## Roster Corrections

These manual roster changes were made after the draft:

| Team | Out | In |
|------|-----|-----|
| GrossBot | JT Toppin (TxTch) | Graham Ike (Gonz) |
| Dignazio | Aden Holloway (Bama) | Kur Teng (MSU) |
| Frey | Richie Saunders (BYU) | Tramon Mark (Tex) |
| Alpert | Braden Huff (Gonz) | Devin McGlockton (Vand) |

Note: Graham Ike appears on both GrossBot and Kunkel (allowed by composite unique constraint).
