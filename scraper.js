const axios = require('axios');
const cron = require('node-cron');
const Fuse = require('fuse.js');
const { pool } = require('./db');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';

// NCAA tournament group ID (68-team bracket)
const TOURNAMENT_GROUP = '100';

// Map ESPN round label → round_num 1-6
const ROUND_LABEL_MAP = {
  'First Round': 1,
  'Second Round': 2,
  'Sweet 16': 3,
  'Elite Eight': 4,
  'Final Four': 5,
  'Championship': 6,
  // alternate ESPN labels
  'First Four': 0,
  'Round of 64': 1,
  'Round of 32': 2,
  'Sweet Sixteen': 3,
  'Elite 8': 4,
};

function normalizeTeamAbbrev(abbrev) {
  if (!abbrev) return '';
  const map = {
    'Ariz': 'arizona', 'Ark': 'arkansas', 'Bama': 'alabama',
    'BYU': 'byu', 'Duke': 'duke', 'Fla': 'florida',
    'Gonz': 'gonzaga', 'Hou': 'houston', 'IaSt': 'iowa-state',
    'Ill': 'illinois', 'Iowa': 'iowa', 'Kan': 'kansas',
    'KY': 'kentucky', 'Leh': 'lehigh', 'Lou': 'louisville',
    'Mia-FL': 'miami-fl', 'Mich': 'michigan', 'MSU': 'michigan-state',
    'Nebras': 'nebraska', 'OhSt': 'ohio-state', 'Pur': 'purdue',
    'SCla': 'santa-clara', 'SMU': 'smu', 'SoFL': 'south-florida',
    'StJon': 'st-johns', 'StLou': 'saint-louis', 'StMar': 'saint-marys',
    'Tenn': 'tennessee', 'Tex': 'texas', 'TxTch': 'texas-tech',
    'UCLA': 'ucla', 'UConn': 'connecticut', 'UGA': 'georgia',
    'UNC': 'north-carolina', 'UtSt': 'utah-state', 'UVA': 'virginia',
    'VCU': 'vcu', 'Vand': 'vanderbilt', 'Wisc': 'wisconsin',
    'PVAM': 'prairie-view', 'Akr': 'akron',
  };
  return (map[abbrev] || abbrev).toLowerCase();
}

// Fetch all tournament games from ESPN scoreboard
async function fetchTournamentGames() {
  try {
    const url = `${ESPN_BASE}/scoreboard?groups=${TOURNAMENT_GROUP}&limit=100`;
    const { data } = await axios.get(url, { timeout: 10000 });
    return data.events || [];
  } catch (err) {
    console.error('Error fetching scoreboard:', err.message);
    return [];
  }
}

// Fetch box score for a single game
async function fetchBoxScore(espnGameId) {
  try {
    const url = `${ESPN_BASE}/summary?event=${espnGameId}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    return data;
  } catch (err) {
    console.error(`Error fetching box score for game ${espnGameId}:`, err.message);
    return null;
  }
}

// Fetch bracket data
async function fetchBracket() {
  try {
    // Try the tournaments endpoint first
    const url = `https://site.api.espn.com/apis/v2/sports/basketball/mens-college-basketball/tournaments?groups=${TOURNAMENT_GROUP}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    return data;
  } catch (err) {
    console.error('Error fetching bracket:', err.message);
    return null;
  }
}

// Parse round number from ESPN event data
function getRoundNum(event) {
  try {
    const notes = event.notes || [];
    for (const note of notes) {
      const text = note.headline || '';
      for (const [label, num] of Object.entries(ROUND_LABEL_MAP)) {
        if (text.includes(label)) return num;
      }
    }
    // Try competition notes
    const comp = event.competitions?.[0];
    const compNotes = comp?.notes || [];
    for (const note of compNotes) {
      const text = note.headline || '';
      for (const [label, num] of Object.entries(ROUND_LABEL_MAP)) {
        if (text.includes(label)) return num;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Upsert game records
async function upsertGames(events) {
  for (const event of events) {
    const espnGameId = event.id;
    const comp = event.competitions?.[0];
    if (!comp) continue;

    const roundNum = getRoundNum(event);
    const status = event.status?.type?.name || 'STATUS_SCHEDULED';
    const displayClock = event.status?.displayClock || '';
    const period = event.status?.period || 0;

    let gameStatus = 'pre';
    if (status.includes('IN_PROGRESS')) gameStatus = 'live';
    else if (status.includes('FINAL') || status.includes('END_OF_')) gameStatus = 'final';

    const tipTime = event.date ? new Date(event.date) : null;
    const gameDate = tipTime ? tipTime.toISOString().split('T')[0] : null;

    const competitors = comp.competitors || [];
    let homeTeam = '', awayTeam = '', homeScore = 0, awayScore = 0;

    for (const c of competitors) {
      const name = c.team?.displayName || c.team?.name || '';
      const score = parseInt(c.score || 0, 10);
      if (c.homeAway === 'home') { homeTeam = name; homeScore = score; }
      else { awayTeam = name; awayScore = score; }
    }

    await pool.query(
      `INSERT INTO games (espn_game_id, round_num, home_team, away_team, home_score, away_score, status, tip_time, game_date, display_clock, period)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (espn_game_id) DO UPDATE SET
         round_num = EXCLUDED.round_num,
         home_score = EXCLUDED.home_score,
         away_score = EXCLUDED.away_score,
         status = EXCLUDED.status,
         display_clock = EXCLUDED.display_clock,
         period = EXCLUDED.period`,
      [espnGameId, roundNum, homeTeam, awayTeam, homeScore, awayScore, gameStatus, tipTime, gameDate, displayClock, period]
    );
  }
}

// Update bracket slots from games
async function updateBracketSlots(events) {
  for (const event of events) {
    const comp = event.competitions?.[0];
    if (!comp) continue;

    const roundNum = getRoundNum(event);
    const status = event.status?.type?.name || '';
    const isFinal = status.includes('FINAL') || status.includes('END_OF_');

    for (const c of comp.competitors || []) {
      const team = c.team;
      if (!team) continue;

      const espnTeamId = team.id;
      const teamName = team.displayName || team.name || '';
      const abbrev = team.abbreviation || '';
      const seed = parseInt(c.curatedRank?.current || c.seed || 0, 10);
      const isLoser = isFinal && c.winner === false;

      await pool.query(
        `INSERT INTO bracket_slots (espn_team_id, team_name, team_abbrev, seed, current_round, is_eliminated, eliminated_in_round)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (espn_team_id) DO UPDATE SET
           team_name = EXCLUDED.team_name,
           team_abbrev = EXCLUDED.team_abbrev,
           seed = EXCLUDED.seed,
           current_round = GREATEST(bracket_slots.current_round, EXCLUDED.current_round),
           is_eliminated = CASE WHEN EXCLUDED.is_eliminated THEN TRUE ELSE bracket_slots.is_eliminated END,
           eliminated_in_round = CASE WHEN EXCLUDED.is_eliminated AND bracket_slots.eliminated_in_round IS NULL THEN EXCLUDED.eliminated_in_round ELSE bracket_slots.eliminated_in_round END`,
        [espnTeamId, teamName, abbrev, seed, roundNum, isLoser, isLoser ? roundNum : null]
      );
    }
  }
}

// Build a Fuse.js searcher from current pool players
async function buildPlayerIndex() {
  const { rows } = await pool.query('SELECT id, name, ncaa_team FROM players');
  const fuse = new Fuse(rows, {
    keys: ['name'],
    threshold: 0.3,
    includeScore: true,
  });
  return { fuse, players: rows };
}

// Update player_round_scores from a completed/live box score
async function processBoxScore(boxScore, roundNum, gameStatus) {
  if (!boxScore || !boxScore.boxscore) return;

  const { fuse } = await buildPlayerIndex();

  const teams = boxScore.boxscore.players || [];
  for (const teamData of teams) {
    const statistics = teamData.statistics || [];
    for (const statGroup of statistics) {
      const athletes = statGroup.athletes || [];
      for (const athleteEntry of athletes) {
        const athlete = athleteEntry.athlete;
        const stats = athleteEntry.stats || [];

        if (!athlete || !athlete.displayName) continue;

        const espnName = athlete.displayName;

        // Find points stat — ESPN orders: PTS is typically index 18 in the full stat array
        // We look for it by the "names" array on statGroup
        const names = statGroup.names || [];
        const ptsIdx = names.indexOf('PTS');
        if (ptsIdx === -1) continue;

        const ptsRaw = stats[ptsIdx];
        if (ptsRaw === undefined || ptsRaw === null) continue;
        const pts = parseInt(ptsRaw, 10);
        if (isNaN(pts)) continue;

        // Fuzzy-match to our pool
        const results = fuse.search(espnName);
        if (!results.length || results[0].score > 0.3) continue;

        const player = results[0].item;

        // Only update if game is live or final (not pre-game)
        if (gameStatus === 'pre') continue;

        await pool.query(
          `INSERT INTO player_round_scores (player_id, round_num, pts, blacked_out)
           VALUES ($1, $2, $3, FALSE)
           ON CONFLICT (player_id, round_num) DO UPDATE SET
             pts = EXCLUDED.pts,
             blacked_out = FALSE`,
          [player.id, roundNum, pts]
        );

        // Mark player as currently playing if game is live
        await pool.query(
          `UPDATE players SET is_playing_now = $1 WHERE id = $2`,
          [gameStatus === 'live', player.id]
        );
      }
    }
  }
}

// After scraping all games, black out future rounds for eliminated players
async function updateEliminationStatus() {
  // Get all eliminated NCAA teams from bracket_slots
  const { rows: elimTeams } = await pool.query(
    `SELECT team_abbrev, eliminated_in_round FROM bracket_slots WHERE is_eliminated = TRUE`
  );

  for (const { team_abbrev, eliminated_in_round } of elimTeams) {
    if (!eliminated_in_round) continue;

    // Find players on this team
    const { rows: affectedPlayers } = await pool.query(
      `SELECT id FROM players WHERE LOWER(ncaa_team) = $1`,
      [team_abbrev.toLowerCase()]
    );

    for (const { id: playerId } of affectedPlayers) {
      // Mark player as eliminated
      await pool.query(
        `UPDATE players SET is_eliminated = TRUE, is_playing_now = FALSE WHERE id = $1`,
        [playerId]
      );

      // Black out rounds after elimination
      for (let r = eliminated_in_round + 1; r <= 6; r++) {
        await pool.query(
          `INSERT INTO player_round_scores (player_id, round_num, pts, blacked_out)
           VALUES ($1, $2, NULL, TRUE)
           ON CONFLICT (player_id, round_num) DO UPDATE SET
             blacked_out = TRUE, pts = NULL`,
          [playerId, r]
        );
      }
    }
  }
}

// Also match by our CSV team abbreviations against ESPN bracket team abbrevs
async function updateEliminationByCSVAbbrev() {
  const { rows: elimTeams } = await pool.query(
    `SELECT team_name, team_abbrev, eliminated_in_round FROM bracket_slots WHERE is_eliminated = TRUE`
  );

  // Build a map of ESPN team names for fuzzy matching
  const teamFuse = new Fuse(elimTeams, {
    keys: ['team_name', 'team_abbrev'],
    threshold: 0.35,
  });

  // Get all distinct NCAA teams from our players
  const { rows: poolTeams } = await pool.query(
    `SELECT DISTINCT ncaa_team FROM players`
  );

  for (const { ncaa_team } of poolTeams) {
    const normalized = normalizeTeamAbbrev(ncaa_team);

    // Check direct abbrev match first
    const directMatch = elimTeams.find(t =>
      t.team_abbrev.toLowerCase() === ncaa_team.toLowerCase() ||
      normalizeTeamAbbrev(t.team_abbrev) === normalized
    );

    let eliminated_in_round = null;
    if (directMatch) {
      eliminated_in_round = directMatch.eliminated_in_round;
    } else {
      // Fuzzy match on team name
      const fuzzyResults = teamFuse.search(ncaa_team);
      if (fuzzyResults.length > 0) {
        eliminated_in_round = fuzzyResults[0].item.eliminated_in_round;
      }
    }

    if (!eliminated_in_round) continue;

    const { rows: affectedPlayers } = await pool.query(
      `SELECT id FROM players WHERE ncaa_team = $1`,
      [ncaa_team]
    );

    for (const { id: playerId } of affectedPlayers) {
      await pool.query(
        `UPDATE players SET is_eliminated = TRUE, is_playing_now = FALSE WHERE id = $1`,
        [playerId]
      );

      for (let r = eliminated_in_round + 1; r <= 6; r++) {
        await pool.query(
          `INSERT INTO player_round_scores (player_id, round_num, pts, blacked_out)
           VALUES ($1, $2, NULL, TRUE)
           ON CONFLICT (player_id, round_num) DO UPDATE SET
             blacked_out = TRUE, pts = NULL`,
          [playerId, r]
        );
      }
    }
  }
}

// Recompute player total_pts and fantasy_team total_pts + players_remaining
async function recomputeTotals() {
  // Update each player's total_pts from round scores
  await pool.query(`
    UPDATE players p
    SET total_pts = COALESCE((
      SELECT SUM(pts) FROM player_round_scores
      WHERE player_id = p.id AND pts IS NOT NULL AND blacked_out = FALSE
    ), 0)
  `);

  // Update fantasy team totals
  await pool.query(`
    UPDATE fantasy_teams ft
    SET
      total_pts = COALESCE((
        SELECT SUM(total_pts) FROM players WHERE owner = ft.owner
      ), 0),
      players_remaining = (
        SELECT COUNT(*) FROM players WHERE owner = ft.owner AND is_eliminated = FALSE
      )
  `);
}

// Main scrape function
async function scrape() {
  console.log('[scraper] Starting scrape at', new Date().toISOString());
  try {
    const events = await fetchTournamentGames();
    console.log(`[scraper] Found ${events.length} tournament events`);

    await upsertGames(events);
    await updateBracketSlots(events);

    // Process box scores for live and recently finished games
    for (const event of events) {
      const status = event.status?.type?.name || '';
      const gameStatus = status.includes('IN_PROGRESS') ? 'live'
        : (status.includes('FINAL') || status.includes('END_OF_')) ? 'final' : 'pre';

      if (gameStatus === 'pre') continue;

      const roundNum = getRoundNum(event);
      if (!roundNum || roundNum < 1) continue;

      const boxScore = await fetchBoxScore(event.id);
      if (boxScore) {
        await processBoxScore(boxScore, roundNum, gameStatus);
      }

      // Small delay to be polite to ESPN
      await new Promise(r => setTimeout(r, 200));
    }

    await updateEliminationStatus();
    await updateEliminationByCSVAbbrev();
    await recomputeTotals();

    await pool.query(
      `INSERT INTO scrape_log (status, message) VALUES ('ok', $1)`,
      [`Scraped ${events.length} events`]
    );
    console.log('[scraper] Scrape complete');
  } catch (err) {
    console.error('[scraper] Scrape error:', err.message);
    await pool.query(
      `INSERT INTO scrape_log (status, message) VALUES ('error', $1)`,
      [err.message]
    ).catch(() => {});
  }
}

function startScheduler() {
  // Run every 5 minutes
  cron.schedule('*/5 * * * *', scrape);
  console.log('[scraper] Scheduler started — scraping every 5 minutes');
  // Run immediately on startup
  scrape();
}

module.exports = { scrape, startScheduler };
