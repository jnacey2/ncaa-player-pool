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

module.exports = { resolveTeamMappings, getTeamMappings };
