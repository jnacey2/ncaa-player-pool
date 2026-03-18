require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

// Map Fantrax usernames → friendly display names
const DISPLAY_NAMES = {
  'AJA2026':    'Alpert',
  'benkunk':    'Kunkel',
  'Bradfrey':   'Frey',
  'DamatoN':    "D'Amato",
  'DAvart':     'Avart',
  'Dgross21':   'Gross',
  'Dignazio':   'Dignazio',
  'Haron':      'Haron',
  'jmiano':     'Miano',
  'Jnacey2':    'Nacey',
  'Mcriqui':    'Criqui',
  'michaelfer': 'Ferry',
  'sniels100':  'Nielson',
};

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());

  return lines.slice(1).map(line => {
    // Handle quoted fields
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    fields.push(current.trim());

    const obj = {};
    headers.forEach((h, i) => { obj[h] = fields[i] || ''; });
    return obj;
  });
}

async function seed() {
  const csvPath = path.join(__dirname, 'data', 'draft-results.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('CSV not found at', csvPath);
    process.exit(1);
  }

  const rows = parseCSV(csvPath);

  // Collect unique owners
  const owners = [...new Set(rows.map(r => r['Fantasy Team']))].filter(Boolean);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert fantasy teams
    for (const owner of owners) {
      await client.query(
        `INSERT INTO fantasy_teams (owner) VALUES ($1) ON CONFLICT (owner) DO NOTHING`,
        [owner]
      );
    }

    // Insert players (new rows) and always update draft_pick on existing rows
    for (const row of rows) {
      const owner = row['Fantasy Team'];
      const name = row['Player'];
      const ncaaTeam = row['Team'];
      const position = row['Pos'];
      const fantraxId = row['Player ID'];
      const draftPick = parseInt(row['Ov Pick'], 10) || null;

      if (!owner || !name) continue;

      // Upsert by (fantrax_id, owner) — same player can be on multiple teams
      const result = await client.query(
        `INSERT INTO players (owner, fantrax_id, name, ncaa_team, position, draft_pick)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (fantrax_id, owner) DO UPDATE SET
           draft_pick = EXCLUDED.draft_pick,
           name = EXCLUDED.name,
           ncaa_team = EXCLUDED.ncaa_team,
           position = EXCLUDED.position
         RETURNING id`,
        [owner, fantraxId, name, ncaaTeam, position, draftPick]
      );

      if (result.rows.length > 0) {
        const playerId = result.rows[0].id;
        // Pre-create round score rows if they don't exist yet
        for (let r = 1; r <= 6; r++) {
          await client.query(
            `INSERT INTO player_round_scores (player_id, round_num, pts, blacked_out)
             VALUES ($1, $2, NULL, FALSE)
             ON CONFLICT (player_id, round_num) DO NOTHING`,
            [playerId, r]
          );
        }
      }
    }

    // Remove any players who were dropped from a team in the CSV.
    // Build the authoritative (fantrax_id, owner) set from the CSV and
    // delete any DB rows not in that set.
    const csvPairs = rows
      .filter(r => r['Player ID'] && r['Fantasy Team'])
      .map(r => [r['Player ID'], r['Fantasy Team']]);

    for (const [fid, owner] of csvPairs) {
      // Already handled by upsert above; this loop is just for building the set
      void fid, owner;
    }

    // Delete stale players: any (fantrax_id, owner) pair not present in CSV
    // Use a temporary approach — delete by known replaced players explicitly
    const REMOVED_PLAYERS = [
      { fantrax_id: '*06g3w*', owner: 'Dgross21' },  // JT Toppin → replaced by Graham Ike
      { fantrax_id: '*06g9w*', owner: 'Dignazio' },   // Aden Holloway → replaced by Kur Teng
      { fantrax_id: '*065bf*', owner: 'Bradfrey' },   // Richie Saunders → replaced by Tramon Mark
      { fantrax_id: '*065bi*', owner: 'AJA2026' },    // Braden Huff → replaced by McGlockton
    ];
    for (const { fantrax_id, owner } of REMOVED_PLAYERS) {
      await client.query(
        `DELETE FROM players WHERE fantrax_id = $1 AND owner = $2`,
        [fantrax_id, owner]
      );
    }

    // Apply display names
    for (const [username, displayName] of Object.entries(DISPLAY_NAMES)) {
      await client.query(
        `UPDATE fantasy_teams SET display_name = $1 WHERE owner = $2`,
        [displayName, username]
      );
    }

    await client.query('COMMIT');
    console.log(`Seeded ${owners.length} fantasy teams and ${rows.length} players.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { seed };

if (require.main === module) {
  seed().then(() => process.exit(0)).catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
