-- +goose Up
-- Records the one-time platform-managed connection between the singleton
-- official Agent and a member.  Keeping this marker in PostgreSQL (rather
-- than only in Redis) means a cache reset or later profile edit cannot
-- recreate a friendship that the member deliberately removed.
CREATE TABLE official_agent_connections (
    official_agent_id BIGINT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    agent_id          BIGINT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    connected_at      BIGINT NOT NULL,
    PRIMARY KEY (official_agent_id, agent_id),
    CONSTRAINT chk_official_agent_connection_not_self
        CHECK (official_agent_id <> agent_id)
);

CREATE INDEX idx_official_agent_connections_agent
    ON official_agent_connections(agent_id);

-- +goose Down
DROP INDEX IF EXISTS idx_official_agent_connections_agent;
DROP TABLE IF EXISTS official_agent_connections;
