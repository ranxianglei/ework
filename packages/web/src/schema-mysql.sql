-- ework schema (MySQL 8.0+ / MariaDB 10.5+). Applied idempotently on boot:
-- CREATE TABLE IF NOT EXISTS + CREATE INDEX (no IF NOT EXISTS — MySQL lacks it;
-- re-runs tolerate ER_DUP_KEYNAME 1061). FK constraint names are {{tokenized}}
-- so prefixed instances don't collide on constraint-name uniqueness. Date
-- columns are VARCHAR(40) holding ISO-8601 strings — the app formats dates in
-- JS, never SQL date arithmetic, so strings avoid Date-vs-string friction
-- across drivers. FK columns carry their own indexes (MySQL requirement). All
-- tables InnoDB + utf8mb4 for FK CASCADE + full Unicode (emoji).

CREATE TABLE IF NOT EXISTS {{users}} (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  login         VARCHAR(255) NOT NULL UNIQUE,
  kind          VARCHAR(16) NOT NULL DEFAULT 'human'
                CHECK (kind IN ('human','bot','system')),
  display_name  VARCHAR(255) DEFAULT NULL,
  password_hash VARCHAR(255) DEFAULT NULL,
  email         VARCHAR(255) DEFAULT NULL,
  is_admin      TINYINT NOT NULL DEFAULT 0,
  is_active     TINYINT NOT NULL DEFAULT 1,
  created_at    VARCHAR(40) NOT NULL,
  updated_at    VARCHAR(40) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS {{projects}} (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  owner         VARCHAR(255) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  description   VARCHAR(2048) NOT NULL DEFAULT '',
  upstream_urls VARCHAR(4096) NOT NULL DEFAULT '[]',
  model         VARCHAR(128) NOT NULL DEFAULT '',
  created_at    VARCHAR(40) NOT NULL,
  updated_at    VARCHAR(40) NOT NULL,
  UNIQUE (owner, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS {{model_cache}} (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  provider_model VARCHAR(128) NOT NULL UNIQUE,
  label          VARCHAR(255) NOT NULL,
  refreshed_at   VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS {{issues}} (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  number     INT NOT NULL,
  title      VARCHAR(512) NOT NULL,
  body       TEXT NOT NULL,
  state      VARCHAR(16) NOT NULL DEFAULT 'open'
             CHECK (state IN ('open','closed')),
  author     VARCHAR(255) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  closed_at  VARCHAR(40) DEFAULT NULL,
  UNIQUE (project_id, number),
  CONSTRAINT {{fk_issues_project}} FOREIGN KEY (project_id) REFERENCES {{projects}}(id) ON DELETE CASCADE,
  CONSTRAINT {{fk_issues_author}} FOREIGN KEY (author)     REFERENCES {{users}}(login)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX issues_project_state_updated
  ON {{issues}} (project_id, state, updated_at DESC);
CREATE INDEX issues_state_updated
  ON {{issues}} (state, updated_at DESC);
CREATE INDEX issues_author ON {{issues}} (author);

CREATE TABLE IF NOT EXISTS {{comments}} (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  issue_id   BIGINT NOT NULL,
  author     VARCHAR(255) NOT NULL,
  body       TEXT NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL DEFAULT '',
  CONSTRAINT {{fk_comments_issue}} FOREIGN KEY (issue_id) REFERENCES {{issues}}(id) ON DELETE CASCADE,
  CONSTRAINT {{fk_comments_author}} FOREIGN KEY (author)  REFERENCES {{users}}(login)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX comments_issue_created ON {{comments}} (issue_id, created_at);
CREATE INDEX comments_author ON {{comments}} (author);

CREATE TABLE IF NOT EXISTS {{labels}} (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id  BIGINT NOT NULL,
  name        VARCHAR(255) NOT NULL,
  color       VARCHAR(16) NOT NULL DEFAULT '#888888',
  description VARCHAR(255) NOT NULL DEFAULT '',
  exclusive   TINYINT NOT NULL DEFAULT 0,
  is_archived TINYINT NOT NULL DEFAULT 0,
  UNIQUE (project_id, name),
  CONSTRAINT {{fk_labels_project}} FOREIGN KEY (project_id) REFERENCES {{projects}}(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS {{issue_labels}} (
  id        BIGINT AUTO_INCREMENT PRIMARY KEY,
  issue_id  BIGINT NOT NULL,
  label_id  BIGINT NOT NULL,
  UNIQUE (issue_id, label_id),
  CONSTRAINT {{fk_il_issue}} FOREIGN KEY (issue_id) REFERENCES {{issues}}(id) ON DELETE CASCADE,
  CONSTRAINT {{fk_il_label}} FOREIGN KEY (label_id) REFERENCES {{labels}}(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX issue_labels_label ON {{issue_labels}} (label_id);

CREATE TABLE IF NOT EXISTS {{reactions}} (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  comment_id  BIGINT NOT NULL,
  user_login  VARCHAR(255) NOT NULL,
  content     VARCHAR(64) NOT NULL,
  UNIQUE (comment_id, user_login, content),
  CONSTRAINT {{fk_reactions_comment}} FOREIGN KEY (comment_id)  REFERENCES {{comments}}(id) ON DELETE CASCADE,
  CONSTRAINT {{fk_reactions_user}} FOREIGN KEY (user_login)  REFERENCES {{users}}(login)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX reactions_comment ON {{reactions}} (comment_id);
CREATE INDEX reactions_user   ON {{reactions}} (user_login);

CREATE TABLE IF NOT EXISTS {{attachments}} (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  uuid          VARCHAR(64) NOT NULL UNIQUE,
  issue_id      BIGINT NOT NULL,
  filename      VARCHAR(255) NOT NULL,
  content_type  VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
  size          BIGINT NOT NULL,
  blob_path     VARCHAR(1024) NOT NULL,
  uploaded_by   VARCHAR(255) NOT NULL,
  created_at    VARCHAR(40) NOT NULL,
  CONSTRAINT {{fk_attachments_issue}} FOREIGN KEY (issue_id)    REFERENCES {{issues}}(id) ON DELETE CASCADE,
  CONSTRAINT {{fk_attachments_user}} FOREIGN KEY (uploaded_by) REFERENCES {{users}}(login)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX attachments_issue ON {{attachments}} (issue_id);
CREATE INDEX attachments_user  ON {{attachments}} (uploaded_by);

CREATE TABLE IF NOT EXISTS {{webhooks}} (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id   BIGINT NOT NULL,
  url          VARCHAR(1024) NOT NULL,
  secret       VARCHAR(255) NOT NULL DEFAULT '',
  content_type VARCHAR(128) NOT NULL DEFAULT 'application/json',
  events       VARCHAR(2048) NOT NULL DEFAULT '["issues","issue_comment"]',
  active       TINYINT NOT NULL DEFAULT 1,
  created_at   VARCHAR(40) NOT NULL,
  updated_at   VARCHAR(40) NOT NULL,
  CONSTRAINT {{fk_webhooks_project}} FOREIGN KEY (project_id) REFERENCES {{projects}}(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX webhooks_project ON {{webhooks}} (project_id);

CREATE TABLE IF NOT EXISTS {{webhook_deliveries}} (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  webhook_id      BIGINT NOT NULL,
  event           VARCHAR(64) NOT NULL,
  delivery_uuid   VARCHAR(64) NOT NULL,
  payload         LONGTEXT NOT NULL,
  response_status INT DEFAULT NULL,
  response_body   LONGTEXT,
  duration_ms     INT DEFAULT NULL,
  error           TEXT,
  created_at      VARCHAR(40) NOT NULL,
  CONSTRAINT {{fk_deliveries_webhook}} FOREIGN KEY (webhook_id) REFERENCES {{webhooks}}(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX deliveries_webhook ON {{webhook_deliveries}} (webhook_id);
CREATE INDEX deliveries_created ON {{webhook_deliveries}} (created_at DESC);

CREATE TABLE IF NOT EXISTS {{personal_access_tokens}} (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_login       VARCHAR(255) NOT NULL,
  name             VARCHAR(255) NOT NULL,
  salt             VARCHAR(32) NOT NULL,
  token_hash       VARCHAR(64) NOT NULL,
  token_last_eight CHAR(8) NOT NULL,
  scopes           VARCHAR(2048) NOT NULL DEFAULT '[]',
  ip_allowlist     VARCHAR(2048) NOT NULL DEFAULT '[]',
  expires_at       VARCHAR(40) DEFAULT NULL,
  last_used_at     VARCHAR(40) DEFAULT NULL,
  created_at       VARCHAR(40) NOT NULL,
  revoked_at       VARCHAR(40) DEFAULT NULL,
  CONSTRAINT {{fk_pat_user}} FOREIGN KEY (user_login) REFERENCES {{users}}(login) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX pat_user         ON {{personal_access_tokens}} (user_login);
CREATE INDEX pat_last_eight   ON {{personal_access_tokens}} (token_last_eight);

CREATE TABLE IF NOT EXISTS {{project_members}} (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id  BIGINT NOT NULL,
  user_login  VARCHAR(255) NOT NULL,
  role        VARCHAR(16) NOT NULL DEFAULT 'writer'
              CHECK (role IN ('reader','writer','admin')),
  created_at  VARCHAR(40) NOT NULL,
  UNIQUE (project_id, user_login),
  CONSTRAINT {{fk_pm_project}} FOREIGN KEY (project_id) REFERENCES {{projects}}(id) ON DELETE CASCADE,
  CONSTRAINT {{fk_pm_user}} FOREIGN KEY (user_login) REFERENCES {{users}}(login) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX project_members_user ON {{project_members}} (user_login);
