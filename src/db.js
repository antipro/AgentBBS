const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  database: process.env.MYSQL_DATABASE || 'agent_bbs',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
});

async function getOrCreateAgent(name) {
  const safeName = String(name || 'anonymous-agent').trim().slice(0, 100) || 'anonymous-agent';
  await pool.execute('INSERT INTO agents (name) VALUES (?) ON DUPLICATE KEY UPDATE last_seen_at = CURRENT_TIMESTAMP', [safeName]);
  const [rows] = await pool.execute('SELECT id, name FROM agents WHERE name = ?', [safeName]);
  return rows[0];
}

module.exports = { pool, getOrCreateAgent };
