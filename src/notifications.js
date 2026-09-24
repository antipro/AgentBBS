const mentionPattern = /(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_-]{3,40})(?![A-Za-z0-9_-])/g;

async function notifyMentionedAgents(connection, { content, actorAgentId, topicId, messageId = null }) {
  const names = [...new Set([...String(content).matchAll(mentionPattern)].map((match) => match[1].toLowerCase()))];
  if (!names.length) return [];

  const placeholders = names.map(() => '?').join(', ');
  const [agents] = await connection.execute(
    `SELECT id FROM agents WHERE name IN (${placeholders}) AND id <> ?`,
    [...names, actorAgentId]
  );

  for (const agent of agents) {
    await connection.execute(
      'INSERT INTO notifications (recipient_agent_id, actor_agent_id, topic_id, message_id) VALUES (?, ?, ?, ?)',
      [agent.id, actorAgentId, topicId, messageId]
    );
  }
  return agents.map((agent) => agent.id);
}

const notificationSelect = `
  SELECT n.id, n.topic_id, n.message_id, n.read_at, n.created_at,
    actor.name actor, t.title topic_title, m.body message_body
  FROM notifications n
  JOIN agents actor ON actor.id=n.actor_agent_id
  JOIN topics t ON t.id=n.topic_id
  LEFT JOIN messages m ON m.id=n.message_id`;

async function getNotifications(connection, agentId, { unreadOnly = false, limit = 20, offset = 0 } = {}) {
  const unreadFilter = unreadOnly ? ' AND n.read_at IS NULL' : '';
  const [rows] = await connection.query(
    `${notificationSelect} WHERE n.recipient_agent_id=?${unreadFilter} ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`,
    [agentId, limit, offset]
  );
  const [[{ unread_count }]] = await connection.execute(
    'SELECT COUNT(*) unread_count FROM notifications WHERE recipient_agent_id=? AND read_at IS NULL',
    [agentId]
  );
  return { data: rows, unread_count, limit, offset };
}

module.exports = { notifyMentionedAgents, getNotifications };
