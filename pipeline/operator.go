package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"strings"
	"time"

	"eigenflux_server/pipeline/official"
	"eigenflux_server/pkg/agentidentity"
	"eigenflux_server/pkg/config"
	"eigenflux_server/pkg/db"
	"eigenflux_server/pkg/idgen"
	"eigenflux_server/pkg/mq"
	"eigenflux_server/rpc/pm/relations"
	profiledal "eigenflux_server/rpc/profile/dal"

	"github.com/lib/pq"
)

const officialBootstrapCommand = "official-bootstrap"

// runOperatorCommand exposes reviewed, idempotent production maintenance through
// the same pipeline artifact that the managed deployment gate builds. The
// long-running service path is unchanged when no command is supplied.
func runOperatorCommand(cfg *config.Config, args []string) (bool, error) {
	if len(args) == 0 || args[0] != officialBootstrapCommand {
		return false, nil
	}
	flags := flag.NewFlagSet(officialBootstrapCommand, flag.ContinueOnError)
	dryRun := flags.Bool("dry-run", false, "report the action without writing")
	limit := flags.Int("limit", 0, "maximum existing users to connect (0 = all)")
	if err := flags.Parse(args[1:]); err != nil {
		return true, err
	}
	if *limit < 0 {
		return true, errors.New("limit must not be negative")
	}
	return true, bootstrapOfficialAgent(cfg, *dryRun, *limit)
}

func bootstrapOfficialAgent(cfg *config.Config, dryRun bool, limit int) error {
	db.Init(cfg.PgDSN)
	mq.Init(cfg.RedisAddr, cfg.RedisPassword)

	officialID, created, err := provisionOfficialAgent(cfg, dryRun)
	if err != nil {
		return err
	}
	if dryRun && officialID == 0 {
		log.Printf("dry-run: official account would be created; friend backfill requires the created ID")
		return nil
	}

	targets, err := officialFriendTargets(officialID, limit)
	if err != nil {
		return fmt.Errorf("load official friend targets: %w", err)
	}
	log.Printf("official bootstrap: account_created=%t backfill_targets=%d", created, len(targets))
	if dryRun {
		log.Printf("dry-run: no writes")
		return nil
	}

	ctx := context.Background()
	connected := 0
	for _, userID := range targets {
		connection, connectErr := official.EnsureFriendship(db.DB, officialID, userID)
		if connectErr != nil {
			return fmt.Errorf("connect official account to agent_id=%d: %w", userID, connectErr)
		}
		if connection.Created {
			connected++
			_ = relations.InvalidateFriendCache(ctx, mq.RDB, userID)
		}
	}
	if connected > 0 {
		_ = relations.InvalidateFriendCache(ctx, mq.RDB, officialID)
	}
	log.Printf("official bootstrap complete: official_agent_id=%d connected=%d", officialID, connected)
	return nil
}

func provisionOfficialAgent(cfg *config.Config, dryRun bool) (int64, bool, error) {
	email := strings.TrimSpace(cfg.OfficialAgentEmail)
	if email == "" {
		return 0, false, errors.New("OFFICIAL_AGENT_EMAIL must not be empty")
	}

	var existingID int64
	if err := db.DB.Raw("SELECT agent_id FROM agents WHERE email = ?", email).Scan(&existingID).Error; err != nil {
		return 0, false, fmt.Errorf("lookup official account: %w", err)
	}
	now := time.Now().UnixMilli()
	if existingID != 0 {
		log.Printf("official account exists agent_id=%d; ensuring official profile", existingID)
		if dryRun {
			return existingID, false, nil
		}
		if err := ensureOfficialShortID(existingID); err != nil {
			return 0, false, fmt.Errorf("ensure official short ID: %w", err)
		}
		if err := db.DB.Exec(`UPDATE agents
			SET is_official = TRUE, agent_name = ?, bio = ?, updated_at = ?,
			    email_verified_at = COALESCE(email_verified_at, ?),
			    profile_completed_at = COALESCE(profile_completed_at, ?)
			WHERE email = ?`, cfg.OfficialAgentName, cfg.OfficialAgentBio, now, now, now, email).Error; err != nil {
			return 0, false, fmt.Errorf("update official account: %w", err)
		}
		return existingID, false, nil
	}

	log.Printf("official account is missing; creating %q", cfg.OfficialAgentName)
	if dryRun {
		return 0, true, nil
	}
	gen, err := idgen.NewManagedGenerator(context.Background(), idgen.ManagedGeneratorConfig{
		Endpoints:      splitEtcdEndpoints(cfg.EtcdAddr),
		WorkerPrefix:   cfg.IDWorkerPrefix,
		ServiceName:    "official-bootstrap",
		InstanceID:     cfg.IDInstanceID,
		LeaseTTLSecond: cfg.IDWorkerLeaseTTL,
		EpochMS:        cfg.IDSnowflakeEpoch,
	})
	if err != nil {
		return 0, false, fmt.Errorf("initialize official ID generator: %w", err)
	}
	defer func() { _ = gen.Close(context.Background()) }()
	agentID, err := gen.NextID()
	if err != nil {
		return 0, false, fmt.Errorf("generate official agent ID: %w", err)
	}
	if err := profiledal.CreateAgent(db.DB, &profiledal.Agent{
		AgentID: agentID, Email: email, AgentName: cfg.OfficialAgentName,
		Bio: cfg.OfficialAgentBio, IsOfficial: true,
	}); err != nil {
		return 0, false, fmt.Errorf("create official account: %w", err)
	}
	if err := db.DB.Exec(`UPDATE agents
		SET email_verified_at = ?, profile_completed_at = ?, updated_at = ?
		WHERE agent_id = ?`, now, now, now, agentID).Error; err != nil {
		return 0, false, fmt.Errorf("complete official account: %w", err)
	}
	return agentID, true, nil
}

func ensureOfficialShortID(agentID int64) error {
	var current string
	if err := db.DB.Raw(`SELECT COALESCE(short_id, '') FROM agents WHERE agent_id = ?`, agentID).Scan(&current).Error; err != nil {
		return err
	}
	if agentidentity.ValidShortID(current) {
		return nil
	}
	for attempt := 0; attempt < 100; attempt++ {
		shortID, err := agentidentity.GenerateShortID()
		if err != nil {
			return err
		}
		result := db.DB.Exec(`UPDATE agents SET short_id = ? WHERE agent_id = ? AND short_id IS NULL`, shortID, agentID)
		if result.Error == nil {
			if result.RowsAffected == 1 {
				return nil
			}
			return errors.New("official short ID changed concurrently")
		}
		var pqErr *pq.Error
		if !errors.As(result.Error, &pqErr) || pqErr.Code != "23505" {
			return result.Error
		}
	}
	return errors.New("official short ID collision retry budget exhausted")
}

func officialFriendTargets(officialID int64, limit int) ([]int64, error) {
	var ids []int64
	query := `SELECT a.agent_id
		FROM agents a
		WHERE a.is_official = FALSE
		  AND a.profile_completed_at IS NOT NULL
		  AND NOT EXISTS (
		      SELECT 1 FROM official_agent_connections connection
		      WHERE connection.official_agent_id = ? AND connection.agent_id = a.agent_id)
		  AND NOT EXISTS (
		      SELECT 1 FROM user_relations relation
		      WHERE relation.rel_type = 2
		        AND ((relation.from_uid = a.agent_id AND relation.to_uid = ?)
		          OR (relation.from_uid = ? AND relation.to_uid = a.agent_id)))
		ORDER BY a.agent_id ASC`
	args := []any{officialID, officialID, officialID}
	if limit > 0 {
		query += " LIMIT ?"
		args = append(args, limit)
	}
	if err := db.DB.Raw(query, args...).Scan(&ids).Error; err != nil {
		return nil, err
	}
	return ids, nil
}
