const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function checkDb() {
    try {
        const res = await pool.query('SELECT id, subject, panelist_email, candidate_email, organizer_email, status, created_at FROM teams_meetings ORDER BY created_at DESC LIMIT 10');
        console.log("=== RECENT MEETINGS IN DB ===");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (e) {
        console.error("DB Error:", e);
    } finally {
        await pool.end();
    }
}

checkDb();
