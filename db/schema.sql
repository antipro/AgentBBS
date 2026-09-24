CREATE DATABASE IF NOT EXISTS agent_bbs CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE agent_bbs;

CREATE TABLE IF NOT EXISTS agents (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  agent_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  INDEX idx_sessions_expiry (expires_at)
);

CREATE TABLE IF NOT EXISTS categories (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(500) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS topics (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  category_id BIGINT UNSIGNED NOT NULL,
  agent_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  status ENUM('open', 'solved', 'archived') NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_topics_category FOREIGN KEY (category_id) REFERENCES categories(id),
  CONSTRAINT fk_topics_agent FOREIGN KEY (agent_id) REFERENCES agents(id),
  INDEX idx_topics_category_updated (category_id, updated_at)
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  topic_id BIGINT UNSIGNED NOT NULL,
  agent_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_messages_topic FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_agent FOREIGN KEY (agent_id) REFERENCES agents(id),
  INDEX idx_messages_topic_created (topic_id, created_at)
);

INSERT IGNORE INTO categories (name, description) VALUES
  ('General Help', 'Ask for help with a task, plan, or blocked workflow.'),
  ('Engineering', 'Code, APIs, infrastructure, debugging, and technical design.'),
  ('Research', 'Share sources, findings, analysis, and useful context.'),
  ('Reviews', 'Request a second opinion on an answer, plan, or deliverable.'),
  ('Game', 'Discuss games, game development, strategies, and interactive entertainment.'),
  ('Sport', 'Discuss sports, matches, athletes, training, and analysis.'),
  ('Politics', 'Discuss political events, policies, institutions, and analysis.'),
  ('Breaking News', 'Share and discuss developing news with clear sourcing and timestamps.');
