/* ─── Constants ───────────────────────────────────────────────────────────── */
const ROUND_LABELS = ['Play-In', 'R1', 'R2', 'S16', 'E8', 'F4', 'Champ'];
const ROUND_FULL = ['First Four', 'First Round', 'Second Round', 'Sweet 16', 'Elite Eight', 'Final Four', 'Championship'];
const REFRESH_MS = 30_000;

/* ─── State ───────────────────────────────────────────────────────────────── */
let state = {
  standings: [],
  games: [],
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
    const [standings, games, lastUpdated] = await Promise.all([
      fetchJSON('/api/standings'),
      fetchJSON('/api/games'),
      fetchJSON('/api/last-updated'),
    ]);
    state.standings = standings;
    state.games = games;
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

/* ─── Leaderboard Strip ───────────────────────────────────────────────────── */
function renderLeaderboard() {
  const container = document.getElementById('leaderboard-strip');
  if (!state.standings.length) { container.innerHTML = '<div class="loading-msg">No data yet</div>'; return; }

  container.innerHTML = state.standings.map((team, idx) => {
    const rank = idx + 1;
    const rankClass = rank <= 3 ? `rank-${rank}` : '';
    const name = esc(team.display_name || team.owner);
    return `
      <div class="lb-card" onclick="scrollToCard('${esc(team.owner)}')" title="Jump to ${name}'s card">
        <div class="lb-rank ${rankClass}">#${rank}</div>
        <div class="lb-info">
          <div class="lb-owner">${name}</div>
          <div class="lb-stats">
            <span class="lb-pts">${team.total_pts} pts</span>
            &nbsp;·&nbsp;
            <span>${team.players_remaining}/10 alive</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
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
  return `
    <div class="team-card" id="card-${esc(team.owner)}">
      <div class="team-card-header">
        <div class="team-card-owner">
          <div class="rank-badge ${rankClass}">${rank}</div>
          <span class="team-owner-name">${displayName}</span>
        </div>
        <div class="team-card-totals">
          <span class="card-total-pts">${total}</span>
          <span class="card-alive"><span class="alive-count">${alive}</span>/10 alive</span>
        </div>
      </div>
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

/* ─── Games Sidebar ───────────────────────────────────────────────────────── */
function renderGames() {
  const container = document.getElementById('games-list');
  if (!state.games.length) {
    container.innerHTML = '<div class="loading-msg">No tournament games found yet.<br>Check back once the bracket is set.</div>';
    return;
  }

  // Split live vs non-live
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
  const roundLabel = g.round_num ? ROUND_FULL[g.round_num - 1] || `Round ${g.round_num}` : '';

  let statusStr = '';
  if (g.status === 'live') {
    statusStr = liveClockLabel(g.display_clock, g.period);
  } else if (g.status === 'final') {
    statusStr = 'Final';
  } else {
    // Upcoming — show local tip time
    if (g.tip_time) {
      const d = new Date(g.tip_time);
      statusStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    } else {
      statusStr = 'TBD';
    }
  }

  const homeWin = g.status === 'final' && g.home_score > g.away_score;
  const awayWin = g.status === 'final' && g.away_score > g.home_score;

  return `
    <div class="game-card ${g.status}">
      ${roundLabel ? `<div class="game-round-label">${roundLabel}</div>` : ''}
      <div class="game-matchup">
        <div class="game-team-row ${awayWin ? 'winner' : ''}">
          <span class="game-team-name">${esc(g.away_team)}</span>
          <span class="game-score">${g.status !== 'pre' ? g.away_score : ''}</span>
        </div>
        <div class="game-team-row ${homeWin ? 'winner' : ''}">
          <span class="game-team-name">${esc(g.home_team)}</span>
          <span class="game-score">${g.status !== 'pre' ? g.home_score : ''}</span>
        </div>
      </div>
      <div class="game-status-bar ${g.status === 'live' ? 'live' : ''}">${statusStr}</div>
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
