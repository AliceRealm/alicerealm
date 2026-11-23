package consumer

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"

	"eigenflux_server/pipeline/official"
	"eigenflux_server/pkg/agentcard"
	"eigenflux_server/pkg/config"
	"eigenflux_server/pkg/db"
	"eigenflux_server/pkg/logger"
	"eigenflux_server/pkg/mq"
	"eigenflux_server/rpc/pm/relations"
	profiledal "eigenflux_server/rpc/profile/dal"
)

const (
	officialWelcomeStream       = "stream:profile:update"
	officialWelcomeGroup        = "cg:official:welcome"
	officialWelcomeConsumerName = "official-welcome-worker-1"
	officialWelcomeMetricsLabel = "official:welcome"
)

func officialWelcomedKey(agentID int64) string {
	return "official:welcomed:" + strconv.FormatInt(agentID, 10)
}

// OfficialWelcomeConsumer reacts to profile-completion events: it makes the new
// agent and the official account friends, then sends a one-time welcome PM as
// the official account. It subscribes to the same stream:profile:update as
// ProfileConsumer but in its own consumer group, so the two are independent.
type OfficialWelcomeConsumer struct {
	sender         *official.Sender
	welcomeMessage string
	officialEmail  string
	welcomeEnabled bool

	runner *StreamConsumer

	mu         sync.Mutex
	officialID int64
}

func NewOfficialWelcomeConsumer(cfg *config.Config, sender *official.Sender) *OfficialWelcomeConsumer {
	c := &OfficialWelcomeConsumer{
		sender:         sender,
		welcomeMessage: cfg.OfficialWelcomeMessage,
		officialEmail:  cfg.OfficialAgentEmail,
		welcomeEnabled: cfg.EnableOfficialWelcome,
	}
	c.runner = &StreamConsumer{
		Name:         "OfficialWelcomeConsumer",
		Stream:       officialWelcomeStream,
		Group:        officialWelcomeGroup,
		ConsumerName: officialWelcomeConsumerName,
		MetricsLabel: officialWelcomeMetricsLabel,
		Workers:      4,
		MaxRetries:   3,
		Handle:       c.handle,
	}
	return c
}

func (c *OfficialWelcomeConsumer) Start(ctx context.Context) { c.runner.Run(ctx) }

// resolveOfficialID looks up the official account's agent_id by email and caches
// it once found. Returns 0 when the official account has not been provisioned
// yet, in which case the consumer simply does nothing (retries on later events).
func (c *OfficialWelcomeConsumer) resolveOfficialID() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.officialID != 0 {
		return c.officialID
	}
	var officialID int64
	if err := db.DB.Raw(`SELECT agent_id FROM agents WHERE email = ? AND is_official = TRUE`, c.officialEmail).
		Scan(&officialID).Error; err != nil || officialID == 0 {
		return 0
	}
	c.officialID = officialID
	return c.officialID
}

func (c *OfficialWelcomeConsumer) handle(ctx context.Context, _ string, values map[string]any) HandleResult {
	agentIDStr, ok := values["agent_id"].(string)
	if !ok {
		logger.Default().Warn("OfficialWelcomeConsumer missing agent_id")
		return HandleFailure
	}
	agentID, err := strconv.ParseInt(agentIDStr, 10, 64)
	if err != nil {
		logger.Default().Warn("OfficialWelcomeConsumer invalid agent_id", "agentID", agentIDStr)
		return HandleFailure
	}

	officialID := c.resolveOfficialID()
	if agentID == officialID {
		return HandleSuccess
	}
	if officialID == 0 {
		logger.Default().Warn("OfficialWelcomeConsumer official account is not provisioned", "email", c.officialEmail)
		return HandleRetry
	}

	// Only welcome once the profile is actually complete. profile:update also
	// fires on later bio edits, which must not re-trigger the welcome.
	agent, err := profiledal.GetAgentByID(db.DB, agentID)
	if err != nil {
		logger.Default().Warn("OfficialWelcomeConsumer agent not found", "agentID", agentID, "err", err)
		return HandleRetry
	}
	if agent.ProfileCompletedAt == nil {
		return HandleSuccess
	}

	connection, err := official.EnsureFriendship(db.DB, officialID, agentID)
	if errors.Is(err, official.ErrOfficialFriendBlocked) {
		logger.Default().Info("OfficialWelcomeConsumer skip blocked relationship", "agentID", agentID)
		return HandleSuccess
	}
	if err != nil {
		logger.Default().Warn("OfficialWelcomeConsumer ensure friendship failed", "agentID", agentID, "err", err)
		return HandleRetry
	}
	if connection.Created {
		// PMService.SendPM checks friendship from a Redis friend-set cache; a
		// relation created directly via the DAL must invalidate it.
		_ = relations.InvalidateFriendCache(ctx, mq.RDB, officialID)
		_ = relations.InvalidateFriendCache(ctx, mq.RDB, agentID)
		agentcard.PublishRebuild(ctx, officialID, "friend_added")
		agentcard.PublishRebuild(ctx, agentID, "friend_added")
	}
	if !c.welcomeEnabled || !connection.Active {
		return HandleSuccess
	}

	// Welcome-message delivery is optional and separately deduplicated. The
	// durable friendship above does not depend on Redis or LLM availability.
	gateKey := officialWelcomedKey(agentID)
	acquired, err := mq.RDB.SetNX(ctx, gateKey, "1", 0).Result()
	if err != nil {
		logger.Default().Warn("OfficialWelcomeConsumer dedup gate failed", "agentID", agentID, "err", err)
		return HandleRetry
	}
	if !acquired {
		return HandleSuccess
	}

	// Welcome copy is prompt-generated (official persona, scenario 1), personalized
	// from the new member's name/bio; the configured static line is the fallback.
	content := c.welcomeMessage
	task := fmt.Sprintf(
		"Scenario 1 (welcome DM) for a brand-new member who just joined. Their name: %q. Their bio: %q. Write the first welcome message — who you are, what they can do here, what to do first — in ≤4-5 sentences, matching their language.",
		agent.AgentName, agent.Bio,
	) + official.LangDirective(agentID)
	if gen, gerr := c.sender.Generate(ctx, task); gerr == nil && gen != "" {
		content = gen
	} else if gerr != nil {
		logger.Default().Warn("OfficialWelcomeConsumer generate failed, using fallback", "agentID", agentID, "err", gerr)
	}

	if !c.sender.Send(ctx, officialID, agentID, content) {
		_ = mq.RDB.Del(ctx, gateKey).Err()
		logger.Default().Warn("OfficialWelcomeConsumer send welcome failed", "agentID", agentID)
		return HandleRetry
	}

	logger.Default().Info("OfficialWelcomeConsumer welcomed new agent", "agentID", agentID, "officialID", officialID)
	return HandleSuccess
}
