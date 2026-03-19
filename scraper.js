const axios = require('axios');
const cron = require('node-cron');
const Fuse = require('fuse.js');
const { pool } = require('./db');

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
const TOURNAMENT_DATES = [
  '20260318', '20260319', // First Four
  '20260320', '20260321', // First Round
  '20260322', '20260323', // Second Round
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
const DATE_ROUND_MAP = {
  '2026-03-18': 0, '2026-03-19': 0,  // First Four
  '2026-03-20': 1, '2026-03-21': 1,  // First Round
  '2026-03-22': 2, '2026-03-23': 2,  // Second Round
  '2026-03-27': 3, '2026-03-28': 3,  // Sweet 16
  '2026-03-29': 4, '2026-03-30': 4,  // Elite Eight
  '2026-04-05': 5,                    // Final Four
  '2026-04-07': 6,                    // Championship
};

// Parse round number from ESPN event data
function getRoundNum(event) {
  try {
    const allTexts = [];

    // Collect all note/headline texts
    for (const note of (event.notes || [])) {
      if (note.headline) allTexts.push(note.headline);
    }
    const comp = event.competitions?.[0];
    for (const note of (comp?.notes || [])) {
      if (note.headline) allTexts.push(note.headline);
    }

    // Check each text against label map — but skip a match if the ONLY
    // reason it matched was a generic tournament-name substring like
    // "Championship" appearing in "NCAA Championship - First Four"
    for (const text of allTexts) {
      for (const [label, num] of Object.entries(ROUND_LABEL_MAP)) {
        if (text.includes(label)) {
          // If we matched 'Championship' but the text also contains a
          // more specific early-round label, skip this match and keep looking
          if (label === 'Championship' && (
            text.includes('First Four') || text.includes('Opening Round') ||
            text.includes('First Round') || text.includes('Round of 64') ||
            text.includes('Second Round') || text.includes('Round of 32')
          )) continue;
          return num;
        }
      }
    }

    // Fallback: infer from game date
    const gameDate = event.date ? toEasternDateStr(new Date(event.date)) : null;
    if (gameDate && DATE_ROUND_MAP[gameDate] !== undefined) {
      return DATE_ROUND_MAP[gameDate];
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
  // #region agent log — Hypothesis C: log stat group names arrays to see if PTS is present
  const statGroupNames = teams.flatMap(t => (t.statistics || []).map(sg => sg.names || []));
  console.log('[DEBUG][HypC] stat group names arrays found:', JSON.stringify(statGroupNames));
  fetch('http://127.0.0.1:7383/ingest/018218a6-95bf-41ca-a9ce-64d9139aaf85',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c5430a'},body:JSON.stringify({sessionId:'c5430a',location:'scraper.js:processBoxScore',message:'stat group names',data:{roundNum,gameStatus,statGroupNames},hypothesisId:'C',timestamp:Date.now()})}).catch(()=>{});
  // #endregion
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

        // #region agent log — Hypothesis D: log when a pool player is matched (catches Graham Ike dup issue)
        console.log(`[DEBUG][HypD] matched espnName="${espnName}" → player.id=${player.id} player.name="${player.name}" pts=${pts} round=${roundNum}`);
        fetch('http://127.0.0.1:7383/ingest/018218a6-95bf-41ca-a9ce-64d9139aaf85',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c5430a'},body:JSON.stringify({sessionId:'c5430a',location:'scraper.js:processBoxScore:match',message:'pool player matched',data:{espnName,playerId:player.id,playerName:player.name,pts,roundNum},hypothesisId:'D',timestamp:Date.now()})}).catch(()=>{});
        // #endregion

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

  // #region agent log — Hypothesis B: which pool teams are failing to match eliminated ESPN teams?
  console.log('[DEBUG][HypB] eliminated ESPN teams in bracket_slots:', JSON.stringify(elimTeams.map(t => ({ abbrev: t.team_abbrev, name: t.team_name, round: t.eliminated_in_round }))));
  fetch('http://127.0.0.1:7383/ingest/018218a6-95bf-41ca-a9ce-64d9139aaf85',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c5430a'},body:JSON.stringify({sessionId:'c5430a',location:'scraper.js:updateEliminationByCSVAbbrev',message:'eliminated ESPN teams',data:{elimTeams:elimTeams.map(t=>({a:t.team_abbrev,n:t.team_name,r:t.eliminated_in_round}))},hypothesisId:'B',timestamp:Date.now()})}).catch(()=>{});
  // #endregion

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

    // #region agent log — Hypothesis B: log each pool team's match result
    console.log(`[DEBUG][HypB] pool team "${ncaa_team}" → eliminated_in_round=${eliminated_in_round}, directMatch=${!!directMatch}`);
    // #endregion

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

// ─── Alert helpers ────────────────────────────────────────────────────────────

// Round label for alert messages
const ROUND_NAMES = ['Play-In', 'R1', 'R2', 'Sweet 16', 'Elite Eight', 'Final Four', 'Championship'];

// Snapshot player elimination status + team ranks before a scrape
async function snapshotBeforeScrape() {
  const { rows: players } = await pool.query(
    `SELECT id, name, owner, ncaa_team, is_eliminated, total_pts FROM players`
  );
  const { rows: teams } = await pool.query(
    `SELECT owner, total_pts FROM fantasy_teams ORDER BY total_pts DESC`
  );
  const rankMap = {};
  teams.forEach((t, i) => { rankMap[t.owner] = i + 1; });

  // Also snapshot current round scores to detect new milestones
  const { rows: scores } = await pool.query(
    `SELECT player_id, round_num, pts FROM player_round_scores WHERE pts IS NOT NULL`
  );
  const scoreMap = {};
  scores.forEach(s => {
    const key = `${s.player_id}-${s.round_num}`;
    scoreMap[key] = s.pts;
  });

  return { players, rankMap, scoreMap };
}

// Compare before/after state and insert alerts for changes
async function detectAndInsertAlerts(before, displayNames) {
  const { players: beforePlayers, rankMap: beforeRanks, scoreMap: beforeScores } = before;

  // Current state
  const { rows: afterPlayers } = await pool.query(
    `SELECT p.id, p.name, p.owner, p.ncaa_team, p.is_eliminated, p.total_pts,
            COALESCE(ft.display_name, p.owner) AS display_name
     FROM players p
     JOIN fantasy_teams ft ON ft.owner = p.owner`
  );
  const { rows: afterTeams } = await pool.query(
    `SELECT owner, total_pts, COALESCE(display_name, owner) AS display_name
     FROM fantasy_teams ORDER BY total_pts DESC`
  );
  const afterRankMap = {};
  afterTeams.forEach((t, i) => { afterRankMap[t.owner] = i + 1; });

  const { rows: afterScores } = await pool.query(
    `SELECT prs.player_id, prs.round_num, prs.pts,
            p.name AS player_name, p.owner,
            COALESCE(ft.display_name, p.owner) AS display_name
     FROM player_round_scores prs
     JOIN players p ON p.id = prs.player_id
     JOIN fantasy_teams ft ON ft.owner = p.owner
     WHERE prs.pts IS NOT NULL AND prs.blacked_out = FALSE`
  );

  const beforePlayerMap = {};
  beforePlayers.forEach(p => { beforePlayerMap[p.id] = p; });

  // #region agent log
  let _alertCounts = { elimination: 0, milestone: 0, rank_change: 0 };
  // #endregion

  // Detect newly eliminated players
  for (const player of afterPlayers) {
    const prev = beforePlayerMap[player.id];
    if (prev && !prev.is_eliminated && player.is_eliminated) {
      await pool.query(
        `INSERT INTO alerts (type, message, owner, player_name)
         VALUES ('elimination', $1, $2, $3)`,
        [
          `${player.display_name} loses ${player.name} — ${player.ncaa_team} eliminated`,
          player.owner,
          player.name,
        ]
      );
      // #region agent log
      _alertCounts.elimination++;
      // #endregion
    }
  }

  // Detect scoring milestones (new score of 20+ in a round)
  for (const score of afterScores) {
    const key = `${score.player_id}-${score.round_num}`;
    const prevPts = before.scoreMap[key];
    // Fire if this is a newly recorded score (wasn't there before) and >= 20 pts
    if (prevPts === undefined && score.pts >= 20) {
      const roundLabel = ROUND_NAMES[score.round_num] || `Round ${score.round_num}`;
      await pool.query(
        `INSERT INTO alerts (type, message, owner, player_name)
         VALUES ('milestone', $1, $2, $3)`,
        [
          `${score.player_name} drops ${score.pts} pts for ${score.display_name} in ${roundLabel}!`,
          score.owner,
          score.player_name,
        ]
      );
      // #region agent log
      _alertCounts.milestone++;
      // #endregion
    }
  }

  // Detect rank changes (only when scores have actually changed)
  for (const team of afterTeams) {
    const prevRank = beforeRanks[team.owner];
    const newRank = afterRankMap[team.owner];
    if (prevRank && newRank && prevRank !== newRank) {
      const dir = newRank < prevRank ? `jumps to #${newRank}` : `falls to #${newRank}`;
      await pool.query(
        `INSERT INTO alerts (type, message, owner)
         VALUES ('rank_change', $1, $2)`,
        [`${team.display_name} ${dir} in the standings`, team.owner]
      );
      // #region agent log
      _alertCounts.rank_change++;
      // #endregion
    }
  }

  // #region agent log — Hypothesis A: are rank_change alerts flooding each cycle?
  console.log('[DEBUG][HypA] alerts fired this cycle:', JSON.stringify(_alertCounts));
  fetch('http://127.0.0.1:7383/ingest/018218a6-95bf-41ca-a9ce-64d9139aaf85',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c5430a'},body:JSON.stringify({sessionId:'c5430a',location:'scraper.js:detectAndInsertAlerts',message:'alerts fired this cycle',data:_alertCounts,hypothesisId:'A',timestamp:Date.now()})}).catch(()=>{});
  // #endregion
}

// Main scrape function
async function scrape() {
  console.log('[scraper] Starting scrape at', new Date().toISOString());
  try {
    // Snapshot state before scrape for alert diffing
    const beforeState = await snapshotBeforeScrape();

    const events = await fetchTournamentGames();
    console.log(`[scraper] Found ${events.length} tournament events`);

    await upsertGames(events);
    await updateBracketSlots(events);

    // Process box scores for live and recently finished games
    for (const event of events) {
      const status = event.status?.type?.name || '';
      const gameStatus = espnStatusToGameStatus(status);

      if (gameStatus === 'pre') continue;

      const roundNum = getRoundNum(event);
      if (roundNum === null || roundNum === undefined || roundNum < 0) continue;

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

    // #region agent log — Hypothesis E: who still has is_playing_now=TRUE after scrape?
    const { rows: _playingNow } = await pool.query(`SELECT p.name, p.ncaa_team, ft.display_name FROM players p JOIN fantasy_teams ft ON ft.owner = p.owner WHERE p.is_playing_now = TRUE`);
    console.log('[DEBUG][HypE] players with is_playing_now=TRUE after scrape:', JSON.stringify(_playingNow));
    fetch('http://127.0.0.1:7383/ingest/018218a6-95bf-41ca-a9ce-64d9139aaf85',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c5430a'},body:JSON.stringify({sessionId:'c5430a',location:'scraper.js:scrape:postRecompute',message:'is_playing_now after scrape',data:{players:_playingNow},hypothesisId:'E',timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    // Detect and store alerts based on what changed
    await detectAndInsertAlerts(beforeState);

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
