-- +goose Up
CREATE TABLE pet_devices (
    device_id      VARCHAR(64) PRIMARY KEY,
    agent_id       BIGINT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    device_name    VARCHAR(100) NOT NULL,
    platform       VARCHAR(32) NOT NULL,
    token_hash     CHAR(64) NOT NULL UNIQUE,
    status         SMALLINT NOT NULL DEFAULT 1,
    created_at     BIGINT NOT NULL,
    last_seen_at   BIGINT NOT NULL,
    revoked_at     BIGINT,
    CONSTRAINT chk_pet_device_status CHECK (status IN (1, 2))
);

CREATE INDEX idx_pet_devices_agent_status
    ON pet_devices(agent_id, status, created_at DESC);

CREATE TABLE pet_preferences (
    agent_id                    BIGINT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
    allow_friend_interactions   BOOLEAN NOT NULL DEFAULT TRUE,
    allow_agent_messages        BOOLEAN NOT NULL DEFAULT TRUE,
    do_not_disturb              BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at                  BIGINT NOT NULL
);

CREATE TABLE pet_interactions (
    interaction_id      BIGSERIAL PRIMARY KEY,
    request_id          VARCHAR(128) NOT NULL,
    sender_agent_id     BIGINT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    sender_device_id    VARCHAR(64) NOT NULL REFERENCES pet_devices(device_id) ON DELETE RESTRICT,
    receiver_agent_id   BIGINT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    event_type          VARCHAR(32) NOT NULL,
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          BIGINT NOT NULL,
    expires_at          BIGINT NOT NULL,
    acknowledged_at     BIGINT,
    CONSTRAINT uq_pet_interaction_request UNIQUE (sender_agent_id, request_id),
    CONSTRAINT chk_pet_interaction_agents CHECK (sender_agent_id <> receiver_agent_id),
    CONSTRAINT chk_pet_interaction_expiry CHECK (expires_at > created_at),
    CONSTRAINT chk_pet_interaction_type CHECK (event_type IN (
        'wave', 'high_five', 'visit_request', 'visit_accept',
        'visit_decline', 'gift', 'emote'
    ))
);

CREATE INDEX idx_pet_interactions_receiver_cursor
    ON pet_interactions(receiver_agent_id, interaction_id);
CREATE INDEX idx_pet_interactions_expiry
    ON pet_interactions(expires_at) WHERE acknowledged_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_pet_interactions_expiry;
DROP INDEX IF EXISTS idx_pet_interactions_receiver_cursor;
DROP TABLE IF EXISTS pet_interactions;
DROP TABLE IF EXISTS pet_preferences;
DROP INDEX IF EXISTS idx_pet_devices_agent_status;
DROP TABLE IF EXISTS pet_devices;
