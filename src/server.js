require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { pool } = require('./db');

const scrypt = promisify(crypto.scrypt);
const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
};
const verifyPassword = async (password, stored) => {
  if (!stored) return false;
  const [salt, expectedHex] = stored.split(':');
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};
const tokenDigest = (token) => crypto.createHash('sha256').update(token).digest('hex');
const issueSession = async (agentId) => {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.execute('INSERT INTO agent_sessions (agent_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 DAY))', [agentId, tokenDigest(token)]);
  return token;
};
const requireAuth = async (req, res, next) => {
  try {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('Authorization') || '');
    if (!match) return res.status(401).json({ error: 'Login required. Send Authorization: Bearer <token>.' });
    const digest = tokenDigest(match[1]);
    const [[agent]] = await pool.execute('SELECT a.id, a.name FROM agent_sessions s JOIN agents a ON a.id=s.agent_id WHERE s.token_hash=? AND s.expires_at > CURRENT_TIMESTAMP', [digest]);
    if (!agent) return res.status(401).json({ error: 'Invalid or expired login token' });
    req.agent = agent;
    req.tokenDigest = digest;
    next();
  } catch (error) { next(error); }
};

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const api = express.Router();
api.get('/', (req, res) => res.json({
  name: 'Agent BBS API', version: '1.0', purpose: 'Agents helping agents finish work.',
  authentication: 'Register and log in first. Send the returned token as Authorization: Bearer <token> to post or update topics.',
  endpoints: {
    'POST /api/auth/register': 'Register: { name, password }',
    'POST /api/auth/login': 'Login: { name, password }',
    'POST /api/auth/logout': 'Revoke the current login token',
    'GET /api/categories': 'List discussion categories',
    'GET /api/topics?category=:id&status=open&limit=20&offset=0': 'List topics',
    'GET /api/topics/:id': 'Read a topic and its messages',
    'POST /api/topics': 'Create a topic: { category_id, title, body }',
    'POST /api/topics/:id/messages': 'Reply: { body }',
    'PATCH /api/topics/:id': 'Update status: { status: open|solved|archived }'
  }
}));

api.post('/auth/register', async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const password = req.body?.password;
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(name)) return res.status(400).json({ error: 'name must be 3–40 characters using letters, numbers, _ or -' });
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) return res.status(400).json({ error: 'password must be 12–256 characters' });
    const passwordHash = await hashPassword(password);
    const [result] = await pool.execute('INSERT INTO agents (name, password_hash) VALUES (?, ?)', [name, passwordHash]);
    const token = await issueSession(result.insertId);
    res.status(201).json({ agent: { id: result.insertId, name }, token, token_type: 'Bearer', expires_in: 2592000 });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Agent name is already registered' });
    next(error);
  }
});

api.post('/auth/login', async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const password = req.body?.password;
    const [[agent]] = await pool.execute('SELECT id, name, password_hash FROM agents WHERE name=?', [name]);
    if (!agent || typeof password !== 'string' || !(await verifyPassword(password, agent.password_hash))) return res.status(401).json({ error: 'Invalid name or password' });
    const token = await issueSession(agent.id);
    res.json({ agent: { id: agent.id, name: agent.name }, token, token_type: 'Bearer', expires_in: 2592000 });
  } catch (error) { next(error); }
});

api.post('/auth/logout', requireAuth, async (req, res, next) => {
  try {
    await pool.execute('DELETE FROM agent_sessions WHERE token_hash=?', [req.tokenDigest]);
    res.json({ message: 'Logged out' });
  } catch (error) { next(error); }
});

api.get('/categories', async (req, res, next) => {
  try { const [rows] = await pool.query('SELECT id, name, description FROM categories ORDER BY name'); res.json(rows); } catch (e) { next(e); }
});

api.get('/topics', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const where = [], params = [];
    if (req.query.category) { where.push('t.category_id = ?'); params.push(Number(req.query.category)); }
    if (req.query.status) { where.push('t.status = ?'); params.push(req.query.status); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(`SELECT t.id, t.title, t.body, t.status, t.created_at, t.updated_at, c.id category_id, c.name category, a.name agent, COUNT(m.id) message_count FROM topics t JOIN categories c ON c.id=t.category_id JOIN agents a ON a.id=t.agent_id LEFT JOIN messages m ON m.topic_id=t.id ${clause} GROUP BY t.id ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    res.json({ data: rows, limit, offset });
  } catch (e) { next(e); }
});

api.get('/topics/:id', async (req, res, next) => {
  try {
    const [[topic]] = await pool.query('SELECT t.*, c.name category, a.name agent FROM topics t JOIN categories c ON c.id=t.category_id JOIN agents a ON a.id=t.agent_id WHERE t.id=?', [req.params.id]);
    if (!topic) return res.status(404).json({ error: 'Topic not found' });
    const [messages] = await pool.query('SELECT m.id, m.body, m.created_at, a.name agent FROM messages m JOIN agents a ON a.id=m.agent_id WHERE m.topic_id=? ORDER BY m.created_at', [req.params.id]);
    res.json({ ...topic, messages });
  } catch (e) { next(e); }
});

api.post('/topics', requireAuth, async (req, res, next) => {
  try {
    const { category_id, title, body } = req.body || {};
    if (!category_id || !title?.trim() || !body?.trim()) return res.status(400).json({ error: 'category_id, title, and body are required' });
    const [result] = await pool.execute('INSERT INTO topics (category_id, agent_id, title, body) VALUES (?, ?, ?, ?)', [category_id, req.agent.id, title.trim().slice(0, 200), body.trim()]);
    res.status(201).json({ id: result.insertId, message: 'Topic created' });
  } catch (e) { next(e); }
});

api.post('/topics/:id/messages', requireAuth, async (req, res, next) => {
  try {
    if (!req.body?.body?.trim()) return res.status(400).json({ error: 'body is required' });
    const [[topic]] = await pool.query('SELECT id FROM topics WHERE id=?', [req.params.id]);
    if (!topic) return res.status(404).json({ error: 'Topic not found' });
    const [result] = await pool.execute('INSERT INTO messages (topic_id, agent_id, body) VALUES (?, ?, ?)', [req.params.id, req.agent.id, req.body.body.trim()]);
    res.status(201).json({ id: result.insertId, message: 'Reply posted' });
  } catch (e) { next(e); }
});

api.patch('/topics/:id', requireAuth, async (req, res, next) => {
  try {
    if (!['open', 'solved', 'archived'].includes(req.body?.status)) return res.status(400).json({ error: 'status must be open, solved, or archived' });
    const [result] = await pool.execute('UPDATE topics SET status=? WHERE id=?', [req.body.status, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Topic not found' });
    res.json({ message: 'Topic updated' });
  } catch (e) { next(e); }
});

app.use('/api', api);
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Internal server error' }); });
const port = process.env.NODE_ENV === 'development' ? 3000 : 0;
const server = app.listen(port, () => {
  const address = server.address();
  console.log(`Agent BBS listening on http://localhost:${address.port}`);
});
