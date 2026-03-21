/* ─── Constants ───────────────────────────────────────────────────────────── */
const ROUND_LABELS = ['Play-In', 'R1', 'R2', 'S16', 'E8', 'F4', 'Champ'];
const ROUND_FULL = ['First Four', 'First Round', 'Second Round', 'Sweet 16', 'Elite Eight', 'Final Four', 'Championship'];
const REFRESH_MS = 30_000;

/* ─── State ───────────────────────────────────────────────────────────────── */
let state = {
  standings: [],
  games: [],
  commentary: null,
  teamMappings: {},
  lastUpdated: null,
  hasLive: false,
};

/* ─── Fetch helpers ───────────────────────────────────────────────────────── */
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function loadAll() {
  try {
    const [standings, games, commentary, teamMappings, analytics, lastUpdated] = await Promise.all([
      fetchJSON('/api/standings'),
      fetchJSON('/api/games'),
      fetchJSON('/api/commentary'),
      fetchJSON('/api/team-mappings'),
      fetchJSON('/api/analytics'),
      fetchJSON('/api/last-updated'),
    ]);
    state.standings = standings;
    state.games = games;
    state.commentary = commentary;
    state.teamMappings = teamMappings;
    state.analytics = analytics;
    state.lastUpdated = lastUpdated;
    state.hasLive = games.some(g => g.status === 'live');
    render();
  } catch (err) {
    console.error('Load error:', err);
  }
}

/* ─── Render orchestrator ─────────────────────────────────────────────────── */
function render() {
  renderHeader();
  renderLeaderboard();
  renderCommentary();
  renderAnalytics();
  renderCards();
  renderGames();
}

/* ─── Header ──────────────────────────────────────────────────────────────── */
function renderHeader() {
  const { lastUpdated, hasLive } = state;
  const timeEl = document.getElementById('last-updated-time');
  const liveEl = document.getElementById('live-indicator');

  if (lastUpdated?.scraped_at) {
    const d = new Date(lastUpdated.scraped_at);
    timeEl.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  if (hasLive) {
    liveEl.classList.remove('hidden');
  } else {
    liveEl.classList.add('hidden');
  }
}

/* ─── Commentary ──────────────────────────────────────────────────────────── */
function renderCommentary() {
  const { commentary } = state;
  const narrativeEl = document.getElementById('commentary-narrative');
  const timestampEl = document.getElementById('commentary-timestamp');
  const picksEl = document.getElementById('commentary-picks');

  if (!commentary?.narrative) {
    narrativeEl.innerHTML = '<div class="loading-msg">Commentary generates every 2 hours on game days. Click Regenerate to generate now.</div>';
    timestampEl.textContent = '';
    picksEl.classList.add('hidden');
    return;
  }

  narrativeEl.textContent = commentary.narrative;

  if (commentary.generated_at) {
    const d = new Date(commentary.generated_at);
    timestampEl.textContent = `Updated ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  // Render top 3 / bottom 3 picks
  const top3 = commentary.top_3 || [];
  const bottom3 = commentary.bottom_3 || [];

  if (top3.length || bottom3.length) {
    const topMedals = ['🥇', '🥈', '🥉'];
    const bottomMedals = ['💀', '😬', '😅'];

    const topHTML = top3.map((pick, i) => `
      <div class="pick-row">
        <span class="pick-medal">${topMedals[i] || (i + 1)}</span>
        <div class="pick-content">
          <div class="pick-owner">${esc(pick.owner)}</div>
          <div class="pick-reason">${esc(pick.reason)}</div>
        </div>
      </div>`).join('');

    const bottomHTML = bottom3.map((pick, i) => `
      <div class="pick-row">
        <span class="pick-medal">${bottomMedals[i] || (i + 1)}</span>
        <div class="pick-content">
          <div class="pick-owner">${esc(pick.owner)}</div>
          <div class="pick-reason">${esc(pick.reason)}</div>
        </div>
      </div>`).join('');

    picksEl.innerHTML = `
      <div class="picks-group">
        <div class="picks-label top">Claude's Top 3 to Win</div>
        ${topHTML || '<div class="pick-reason">No picks yet</div>'}
      </div>
      <div class="picks-group">
        <div class="picks-label bottom">Most Likely to Finish Last</div>
        ${bottomHTML || '<div class="pick-reason">No picks yet</div>'}
      </div>`;
    picksEl.classList.remove('hidden');
  } else {
    picksEl.classList.add('hidden');
  }
}

/* ─── Analytics Dashboard ─────────────────────────────────────────────────── */
function renderAnalytics() {
  const a = state.analytics;
  const llm = state.commentary?.analytics; // Claude's qualitative insights (momentum, matchups)
  const container = document.getElementById('analytics-dashboard');

  if (!a) {
    container.innerHTML = '<div class="loading-msg">Loading analytics...</div>';
    return;
  }

  const ps = a.pool_stats || {};
  let html = '';

  // Pool-wide stat bar
  html += `<div class="analytics-stat-bar">
    <div class="stat-pill"><span class="stat-value">${parseInt(ps.pool_total_pts) || 0}</span><span class="stat-label">Pool Pts</span></div>
    <div class="stat-pill"><span class="stat-value">${parseInt(ps.games_completed) || 0}</span><span class="stat-label">Games Done</span></div>
    <div class="stat-pill"><span class="stat-value">${parseInt(ps.games_live) || 0}</span><span class="stat-label">Live</span></div>
    <div class="stat-pill"><span class="stat-value">${parseInt(ps.total_players_scored) || 0}</span><span class="stat-label">Players Scored</span></div>
    <div class="stat-pill"><span class="stat-value">${parseInt(ps.total_eliminated) || 0}</span><span class="stat-label">Eliminated</span></div>
    <div class="stat-pill"><span class="stat-value">${parseInt(ps.total_alive) || 0}</span><span class="stat-label">Alive</span></div>
  </div>`;

  // Top Scorers (real DB data)
  if (a.player_leaders?.length) {
    html += `<div class="analytics-section">
      <div class="analytics-section-header">
        <span class="analytics-section-icon">🏀</span>
        <span class="analytics-section-title">Top Scorers</span>
      </div>
      <table class="analytics-table">
        <thead><tr><th></th><th>Player</th><th>School</th><th>Owner</th><th class="right">Pts</th></tr></thead>
        <tbody>${a.player_leaders.map((p, i) => {
          const rank = i + 1;
          const rankClass = rank <= 3 ? ` rank-${rank}` : '';
          const elimClass = p.is_eliminated ? ' dimmed' : '';
          return `<tr>
            <td class="rank-col${rankClass}">${rank}</td>
            <td class="bold${elimClass}">${esc(p.name)}${p.is_eliminated ? ' ✗' : ''}</td>
            <td class="dimmed">${esc(p.team)}</td>
            <td class="gold">${esc(p.owner)}</td>
            <td class="right big gold">${p.pts}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>`;
  }

  // Two-column grid
  html += '<div class="analytics-grid">';

  // Team Efficiency (real DB data)
  if (a.team_efficiency?.length) {
    html += `<div class="analytics-section">
      <div class="analytics-section-header">
        <span class="analytics-section-icon">📊</span>
        <span class="analytics-section-title">Team Efficiency</span>
      </div>
      <table class="analytics-table">
        <thead><tr><th>Owner</th><th class="right">Scored</th><th class="right">Alive</th><th class="right">Avg/Player</th><th class="right">Total</th></tr></thead>
        <tbody>${a.team_efficiency.map(t => `
          <tr>
            <td class="bold">${esc(t.owner)}</td>
            <td class="right dimmed">${t.players_played || 0}</td>
            <td class="right">${t.players_remaining}/10</td>
            <td class="right gold bold">${parseFloat(t.avg_per_player || 0).toFixed(1)}</td>
            <td class="right bold">${t.total_pts || 0}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }

  // Round Breakdown (real DB data)
  if (a.round_summary?.length) {
    html += `<div class="analytics-section">
      <div class="analytics-section-header">
        <span class="analytics-section-icon">📋</span>
        <span class="analytics-section-title">Round Breakdown</span>
      </div>
      <table class="analytics-table">
        <thead><tr><th>Round</th><th class="right">Pool Pts</th><th class="right">Players</th><th>Top Scorer</th><th class="right">Pts</th></tr></thead>
        <tbody>${a.round_summary.map(r => `
          <tr>
            <td class="bold">${esc(r.round)}</td>
            <td class="right bold">${r.total_pts}</td>
            <td class="right dimmed">${r.players_scored}</td>
            <td>${esc(r.top_scorer || '—')} <span class="dimmed">${r.top_scorer_team ? `(${esc(r.top_scorer_team)})` : ''}</span></td>
            <td class="right big gold">${r.top_scorer_pts || '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }

  html += '</div>';

  // Elimination Impact (real DB data)
  if (a.elimination_impact?.length) {
    html += `<div class="analytics-section">
      <div class="analytics-section-header">
        <span class="analytics-section-icon">💀</span>
        <span class="analytics-section-title">Elimination Tracker</span>
      </div>
      <table class="analytics-table">
        <thead><tr><th>Owner</th><th class="right">Lost</th><th>Players Eliminated</th></tr></thead>
        <tbody>${a.elimination_impact.map(e => `
          <tr>
            <td class="bold">${esc(e.owner)}</td>
            <td class="right big" style="color:var(--red)">${e.players_lost}</td>
            <td class="dimmed">${(e.names_lost || []).join(', ')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }

  // LLM-generated sections (momentum + matchups) — only if available
  if (llm?.momentum?.length || llm?.matchups?.length) {
    html += '<div class="analytics-grid">';

    if (llm.momentum?.length) {
      html += `<div class="analytics-section">
        <div class="analytics-section-header">
          <span class="analytics-section-icon">📈</span>
          <span class="analytics-section-title">Momentum</span>
        </div>
        <table class="analytics-table">
          <thead><tr><th>Owner</th><th>Trend</th><th>Analysis</th></tr></thead>
          <tbody>${llm.momentum.map(m => {
            const arrow = m.trend === 'up' ? '▲' : m.trend === 'down' ? '▼' : '▸';
            return `<tr>
              <td class="bold">${esc(m.owner)}</td>
              <td><span class="trend-badge ${m.trend}"><span class="arrow">${arrow}</span> ${m.trend.toUpperCase()}</span></td>
              <td class="dimmed">${esc(m.reason)}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>`;
    }

    if (llm.matchups?.length) {
      html += `<div class="analytics-section">
        <div class="analytics-section-header">
          <span class="analytics-section-icon">⚔️</span>
          <span class="analytics-section-title">Matchups to Watch</span>
        </div>
        ${llm.matchups.map(m => `
          <div class="matchup-card">
            <div class="matchup-teams">
              <span>${esc(m.team1)}</span>
              <span class="matchup-vs">vs</span>
              <span>${esc(m.team2)}</span>
            </div>
            <div class="matchup-analysis">${esc(m.analysis)}</div>
          </div>`).join('')}
      </div>`;
    }

    html += '</div>';
  }

  container.innerHTML = html;
}

/* ─── Commentary + Analytics Tab Switching ─────────────────────────────────── */
document.querySelectorAll('.commentary-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.commentary-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.commentary-tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

document.getElementById('commentary-regen-btn').addEventListener('click', async function () {
  this.disabled = true;
  this.textContent = '↺ Generating...';
  try {
    await fetch('/api/commentary/regenerate', { method: 'POST' });
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      const commentary = await fetchJSON('/api/commentary');
      const prevTime = state.commentary?.generated_at;
      if (commentary.generated_at !== prevTime || attempts > 10) {
        state.commentary = commentary;
        renderCommentary();
        renderAnalytics();
        renderCards();
        clearInterval(poll);
        this.disabled = false;
        this.textContent = '↺ Regenerate';
      }
    }, 3000);
  } catch {
    this.disabled = false;
    this.textContent = '↺ Regenerate';
  }
});

/* ─── Leaderboard Strip ───────────────────────────────────────────────────── */
function renderLeaderboard() {
  const container = document.getElementById('leaderboard-strip');
  if (!state.standings.length) { container.innerHTML = '<div class="loading-msg">No data yet</div>'; return; }

  const header = `
    <div class="lb-header">
      <span class="lb-header-cell">#</span>
      <span class="lb-header-cell">Name</span>
      <span class="lb-header-cell right">Alive</span>
      <span class="lb-header-cell right">Max</span>
      <span class="lb-header-cell right">Pts</span>
    </div>`;

  const rows = state.standings.map((team, idx) => {
    const rank = idx + 1;
    const rankClass = rank <= 3 ? `rank-${rank}` : '';
    const name = esc(team.display_name || team.owner);
    const ceiling = team.max_possible_pts ?? team.total_pts;
    return `
      <div class="lb-card" onclick="scrollToCard('${esc(team.owner)}')" title="Jump to ${name}'s card">
        <span class="lb-cell lb-rank ${rankClass}">${rank}</span>
        <span class="lb-cell lb-owner">${name}</span>
        <span class="lb-cell lb-alive-cell">${team.players_remaining}/10</span>
        <span class="lb-cell lb-ceiling">▲${ceiling}</span>
        <span class="lb-cell lb-pts">${team.total_pts}</span>
      </div>`;
  }).join('');

  container.innerHTML = header + rows;
}

function scrollToCard(owner) {
  const el = document.getElementById(`card-${owner}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ─── Team Cards ──────────────────────────────────────────────────────────── */
function renderCards() {
  const grid = document.getElementById('cards-grid');
  if (!state.standings.length) { grid.innerHTML = '<div class="loading-msg">No data yet</div>'; return; }

  // Build set of players currently playing (for live highlighting)
  const playingSet = new Set();
  state.standings.forEach(team => {
    team.players?.forEach(p => { if (p.is_playing_now) playingSet.add(p.id); });
  });

  grid.innerHTML = state.standings.map((team, idx) => buildTeamCard(team, idx + 1)).join('');
}

function buildTeamCard(team, rank) {
  const rankClass = rank <= 3 ? `rank-${rank}` : '';
  const alive = team.players_remaining;
  const total = team.total_pts;

  // Column totals per round (index 0 = play-in, 1-6 = main rounds)
  const roundTotals = Array(7).fill(0);
  (team.players || []).forEach(p => {
    p.rounds?.forEach(r => {
      if (!r.blacked_out && r.pts != null) {
        roundTotals[r.round] += r.pts;
      }
    });
  });

  const headerRow = ROUND_LABELS.map(l =>
    `<th class="col-round">${l}</th>`
  ).join('');

  const playerRows = (team.players || []).map(p => buildPlayerRow(p)).join('');

  const footerRounds = roundTotals.map((t, i) => {
    const hasAny = (team.players || []).some(p => {
      const r = p.rounds?.[i];
      return r && !r.blacked_out && r.pts != null;
    });
    return `<td class="col-round ${hasAny ? '' : 'no-pts'}">${hasAny ? t : '—'}</td>`;
  }).join('');

  const displayName = esc(team.display_name || team.owner);
  const ceiling = team.max_possible_pts ?? total;
  const blurb = state.commentary?.team_blurbs?.[team.display_name || team.owner] || '';

  return `
    <div class="team-card" id="card-${esc(team.owner)}">
      <div class="team-card-header">
        <div class="team-card-owner">
          <div class="rank-badge ${rankClass}">${rank}</div>
          <span class="team-owner-name">${displayName}</span>
        </div>
        <div class="team-card-totals">
          <span class="card-total-pts">${total}</span>
          <span class="ceiling-badge" title="Max possible score if all alive players win out">▲${ceiling}</span>
          <span class="card-alive"><span class="alive-count">${alive}</span>/10 alive</span>
        </div>
      </div>
      ${blurb ? `<div class="team-blurb">${esc(blurb)}</div>` : ''}
      <div class="player-table-wrap">
        <table class="player-table">
          <thead>
            <tr>
              <th class="col-name">Player</th>
              <th class="col-team">Team</th>
              ${headerRow}
              <th class="col-total">Total</th>
            </tr>
          </thead>
          <tbody>${playerRows}</tbody>
          <tfoot>
            <tr>
              <td class="col-name" colspan="2"><strong>TOTAL</strong></td>
              ${footerRounds}
              <td class="col-total">${total}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;
}

function buildPlayerRow(player) {
  const isElim = player.is_eliminated;
  const isPlaying = player.is_playing_now;
  let rowClass = '';
  if (isElim) rowClass = 'eliminated';
  else if (isPlaying) rowClass = 'playing';

  const roundCells = (player.rounds || []).map(r => {
    if (r.blacked_out) {
      return `<td class="round-cell blacked-out col-round"></td>`;
    }
    if (r.pts === null) {
      const liveClass = isPlaying && !isElim ? ' live-now' : '';
      return `<td class="round-cell no-pts col-round${liveClass}">—</td>`;
    }
    const liveClass = isPlaying ? ' live-now' : '';
    return `<td class="round-cell has-pts col-round${liveClass}">${r.pts}</td>`;
  }).join('');

  return `
    <tr class="player-row ${rowClass}">
      <td class="col-name">${esc(player.name)}</td>
      <td class="col-team">${esc(player.ncaa_team)}</td>
      ${roundCells}
      <td class="col-total">${player.total_pts}</td>
    </tr>
  `;
}

/* ─── Team name matching (CSV abbrev → ESPN display name keywords) ─────────── */
// Use nicknames where school names are ambiguous (e.g. Miami FL vs Miami OH,
// Michigan vs Michigan State, Iowa vs Iowa State, Texas vs Texas Tech, etc.)
const TEAM_KEYWORDS = {
  'Ariz':    'wildcats',        'Ark':    'razorbacks',
  'Bama':    'crimson tide',    'BYU':    'cougars',
  'Duke':    'blue devils',     'Fla':    'gators',
  'Gonz':    'bulldogs',        'Hou':    'houston',
  'IaSt':    'cyclones',        'Ill':    'illini',
  'Iowa':    'hawkeyes',        'Kan':    'jayhawks',
  'KY':      'wildcats',        'Leh':    'lehigh',
  'Lou':     'cardinals',       'Mia-FL': 'hurricanes',
  'Mich':    'wolverines',      'MSU':    'spartans',
  'Nebras':  'cornhuskers',     'OhSt':   'buckeyes',
  'Pur':     'boilermakers',    'SCla':   'santa clara',
  'SMU':     'mustangs',        'SoFL':   'south florida',
  'StJon':   "red storm",       'StLou':  'billikens',
  'StMar':   'gaels',           'Tenn':   'volunteers',
  'Tex':     'longhorns',       'TxTch':  'red raiders',
  'UCLA':    'bruins',          'UConn':  'huskies',
  'UGA':     'bulldogs',        'UNC':    'tar heels',
  'UtSt':    'utah state',      'UVA':    'cavaliers',
  'VCU':     'rams',            'Vand':   'commodores',
  'Wisc':    'badgers',         'PVAM':   'prairie view',
  'Akr':     'zips',
};

function playerTeamMatchesGame(ncaaTeam, espnTeamName) {
  if (!espnTeamName) return false;
  const haystack = espnTeamName.toLowerCase();

  // Prefer the Claude-learned mapping: exact ESPN name match
  const learned = state.teamMappings[ncaaTeam];
  if (learned?.espn_name) {
    return haystack === learned.espn_name.toLowerCase();
  }

  // Fall back to keyword table
  const keyword = TEAM_KEYWORDS[ncaaTeam] || ncaaTeam.toLowerCase();
  return haystack.includes(keyword);
}

function findPlayersInGame(game) {
  const results = [];
  for (const team of state.standings) {
    for (const player of team.players || []) {
      const inHome = playerTeamMatchesGame(player.ncaa_team, game.home_team || '');
      const inAway = playerTeamMatchesGame(player.ncaa_team, game.away_team || '');
      if (inHome || inAway) {
        const roundPts = player.rounds?.[game.round_num ?? 1]?.pts ?? null;
        results.push({
          name: player.name,
          ncaa_team: player.ncaa_team,
          owner: team.display_name || team.owner,
          pts: roundPts,
          total_pts: player.total_pts,
          side: inHome ? game.home_team : game.away_team,
        });
      }
    }
  }
  // Sort: players with pts first, then alphabetically
  return results.sort((a, b) => (b.pts ?? -1) - (a.pts ?? -1));
}

// Track which non-live game cards are manually expanded by the user
const expandedGames = new Set();

function toggleGameExpand(gameId, isLive) {
  // Live games are always expanded — clicking a live game does nothing
  if (isLive) return;
  if (expandedGames.has(gameId)) {
    expandedGames.delete(gameId);
  } else {
    expandedGames.add(gameId);
  }
  renderGames();
}

/* ─── Games Sidebar ───────────────────────────────────────────────────────── */
function renderGames() {
  const container = document.getElementById('games-list');
  if (!state.games.length) {
    container.innerHTML = '<div class="loading-msg">No tournament games found yet.<br>Check back once the bracket is set.</div>';
    return;
  }

  // Live games are always expanded — no toggle needed
  const liveGames = state.games.filter(g => g.status === 'live');
  const otherGames = state.games.filter(g => g.status !== 'live');

  // Group non-live by local date (derived from tip_time in browser's timezone)
  const byDate = {};
  otherGames.forEach(g => {
    const key = g.tip_time ? localDateStr(new Date(g.tip_time)) : normalizeDate(g.game_date);
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(g);
  });

  let html = '';

  // Live games float to the top
  if (liveGames.length) {
    html += `<div class="games-date-group">
      <div class="games-date-header"><span class="pulse-dot"></span>&nbsp;Live Now</div>
      ${liveGames.map(gameCard).join('')}
    </div>`;
  }

  // Sort dates chronologically; show upcoming first, then completed
  const today = todayStr();
  const upcomingDates = Object.keys(byDate).filter(d => d >= today).sort();
  const pastDates = Object.keys(byDate).filter(d => d < today).sort().reverse();

  for (const date of [...upcomingDates, ...pastDates]) {
    const label = formatDateLabel(date);
    html += `<div class="games-date-group">
      <div class="games-date-header">${label}</div>
      ${byDate[date].map(gameCard).join('')}
    </div>`;
  }

  container.innerHTML = html;
}

function gameCard(g) {
  const roundNum = g.round_num != null ? g.round_num : 1;
  const roundLabel = ROUND_FULL[roundNum] != null ? ROUND_FULL[roundNum] : `Round ${roundNum}`;
  const isLive = g.status === 'live';
  // Live games always show expanded; other games follow user toggle state
  const isExpanded = isLive || expandedGames.has(g.espn_game_id);

  let statusStr = '';
  if (isLive) {
    statusStr = liveClockLabel(g.display_clock, g.period);
  } else if (g.status === 'final') {
    statusStr = 'Final';
  } else {
    statusStr = g.tip_time
      ? new Date(g.tip_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
      : 'TBD';
  }

  const homeWin = g.status === 'final' && g.home_score > g.away_score;
  const awayWin = g.status === 'final' && g.away_score > g.home_score;

  // Build pool players dropdown (all games)
  let dropdownHTML = '';
  if (isExpanded) {
    const poolPlayers = findPlayersInGame(g);
    if (poolPlayers.length) {
      const rows = poolPlayers.map(p => `
        <div class="game-pool-row">
          <span class="game-pool-name">${esc(p.name)}</span>
          <span class="game-pool-college">${esc(p.ncaa_team)}</span>
          <span class="game-pool-owner">${esc(p.owner)}</span>
          <span class="game-pool-pts">${p.pts !== null ? p.pts : '—'}</span>
        </div>`).join('');
      dropdownHTML = `
        <div class="game-pool-dropdown">
          <div class="game-pool-header">
            <span>Player</span><span>School</span><span>Team</span><span>Pts</span>
          </div>
          ${rows}
        </div>`;
    } else {
      dropdownHTML = `<div class="game-pool-dropdown game-pool-empty">No drafted players in this game</div>`;
    }
  }

  const awaySeedStr = g.away_seed ? `<span class="game-seed">${g.away_seed}</span>` : '';
  const homeSeedStr = g.home_seed ? `<span class="game-seed">${g.home_seed}</span>` : '';
  const tvStr = g.tv_network ? `<span class="game-tv">${esc(g.tv_network)}</span>` : '';

  return `
    <div class="game-card ${g.status}${isExpanded ? ' expanded' : ''}"
         onclick="toggleGameExpand('${g.espn_game_id}', ${isLive})" style="cursor:${isLive ? 'default' : 'pointer'}">
      <div class="game-card-main">
        ${roundLabel ? `<div class="game-round-label">${roundLabel}${tvStr}</div>` : ''}
        <div class="game-matchup">
          <div class="game-team-row ${awayWin ? 'winner' : ''}">
            ${awaySeedStr}<span class="game-team-name">${esc(g.away_team)}</span>
            <span class="game-score">${g.status !== 'pre' ? g.away_score : ''}</span>
          </div>
          <div class="game-team-row ${homeWin ? 'winner' : ''}">
            ${homeSeedStr}<span class="game-team-name">${esc(g.home_team)}</span>
            <span class="game-score">${g.status !== 'pre' ? g.home_score : ''}</span>
          </div>
        </div>
        <div class="game-status-bar ${isLive ? 'live' : ''}">
          ${statusStr}
          ${!isLive ? `<span class="game-expand-hint">${isExpanded ? '▲ hide' : '▼ pool players'}</span>` : ''}
        </div>
      </div>
      ${dropdownHTML}
    </div>
  `;
}

// NCAA basketball: period 1 = 1st Half, period 2 = 2nd Half, 3+ = OT
function liveClockLabel(clock, period) {
  let halfLabel;
  if (!period || period === 1) halfLabel = '1st Half';
  else if (period === 2) halfLabel = '2nd Half';
  else halfLabel = `${period - 2 === 1 ? '' : (period - 2) + ' '}OT`;
  return clock ? `${clock} · ${halfLabel}` : halfLabel;
}

/* ─── Utilities ───────────────────────────────────────────────────────────── */
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Extract YYYY-MM-DD from any date value (string or ISO timestamp)
function normalizeDate(val) {
  if (!val) return 'TBD';
  const s = String(val);
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // ISO timestamp — just take the date portion in UTC to avoid day-shift
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : 'TBD';
}

// Return a Date as YYYY-MM-DD in the browser's local timezone
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Return today's date as YYYY-MM-DD in local time
function todayStr() {
  return localDateStr(new Date());
}

// Human-readable date label with Today/Tomorrow callouts
function formatDateLabel(dateStr) {
  if (!dateStr || dateStr === 'TBD') return 'TBD';
  const today = todayStr();
  const tomorrow = (() => {
    const d = new Date(today + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    return normalizeDate(d.toISOString());
  })();

  if (dateStr === today) return 'Today';
  if (dateStr === tomorrow) return 'Tomorrow';

  // Parse as local noon to avoid any timezone day-shift
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/* ─── Bootstrap ───────────────────────────────────────────────────────────── */
loadAll();
setInterval(loadAll, REFRESH_MS);
