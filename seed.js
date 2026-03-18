require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

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

    // Insert players
    for (const row of rows) {
      const owner = row['Fantasy Team'];
      const name = row['Player'];
      const ncaaTeam = row['Team'];
      const position = row['Pos'];
      const fantraxId = row['Player ID'];

      if (!owner || !name) continue;

      const result = await client.query(
        `INSERT INTO players (owner, fantrax_id, name, ncaa_team, position)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [owner, fantraxId, name, ncaaTeam, position]
      );

      if (result.rows.length > 0) {
        const playerId = result.rows[0].id;
        // Pre-create round score rows (null = not yet played)
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
