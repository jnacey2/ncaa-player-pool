const axios = require('axios');
const Fuse = require('fuse.js');
const { pool } = require('./db');
const { getTeamMappings } = require('./mapping');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';

// NCAA tournament group ID (68-team bracket)
const TOURNAMENT_GROUP = '100';

// Convert a Date to YYYY-MM-DD in US Eastern time
// (en-CA locale returns dates as YYYY-MM-DD, so we piggyback on that)
function toEasternDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Map ESPN round label → round_num 0-6
// IMPORTANT: 'First Four' and 'Opening Round' must come BEFORE 'Championship'
// because ESPN often includes "Championship" in the overall tournament title
// (e.g. "NCAA Championship - First Four"), causing a false match on round 6.
const ROUND_LABEL_MAP = {
  'First Four': 0,
  'Opening Round': 0,
  'First Round': 1,
  'Round of 64': 1,
  'Second Round': 2,
  'Round of 32': 2,
  'Sweet 16': 3,
  'Sweet Sixteen': 3,
  'Elite Eight': 4,
  'Elite 8': 4,
  'Final Four': 5,
  'Championship': 6,
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

// All known 2026 NCAA tournament dates (First Four through Championship)
// First Four = March 18 only. First Round starts March 19.
const TOURNAMENT_DATES = [
  '20260318',             // First Four (2 games)
  '20260319', '20260320', // First Round
  '20260321', '20260322', // Second Round
  '20260327', '20260328', // Sweet 16
  '20260329', '20260330', // Elite Eight
  '20260405',             // Final Four
  '20260407',             // Championship
];

// Fetch tournament games for a single date
async function fetchGamesForDate(dateStr) {
  try {
    const url = `${ESPN_BASE}/scoreboard?groups=${TOURNAMENT_GROUP}&dates=${dateStr}&limit=20`;
    const { data } = await axios.get(url, { timeout: 10000 });
    return data.events || [];
  } catch (err) {
    console.error(`Error fetching games for ${dateStr}:`, err.message);
    return [];
  }
}

// Fetch all tournament games across every known tournament date
async function fetchTournamentGames() {
  const allEvents = [];
  const seen = new Set();

  for (const dateStr of TOURNAMENT_DATES) {
    const events = await fetchGamesForDate(dateStr);
    for (const e of events) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        allEvents.push(e);
      }
    }
    // Small delay to be polite to ESPN
    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`[scraper] Fetched ${allEvents.length} total tournament events`);
  return allEvents;
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

// Convert ESPN status type name → our 3-state status
// ESPN uses many mid-game states (HALFTIME, END_OF_PERIOD, etc.) that
// all mean "game is in progress" for our purposes
function espnStatusToGameStatus(espnStatus) {
  if (!espnStatus) return 'pre';
  const s = espnStatus.toUpperCase();
  if (
    s.includes('IN_PROGRESS') ||
    s.includes('HALFTIME') ||
    s.includes('END_OF_PERIOD') ||
    s.includes('END_PERIOD') ||
    s.includes('OVERTIME') ||
    s.includes('DELAYED')
  ) return 'live';
  if (
    s.includes('FINAL') ||
    s.includes('FULL_TIME') ||
    s.includes('FORFEIT') ||
    s.includes('CANCELED')
  ) return 'final';
  return 'pre';
}

// Fallback: infer round from game date when ESPN text labels are ambiguous
// First Four was March 18 only (2 games). First Round starts March 19.
const DATE_ROUND_MAP = {
  '2026-03-18': 0,                    // First Four (2 games, March 18 ET only)
  '2026-03-19': 1, '2026-03-20': 1,  // First Round
  '2026-03-21': 2, '2026-03-22': 2,  // Second Round
  '2026-03-27': 3, '2026-03-28': 3,  // Sweet 16
  '2026-03-29': 4, '2026-03-30': 4,  // Elite Eight
  '2026-04-05': 5,                    // Final Four
  '2026-04-07': 6,                    // Championship
};

// Parse round number from ESPN event data.
// DATE_ROUND_MAP is checked FIRST — it is authoritative and immune to ESPN
// embedding "Championship" in generic tournament-title text for every round.
// Text-based matching is kept only as a fallback for unrecognised dates.
function getRoundNum(event) {
  try {
    // Primary: date-based lookup (hardcoded, always correct for this tournament)
    const gameDate = event.date ? toEasternDateStr(new Date(event.date)) : null;
    if (gameDate && DATE_ROUND_MAP[gameDate] !== undefined) {
      return DATE_ROUND_MAP[gameDate];
    }

    // Secondary: text-based detection from ESPN event notes
    const allTexts = [];
    for (const note of (event.notes || [])) {
      if (note.headline) allTexts.push(note.headline);
    }
    const comp = event.competitions?.[0];
    for (const note of (comp?.notes || [])) {
      if (note.headline) allTexts.push(note.headline);
    }

    for (const text of allTexts) {
      for (const [label, num] of Object.entries(ROUND_LABEL_MAP)) {
        if (text.includes(label)) {
          if (label === 'Championship' && (
            text.includes('First Four') || text.includes('Opening Round') ||
            text.includes('First Round') || text.includes('Round of 64') ||
            text.includes('Second Round') || text.includes('Round of 32')
          )) continue;
          return num;
        }
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

    const gameStatus = espnStatusToGameStatus(status);

    const tipTime = event.date ? new Date(event.date) : null;
    // Use Eastern time for game_date — tournament games are always in the US
    // and evening ET games would otherwise roll into the next UTC day
    const gameDate = tipTime ? toEasternDateStr(tipTime) : null;

    const competitors = comp.competitors || [];
    let homeTeam = '', awayTeam = '', homeScore = 0, awayScore = 0;
    let homeSeed = null, awaySeed = null;

    for (const c of competitors) {
      const name = c.team?.displayName || c.team?.name || '';
      const score = parseInt(c.score || 0, 10);
      const seed = parseInt(c.curatedRank?.current || c.seed || 0, 10) || null;
      if (c.homeAway === 'home') { homeTeam = name; homeScore = score; homeSeed = seed; }
      else { awayTeam = name; awayScore = score; awaySeed = seed; }
    }

    // Extract TV broadcast network (ESPN returns array of broadcast objects)
    const broadcasts = comp.broadcasts || [];
    const tvNetwork = broadcasts.length > 0
      ? (broadcasts[0].names?.[0] || broadcasts[0].market?.type || null)
      : null;

    await pool.query(
      `INSERT INTO games (espn_game_id, round_num, home_team, away_team, home_score, away_score, status, tip_time, game_date, display_clock, period, tv_network, home_seed, away_seed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (espn_game_id) DO UPDATE SET
         round_num = EXCLUDED.round_num,
         home_score = EXCLUDED.home_score,
         away_score = EXCLUDED.away_score,
         status = EXCLUDED.status,
         display_clock = EXCLUDED.display_clock,
         period = EXCLUDED.period,
         tv_network = COALESCE(EXCLUDED.tv_network, games.tv_network),
         home_seed = COALESCE(EXCLUDED.home_seed, games.home_seed),
         away_seed = COALESCE(EXCLUDED.away_seed, games.away_seed)`,
      [espnGameId, roundNum, homeTeam, awayTeam, homeScore, awayScore, gameStatus, tipTime, gameDate, displayClock, period, tvNetwork, homeSeed, awaySeed]
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
// espn_name takes priority over name so overrides (e.g. "Jaron Pierre Jr.") match first
async function buildPlayerIndex() {
  const { rows } = await pool.query('SELECT id, name, espn_name, ncaa_team FROM players');
  const fuse = new Fuse(rows, {
    keys: [
      { name: 'espn_name', weight: 2 },
      { name: 'name', weight: 1 },
    ],
    threshold: 0.3,
    includeScore: true,
  });
  return { fuse, players: rows };
}

// Update player_round_scores from a completed/live box score
// playerIndex is pre-built once per scrape cycle and passed in
// espnToCsv maps ESPN abbreviations → CSV ncaa_team for team validation
async function processBoxScore(boxScore, roundNum, gameStatus, playerIndex, espnToCsv) {
  if (!boxScore || !boxScore.boxscore) return;

  const { fuse } = playerIndex;

  const teams = boxScore.boxscore.players || [];
  for (const teamData of teams) {
    // Resolve which CSV ncaa_team this box score section belongs to.
    const bsAbbr = (teamData.team?.abbreviation || '').toUpperCase();
    const bsDisplayName = (teamData.team?.displayName || teamData.team?.name || '').toLowerCase();
    const csvTeam = espnToCsv[bsAbbr] || ESPN_TO_CSV_ABBREV[bsAbbr] || null;

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

        // Team validation: reject if player's team doesn't match the box score section.
        // Case 1: we know the CSV team from mappings — direct compare
        if (csvTeam && player.ncaa_team.toLowerCase() !== csvTeam.toLowerCase()) continue;
        // Case 2: csvTeam is null (unmapped team) — fall back to display name check
        // using normalizeTeamAbbrev so "Fla" → "florida" rejects "hawaii rainbow warriors"
        if (!csvTeam && bsDisplayName) {
          const playerKeyword = normalizeTeamAbbrev(player.ncaa_team);
          if (playerKeyword && !bsDisplayName.includes(playerKeyword)) continue;
        }

        // Only update if game is live or final (not pre-game)
        if (gameStatus === 'pre') continue;

        // Fix D: find ALL players with this name — the same player can appear
        // on multiple fantasy teams (e.g. Graham Ike on Kunkel AND Gross)
        const { rows: allMatching } = await pool.query(
          `SELECT id FROM players WHERE LOWER(name) = LOWER($1) AND LOWER(ncaa_team) = LOWER($2)`,
          [player.name, player.ncaa_team]
        );

        for (const { id: playerId } of allMatching) {
          await pool.query(
            `INSERT INTO player_round_scores (player_id, round_num, pts, blacked_out)
             VALUES ($1, $2, $3, FALSE)
             ON CONFLICT (player_id, round_num) DO UPDATE SET
               pts = EXCLUDED.pts,
               blacked_out = FALSE`,
            [playerId, roundNum, pts]
          );

          // Mark player as currently playing if game is live
          await pool.query(
            `UPDATE players SET is_playing_now = $1 WHERE id = $2`,
            [gameStatus === 'live', playerId]
          );
        }
      }
    }
  }
}

// Map ESPN team abbreviations → our CSV ncaa_team values
// ESPN uses different abbreviations than our Fantrax CSV
const ESPN_TO_CSV_ABBREV = {
  'ARIZ': 'Ariz', 'AZ': 'Ariz',
  'ARK': 'Ark',
  'ALA': 'Bama', 'BAMA': 'Bama',
  'BYU': 'BYU',
  'DUKE': 'Duke',
  'FLA': 'Fla', 'UF': 'Fla',
  'GONZ': 'Gonz',
  'HOU': 'Hou',
  'IAST': 'IaSt', 'IASU': 'IaSt',
  'ILL': 'Ill', 'ILLN': 'Ill',
  'IOWA': 'Iowa',
  'KU': 'Kan', 'KAN': 'Kan',
  'UK': 'KY', 'KENT': 'KY',
  'LEH': 'Leh',
  'LOU': 'Lou', 'LOUY': 'Lou',
  'MIA': 'Mia-FL', 'MIAF': 'Mia-FL',
  'MICH': 'Mich', 'UMICH': 'Mich',
  'MSU': 'MSU',
  'NEB': 'Nebras', 'NEBR': 'Nebras',
  'OHST': 'OhSt', 'OSU': 'OhSt',
  'PUR': 'Pur',
  'SCU': 'SCla', 'SCLA': 'SCla',
  'SMU': 'SMU',
  'USF': 'SoFL',
  'SJU': 'StJon', 'STJN': 'StJon',
  'SLU': 'StLou',
  'SMC': 'StMar', 'STMA': 'StMar',
  'TENN': 'Tenn', 'UTN': 'Tenn',
  'TEX': 'Tex', 'UT': 'Tex',
  'TTU': 'TxTch', 'TXSO': 'TxTch',
  'UCLA': 'UCLA',
  'CONN': 'UConn', 'UCON': 'UConn',
  'UGA': 'UGA',
  'UNC': 'UNC',
  'USU': 'UtSt', 'UTST': 'UtSt',
  'UVA': 'UVA', 'VIRG': 'UVA',
  'VCU': 'VCU',
  'VAN': 'Vand', 'VAND': 'Vand',
  'WISC': 'Wisc', 'WIS': 'Wisc',
  'PVAM': 'PVAM', 'PV': 'PVAM',
  'AKR': 'Akr',
};

// After scraping all games, black out future rounds for eliminated players
async function updateEliminationStatus() {
  // Get all eliminated NCAA teams from bracket_slots
  const { rows: elimTeams } = await pool.query(
    `SELECT team_abbrev, eliminated_in_round FROM bracket_slots WHERE is_eliminated = TRUE`
  );

  // Load learned team mappings (espn_abbrev → csv_abbrev) from DB
  const teamMappings = await getTeamMappings();
  // Build a reverse map: espn_abbrev → csv_abbrev
  const espnToCsv = {};
  for (const [csvAbbrev, data] of Object.entries(teamMappings)) {
    if (data.espn_abbrev) espnToCsv[data.espn_abbrev.toUpperCase()] = csvAbbrev;
  }

  for (const { team_abbrev, eliminated_in_round } of elimTeams) {
    // Use == null to catch both null and undefined, but NOT 0 (round 0 = First Four)
    if (eliminated_in_round == null) continue;

    // Resolve ESPN abbreviation to our CSV ncaa_team value using learned mapping
    const csvAbbrev = espnToCsv[team_abbrev.toUpperCase()]
      || ESPN_TO_CSV_ABBREV[team_abbrev.toUpperCase()]
      || team_abbrev;

    // Find players on this team — try both the CSV abbrev and original ESPN abbrev
    const { rows: affectedPlayers } = await pool.query(
      `SELECT id FROM players WHERE LOWER(ncaa_team) = LOWER($1) OR LOWER(ncaa_team) = LOWER($2)`,
      [csvAbbrev, team_abbrev]
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

    // Use == null to catch both null and undefined, but NOT 0 (round 0 = First Four)
    if (eliminated_in_round == null) continue;

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

// Un-eliminate any player whose team is NOT confirmed eliminated in bracket_slots.
// Guards against the fuzzy-matching in updateEliminationByCSVAbbrev producing
// false positives that mark players as eliminated before they've even played.
async function cleanupFalseEliminations() {
  // Collect the CSV abbrevs of legitimately eliminated teams using:
  // 1. Exact case-insensitive abbrev match between bracket_slots and players
  // 2. LLM-learned team_mappings (espn_abbrev → csv_abbrev)
  const { rows: legitElim } = await pool.query(`
    SELECT LOWER(p.ncaa_team) AS ncaa_team
    FROM players p
    WHERE (
      -- Direct case-insensitive abbrev match
      EXISTS (
        SELECT 1 FROM bracket_slots bs
        WHERE LOWER(bs.team_abbrev) = LOWER(p.ncaa_team)
          AND bs.is_eliminated = TRUE
          AND bs.eliminated_in_round IS NOT NULL
      )
      OR
      -- LLM-learned mapping match
      EXISTS (
        SELECT 1 FROM team_mappings tm
        JOIN bracket_slots bs ON UPPER(tm.espn_abbrev) = UPPER(bs.team_abbrev)
        WHERE tm.csv_abbrev = p.ncaa_team
          AND bs.is_eliminated = TRUE
          AND bs.eliminated_in_round IS NOT NULL
      )
    )
  `);

  const legitSet = new Set(legitElim.map(r => r.ncaa_team));

  // Find players marked eliminated whose team is NOT in the legitimate set
  const { rows: wronglyElim } = await pool.query(`
    SELECT id, name, ncaa_team FROM players WHERE is_eliminated = TRUE
  `);
  const wrongIds = wronglyElim
    .filter(p => !legitSet.has(p.ncaa_team.toLowerCase()))
    .map(p => p.id);

  if (wrongIds.length > 0) {
    await pool.query(
      `UPDATE players SET is_eliminated = FALSE WHERE id = ANY($1)`,
      [wrongIds]
    );
    // Wipe ALL round scores for falsely eliminated players — including any stale
    // pts that were never blacked_out (written by old scrape runs before cleanup).
    // The scraper will repopulate from ESPN on the next cycle.
    await pool.query(
      `UPDATE player_round_scores SET blacked_out = FALSE, pts = NULL
       WHERE player_id = ANY($1)`,
      [wrongIds]
    );
    console.log(`[scraper] Cleared ${wrongIds.length} false eliminations`);
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
    // Bulk-reset is_playing_now at start of every scrape cycle so players
    // whose game ended but whose name didn't fuzzy-match don't stay green forever
    await pool.query(`UPDATE players SET is_playing_now = FALSE WHERE is_playing_now = TRUE`);

    const events = await fetchTournamentGames();
    console.log(`[scraper] Found ${events.length} tournament events`);

    await upsertGames(events);
    await updateBracketSlots(events);

    // Load the authoritative round_num from the games table (already corrected
    // by the date-based migration at startup). This is the source of truth —
    // we do NOT re-run getRoundNum() here, which can misfire if ESPN embeds
    // "Championship" in the event title for every round.
    const { rows: gameRoundRows } = await pool.query(
      `SELECT espn_game_id, round_num FROM games WHERE round_num IS NOT NULL`
    );
    const gameRoundMap = {};
    gameRoundRows.forEach(g => { gameRoundMap[g.espn_game_id] = g.round_num; });

    // Build player index once per scrape cycle
    const playerIndex = await buildPlayerIndex();

    // Build ESPN abbreviation → CSV ncaa_team map for team validation in box scores
    const teamMappings = await getTeamMappings();
    const espnToCsv = {};
    for (const [csvAbbrev, data] of Object.entries(teamMappings)) {
      if (data.espn_abbrev) espnToCsv[data.espn_abbrev.toUpperCase()] = csvAbbrev;
    }

    // Process box scores for live and recently finished games
    for (const event of events) {
      const status = event.status?.type?.name || '';
      const gameStatus = espnStatusToGameStatus(status);

      if (gameStatus === 'pre') continue;

      const roundNum = gameRoundMap[event.id];
      if (roundNum === null || roundNum === undefined || roundNum < 0) continue;

      const boxScore = await fetchBoxScore(event.id);
      if (boxScore) {
        await processBoxScore(boxScore, roundNum, gameStatus, playerIndex, espnToCsv);
      }

      // Small delay to be polite to ESPN
      await new Promise(r => setTimeout(r, 200));
    }

    await updateEliminationStatus();
    await cleanupFalseEliminations();
    await recomputeTotals();

    await pool.query(
      `INSERT INTO scrape_log (status, message) VALUES ('ok', $1)`,
      [`Scraped ${events.length} events`]
    );

    // Fix 4: prune scrape_log — keep only last 24 hours
    await pool.query(`DELETE FROM scrape_log WHERE scraped_at < NOW() - INTERVAL '24 hours'`);

    console.log('[scraper] Scrape complete');
  } catch (err) {
    console.error('[scraper] Scrape error:', err.message);
    await pool.query(
      `INSERT INTO scrape_log (status, message) VALUES ('error', $1)`,
      [err.message]
    ).catch(() => {});
  }
}

const INTERVAL_LIVE_MS    = 30_000;   // 30 seconds when games are live
const INTERVAL_DEFAULT_MS = 60_000;   // 1 minute otherwise (to catch game start quickly)

async function hasLiveGames() {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM games WHERE status = 'live' LIMIT 1`
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function schedulerLoop() {
  let delay = INTERVAL_DEFAULT_MS;
  try {
    await scrape();
  } catch (err) {
    // scrape() has its own try/catch, but guard here too so the loop never dies
    console.error('[scraper] Unexpected error outside scrape():', err.message);
  }
  try {
    const live = await hasLiveGames();
    delay = live ? INTERVAL_LIVE_MS : INTERVAL_DEFAULT_MS;
    console.log(`[scraper] Next scrape in ${delay / 1000}s (${live ? 'LIVE' : 'idle'})`);
  } catch (err) {
    console.error('[scraper] Error checking live games, defaulting to 5min:', err.message);
  }
  // Always reschedule — even if both blocks above threw
  setTimeout(schedulerLoop, delay);
}

function startScheduler() {
  console.log('[scraper] Scheduler started — 30s when live, 5min otherwise');
  schedulerLoop();
}

module.exports = { scrape, startScheduler };
