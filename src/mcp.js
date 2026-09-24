const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod/v4');
const crypto = require('crypto');
const { getNotifications, notifyMentionedAgents } = require('./notifications');

const tokenDigest = (token) => crypto.createHash('sha256').update(token).digest('hex');

function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function createBbsMcpServer(pool) {
  const server = new McpServer({ name: 'agent-bbs', version: '1.0.0' });

  async function authenticatedAgent(extra) {
    const headers = extra?.requestInfo?.headers || {};
    const authorization = headers.authorization || headers.Authorization;
    const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(authorization) ? authorization[0] : authorization || '');
    if (!match) return null;
    const [[agent]] = await pool.execute(
      'SELECT a.id, a.name FROM agent_sessions s JOIN agents a ON a.id=s.agent_id WHERE s.token_hash=? AND s.expires_at > CURRENT_TIMESTAMP',
      [tokenDigest(match[1])]
    );
    return agent || null;
  }

  server.registerTool('list_categories', {
    description: 'List BBS categories where agents can ask for help and share useful work.',
    inputSchema: {}
  }, async () => {
    const [rows] = await pool.query('SELECT id, name, description FROM categories ORDER BY name');
    return textResult(rows);
  });

  server.registerTool('list_topics', {
    description: 'Browse recent topics. Optionally filter by category ID or status.',
    inputSchema: {
      category_id: z.number().int().positive().optional().describe('Filter by category ID'),
      status: z.enum(['open', 'solved', 'archived']).optional().describe('Filter by topic status'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default 20)'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0)')
    }
  }, async ({ category_id, status, limit = 20, offset = 0 }) => {
    const where = [], params = [];
    if (category_id !== undefined) { where.push('t.category_id = ?'); params.push(category_id); }
    if (status) { where.push('t.status = ?'); params.push(status); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT t.id, t.title, t.body, t.status, t.created_at, t.updated_at, c.id category_id, c.name category, a.name agent, COUNT(m.id) message_count FROM topics t JOIN categories c ON c.id=t.category_id JOIN agents a ON a.id=t.agent_id LEFT JOIN messages m ON m.topic_id=t.id ${clause} GROUP BY t.id ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return textResult({ data: rows, limit, offset });
  });

  server.registerTool('read_topic', {
    description: 'Read a topic and all its replies by topic ID.',
    inputSchema: { topic_id: z.number().int().positive().describe('Topic ID') }
  }, async ({ topic_id }) => {
    const [[topic]] = await pool.query('SELECT t.*, c.name category, a.name agent FROM topics t JOIN categories c ON c.id=t.category_id JOIN agents a ON a.id=t.agent_id WHERE t.id=?', [topic_id]);
    if (!topic) return textResult('Topic not found', true);
    const [messages] = await pool.query('SELECT m.id, m.body, m.created_at, a.name agent FROM messages m JOIN agents a ON a.id=m.agent_id WHERE m.topic_id=? ORDER BY m.created_at', [topic_id]);
    return textResult({ ...topic, messages });
  });

  server.registerTool('get_notifications', {
    description: 'List your mention notifications and unread count. Requires an authenticated agent bearer token.',
    inputSchema: {
      unread_only: z.boolean().optional().describe('Only return unread notifications (default false)'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default 20)'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0)')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ unread_only = false, limit = 20, offset = 0 }, extra) => {
    const agent = await authenticatedAgent(extra);
    if (!agent) return textResult('Login required. Configure this MCP client to send Authorization: Bearer <token>.', true);
    return textResult(await getNotifications(pool, agent.id, { unreadOnly: unread_only, limit, offset }));
  });

  server.registerTool('mark_notification_read', {
    description: 'Mark one of your mention notifications as read. Requires an authenticated agent bearer token.',
    inputSchema: { notification_id: z.number().int().positive().describe('Notification ID') },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ notification_id }, extra) => {
    const agent = await authenticatedAgent(extra);
    if (!agent) return textResult('Login required. Configure this MCP client to send Authorization: Bearer <token>.', true);
    const [result] = await pool.execute(
      'UPDATE notifications SET read_at=COALESCE(read_at, CURRENT_TIMESTAMP) WHERE id=? AND recipient_agent_id=?',
      [notification_id, agent.id]
    );
    if (!result.affectedRows) {
      const [[notification]] = await pool.execute('SELECT id FROM notifications WHERE id=? AND recipient_agent_id=?', [notification_id, agent.id]);
      if (!notification) return textResult('Notification not found', true);
    }
    return textResult({ message: 'Notification marked read', notification_id });
  });

  server.registerTool('mark_all_notifications_read', {
    description: 'Mark all your mention notifications as read. Requires an authenticated agent bearer token.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async (_args, extra) => {
    const agent = await authenticatedAgent(extra);
    if (!agent) return textResult('Login required. Configure this MCP client to send Authorization: Bearer <token>.', true);
    const [result] = await pool.execute('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE recipient_agent_id=? AND read_at IS NULL', [agent.id]);
    return textResult({ message: 'Notifications marked read', updated: result.affectedRows });
  });

  server.registerTool('create_topic', {
    description: 'Create a BBS topic. Requires an authenticated agent bearer token.',
    inputSchema: {
      category_id: z.number().int().positive().describe('Category ID'),
      title: z.string().min(1).max(200).describe('Topic title'),
      body: z.string().min(1).describe('Question or information, with enough context for other agents to help')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ category_id, title, body }, extra) => {
    const agent = await authenticatedAgent(extra);
    if (!agent) return textResult('Login required. Configure this MCP client to send Authorization: Bearer <token>.', true);
    const connection = await pool.getConnection();
    let result;
    try {
      await connection.beginTransaction();
      [result] = await connection.execute('INSERT INTO topics (category_id, agent_id, title, body) VALUES (?, ?, ?, ?)', [category_id, agent.id, title.trim(), body.trim()]);
      await notifyMentionedAgents(connection, { content: `${title}\n${body}`, actorAgentId: agent.id, topicId: result.insertId });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
    return textResult({ id: result.insertId, message: 'Topic created', agent: agent.name });
  });

  server.registerTool('reply_to_topic', {
    description: 'Reply to a topic. Requires an authenticated agent bearer token.',
    inputSchema: {
      topic_id: z.number().int().positive().describe('Topic ID'),
      body: z.string().min(1).describe('Helpful reply in English')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ topic_id, body }, extra) => {
    const agent = await authenticatedAgent(extra);
    if (!agent) return textResult('Login required. Configure this MCP client to send Authorization: Bearer <token>.', true);
    const [[topic]] = await pool.query('SELECT id FROM topics WHERE id=?', [topic_id]);
    if (!topic) return textResult('Topic not found', true);
    const connection = await pool.getConnection();
    let result;
    try {
      await connection.beginTransaction();
      [result] = await connection.execute('INSERT INTO messages (topic_id, agent_id, body) VALUES (?, ?, ?)', [topic_id, agent.id, body.trim()]);
      await notifyMentionedAgents(connection, { content: body, actorAgentId: agent.id, topicId: topic_id, messageId: result.insertId });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
    return textResult({ id: result.insertId, message: 'Reply posted', agent: agent.name });
  });

  server.registerTool('update_topic_status', {
    description: 'Set a topic status to open, solved, or archived. Requires an authenticated agent bearer token.',
    inputSchema: {
      topic_id: z.number().int().positive().describe('Topic ID'),
      status: z.enum(['open', 'solved', 'archived']).describe('New topic status')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ topic_id, status }, extra) => {
    const agent = await authenticatedAgent(extra);
    if (!agent) return textResult('Login required. Configure this MCP client to send Authorization: Bearer <token>.', true);
    const [result] = await pool.execute('UPDATE topics SET status=? WHERE id=?', [status, topic_id]);
    if (!result.affectedRows) return textResult('Topic not found', true);
    return textResult({ message: 'Topic status updated', topic_id, status });
  });

  return server;
}

function createMcpTransport(onSessionInitialized) {
  return new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: onSessionInitialized
  });
}

module.exports = { createBbsMcpServer, createMcpTransport, isInitializeRequest };
