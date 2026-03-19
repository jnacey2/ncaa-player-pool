require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('./db');

// Ask Claude to match our CSV team abbreviations to ESPN team names.
// Only called when new unmatched teams are detected — not every scrape.
async function resolveTeamMappings() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[mapping] No ANTHROPIC_API_KEY — skipping team mapping');
    return;
  }

  // All ESPN teams seen so far in the bracket
  const { rows: espnTeams } = await pool.query(
    `SELECT DISTINCT team_abbrev, team_name
     FROM bracket_slots
     WHERE team_name IS NOT NULL
     ORDER BY team_name`
  );

  if (espnTeams.length === 0) {
    console.log('[mapping] No ESPN teams in bracket_slots yet — skipping');
    return;
  }

  // All unique CSV abbreviations from our pool
  const { rows: csvTeams } = await pool.query(
    `SELECT DISTINCT ncaa_team FROM players ORDER BY ncaa_team`
  );

  // Find CSV teams that don't yet have an ESPN mapping
  const { rows: existing } = await pool.query(
    `SELECT csv_abbrev FROM team_mappings WHERE espn_name IS NOT NULL`
  );
  const alreadyMapped = new Set(existing.map(r => r.csv_abbrev));
  const toMap = csvTeams.filter(t => !alreadyMapped.has(t.ncaa_team));

  if (toMap.length === 0) {
    console.log('[mapping] All teams already mapped');
    return;
  }

  console.log(`[mapping] Asking Claude to map ${toMap.length} teams...`);

  const csvList = toMap.map(t => t.ncaa_team).join(', ');
  const espnList = espnTeams.map(t => `${t.team_abbrev}: ${t.team_name}`).join('\n');

  const prompt = `You are mapping college basketball team identifiers between two systems for an NCAA tournament fantasy pool app.

FANTRAX abbreviations that need mapping (${toMap.length} teams):
${csvList}

ESPN teams currently in the bracket (abbreviation: full display name):
${espnList}

For each Fantrax abbreviation, find the matching ESPN entry. Common mismatches to watch for:
- "Mia-FL" = Miami Hurricanes (NOT Miami Ohio)
- "Mich" = Michigan Wolverines (NOT Michigan State)
- "MSU" = Michigan State Spartans
- "Iowa" = Iowa Hawkeyes (NOT Iowa State)
- "IaSt" = Iowa State Cyclones
- "Tex" = Texas Longhorns (NOT Texas Tech)
- "TxTch" = Texas Tech Red Raiders
- "KY" = Kentucky Wildcats (NOT Kansas)
- "Kan" = Kansas Jayhawks
- "UNC" = North Carolina Tar Heels (NOT NC State)
- "UVA" = Virginia Cavaliers (NOT Virginia Tech)
- "OhSt" = Ohio State Buckeyes (NOT Ohio)
- "Leh" = Lehigh Mountain Hawks

If a Fantrax team has no ESPN entry yet (they may not have played), still include them with your best guess based on the abbreviation. Set espn_abbrev to null only if completely uncertain.

Return ONLY valid JSON with no markdown fences:
{
  "CSV_ABBREV": {"espn_abbrev": "ESPN_ABBREV", "espn_name": "Full ESPN Display Name"},
  ...
}`;

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0]?.text || '';
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    const mapping = JSON.parse(cleaned);

    let saved = 0;
    for (const [csvAbbrev, espnData] of Object.entries(mapping)) {
      await pool.query(
        `INSERT INTO team_mappings (csv_abbrev, espn_abbrev, espn_name, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (csv_abbrev) DO UPDATE SET
           espn_abbrev = EXCLUDED.espn_abbrev,
           espn_name = EXCLUDED.espn_name,
           updated_at = NOW()`,
        [csvAbbrev, espnData.espn_abbrev || null, espnData.espn_name || null]
      );
      saved++;
    }

    console.log(`[mapping] Saved ${saved} team mappings`);
  } catch (err) {
    console.error('[mapping] Error resolving mappings:', err.message);
  }
}

// Return the full mapping as { csvAbbrev → { espn_abbrev, espn_name } }
async function getTeamMappings() {
  const { rows } = await pool.query(
    `SELECT csv_abbrev, espn_abbrev, espn_name FROM team_mappings`
  );
  const map = {};
  for (const row of rows) {
    map[row.csv_abbrev] = { espn_abbrev: row.espn_abbrev, espn_name: row.espn_name };
  }
  return map;
}

// Ask Claude to review player names and flag ESPN display name differences.
// Looks for Jr./Sr./III suffixes, hyphenation, accents, shortened first names, etc.
// Only runs once (skips players that already have espn_name set).
async function resolvePlayerNames() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  // Get players that don't yet have an espn_name override
  const { rows: players } = await pool.query(
    `SELECT id, name, ncaa_team FROM players WHERE espn_name IS NULL ORDER BY name`
  );

  if (players.length === 0) {
    console.log('[mapping] All player names already resolved');
    return;
  }

  console.log(`[mapping] Asking Claude to review ${players.length} player names for ESPN mismatches...`);

  const playerList = players.map(p => `${p.name} (${p.ncaa_team})`).join('\n');

  const prompt = `You are reviewing college basketball player names for an NCAA tournament fantasy app. Our player list comes from Fantrax, but ESPN box scores may display names differently.

Review this list of players and identify any whose ESPN display name likely differs from how they appear here. Common differences:
- Missing generational suffixes: "Jaron Pierre" → "Jaron Pierre Jr."
- Missing or different suffixes: Sr., II, III, IV
- Shortened first names: "AJ" vs "A.J." vs "Andrew James"
- Hyphenation differences: "Trey Kaufman Renn" vs "Trey Kaufman-Renn"
- Accented characters: ESPN sometimes drops or adds accents
- Nicknames vs full names

Players to review:
${playerList}

Return ONLY valid JSON with no markdown. Include ONLY players where you are confident the ESPN name differs. If you're unsure, do NOT include the player.
{
  "Fantrax Name": "ESPN Display Name",
  ...
}`;

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0]?.text || '';
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    const corrections = JSON.parse(cleaned);

    let updated = 0;
    for (const [fantraxName, espnName] of Object.entries(corrections)) {
      // Find the player by exact name match
      const result = await pool.query(
        `UPDATE players SET espn_name = $1 WHERE LOWER(name) = LOWER($2) RETURNING id, name`,
        [espnName, fantraxName]
      );
      if (result.rows.length > 0) {
        console.log(`[mapping] Player name fix: "${fantraxName}" → "${espnName}"`);
        updated++;
      }
    }

    // Mark the rest as reviewed (set espn_name = name so we don't re-run them)
    await pool.query(
      `UPDATE players SET espn_name = name WHERE espn_name IS NULL`
    );

    console.log(`[mapping] ${updated} player name corrections applied`);
  } catch (err) {
    console.error('[mapping] Error resolving player names:', err.message);
  }
}

module.exports = { resolveTeamMappings, getTeamMappings, resolvePlayerNames };
