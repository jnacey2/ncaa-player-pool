# NCAA Tournament Player Pool Tracker

Live web app that tracks a 13-team fantasy player pool through the NCAA Tournament. Scrapes ESPN every 5 minutes for live scores and updates each player's point totals by round.

## Features

- **Leaderboard strip** — all 13 owners ranked by total pts + players still alive
- **Team cards** — per-round scoring grid (R1 → Champ); blacked-out cells when a player's team is eliminated
- **Games sidebar** — live scores, upcoming tip times, final results
- **Bracket sidebar** — full tournament bracket with pool players highlighted in gold
- Auto-refreshes every 30 seconds

## Setup (Local)

### Prerequisites
- Node.js 18+
- PostgreSQL database

### Steps

1. **Clone and install**
   ```bash
   git clone <repo-url>
   cd ncaa-player-pool
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env and set DATABASE_URL to your PostgreSQL connection string
   ```

3. **Start the server**
   ```bash
   npm start
   ```
   On first boot the server will:
   - Initialize the database schema
   - Seed the 13 fantasy teams and 130 players from `data/draft-results.csv`
   - Immediately scrape ESPN and schedule future scrapes every 5 minutes

4. **Open** `http://localhost:3000`

## Deploy to Render

1. Push this repo to GitHub
2. In [Render](https://render.com), click **New → Blueprint** and select the repo
3. Render reads `render.yaml` and creates:
   - A **Web Service** (Node.js)
   - A **PostgreSQL** database
4. Once deployed, the `DATABASE_URL` env var is automatically wired up

## Scoring Rules

- Each player earns fantasy points equal to the **actual basketball points they score** in each tournament game
- Points accumulate by round (R1 through Championship)
- No multipliers — only raw points count
- When a player's team is eliminated, all future round cells are **blacked out**

## Data Files

| File | Description |
|---|---|
| `data/draft-results.csv` | Fantrax draft export — 13 owners, 10 players each |
| `server.js` | Express server + API routes |
| `scraper.js` | ESPN scraper + 5-min cron scheduler |
| `db.js` | PostgreSQL schema + connection pool |
| `seed.js` | CSV → database seeder |
| `public/` | Frontend (vanilla JS, no framework) |
| `render.yaml` | Render deployment config |

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | HTTP port (default: 3000) |
