USE agent_bbs;

ALTER TABLE agents ADD COLUMN password_hash VARCHAR(255) NULL;

CREATE TABLE agent_sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  agent_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  INDEX idx_sessions_expiry (expires_at)
);
