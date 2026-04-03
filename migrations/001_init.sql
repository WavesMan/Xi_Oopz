CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  handle VARCHAR(64) NOT NULL UNIQUE,
  display_name VARCHAR(64) NOT NULL,
  avatar_color VARCHAR(16) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS domains (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  slug VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(255) NOT NULL,
  accent_color VARCHAR(16) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_categories (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  domain_id BIGINT NOT NULL,
  name VARCHAR(80) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_channel_categories_domain
    FOREIGN KEY (domain_id) REFERENCES domains(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channels (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  domain_id BIGINT NOT NULL,
  category_id BIGINT NULL,
  name VARCHAR(80) NOT NULL,
  channel_type ENUM('text', 'voice') NOT NULL,
  topic VARCHAR(255) NOT NULL DEFAULT '',
  position INT NOT NULL DEFAULT 0,
  max_members INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_channels_domain
    FOREIGN KEY (domain_id) REFERENCES domains(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_channels_category
    FOREIGN KEY (category_id) REFERENCES channel_categories(id)
    ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS domain_members (
  domain_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  role ENUM('owner', 'member') NOT NULL DEFAULT 'member',
  joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (domain_id, user_id),
  CONSTRAINT fk_domain_members_domain
    FOREIGN KEY (domain_id) REFERENCES domains(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_domain_members_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  domain_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  user_id BIGINT NULL,
  message_type ENUM('chat', 'system') NOT NULL DEFAULT 'chat',
  body TEXT NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_messages_channel_created_at (channel_id, created_at),
  CONSTRAINT fk_messages_domain
    FOREIGN KEY (domain_id) REFERENCES domains(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_messages_channel
    FOREIGN KEY (channel_id) REFERENCES channels(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_messages_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE SET NULL
);
