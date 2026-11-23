// Command official_friend_backfill one-shot backfills the official-account
// friendship for existing users. New users get friended by the
// OfficialWelcomeConsumer on profile completion, but users who onboarded before
// the welcome was opened to everyone were never friended — this walks them and
// builds the relation.
//
// It only builds the friend relation; it does NOT send a welcome PM (existing
// users already know the app; a bulk "welcome" would be spam). Idempotent:
// already-friends are skipped, so it is safe to re-run.
//
//	go run ./scripts/official_friend_backfill --dry-run   # report target count only
//	go run ./scripts/official_friend_backfill             # backfill everyone
//	go run ./scripts/official_friend_backfill --limit 500 # cap for a first pass
package main

import (
	"context"
	"flag"
	"log"
	"sync"
	"sync/atomic"

	"eigenflux_server/pipeline/official"
	"eigenflux_server/pkg/config"
	"eigenflux_server/pkg/db"
	"eigenflux_server/pkg/mq"
	"eigenflux_server/rpc/pm/relations"
	profiledal "eigenflux_server/rpc/profile/dal"
)

type result int

const (
	resultCreated result = iota
	resultSkipped
	resultFailed
)

func main() {
	cfg := config.Load()

	dryRun := flag.Bool("dry-run", false, "report target count only, no writes")
	workers := flag.Int("workers", 8, "concurrent workers")
	limit := flag.Int("limit", 0, "max users to process (0 = all)")
	flag.Parse()

	db.Init(cfg.PgDSN)
	mq.Init(cfg.RedisAddr, cfg.RedisPassword)
	ctx := context.Background()

	official, err := profiledal.GetAgentByEmail(db.DB, cfg.OfficialAgentEmail)
	if err != nil || official == nil {
		log.Fatalf("official account not found (email=%s): %v", cfg.OfficialAgentEmail, err)
	}
	officialID := official.AgentID
	var isOfficial bool
	if err := db.DB.Raw(`SELECT is_official FROM agents WHERE agent_id = ?`, officialID).Scan(&isOfficial).Error; err != nil || !isOfficial {
		log.Fatalf("configured official account is not marked is_official=true (agent_id=%d)", officialID)
	}
	log.Printf("official account agent_id=%d email=%s", officialID, cfg.OfficialAgentEmail)

	targets, err := loadTargets(officialID, *limit)
	if err != nil {
		log.Fatalf("load targets: %v", err)
	}
	log.Printf("backfill targets: %d users (profile-complete, not yet processed, no block in either direction)", len(targets))
	if *dryRun {
		log.Println("dry-run: no writes")
		return
	}
	if len(targets) == 0 {
		return
	}

	var created, skipped, failed int64
	work := make(chan int64)
	var wg sync.WaitGroup
	for i := 0; i < *workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for uid := range work {
				switch ensureOfficialFriend(ctx, officialID, uid) {
				case resultCreated:
					if n := atomic.AddInt64(&created, 1); n%200 == 0 {
						log.Printf("progress: created=%d skipped=%d failed=%d",
							n, atomic.LoadInt64(&skipped), atomic.LoadInt64(&failed))
					}
				case resultSkipped:
					atomic.AddInt64(&skipped, 1)
				case resultFailed:
					atomic.AddInt64(&failed, 1)
				}
			}
		}()
	}
	for _, uid := range targets {
		work <- uid
	}
	close(work)
	wg.Wait()

	// The official account's friend cache key is the same for every backfilled
	// user, so invalidate it exactly once here rather than once per worker.
	if created > 0 {
		_ = relations.InvalidateFriendCache(ctx, mq.RDB, officialID)
	}

	log.Printf("backfill done: created=%d skipped(already friend/processed)=%d failed=%d total=%d",
		created, skipped, failed, len(targets))
}

// ensureOfficialFriend mirrors OfficialWelcomeConsumer.ensureFriendship: accept
// any pending request between the pair, build the symmetric relation in a locked
// transaction (idempotent), then invalidate the user's friend cache. The
// official account's own cache is the same key for every user, so the caller
// invalidates it once after all workers finish. No welcome PM is sent.
func ensureOfficialFriend(ctx context.Context, officialID, userID int64) result {
	connection, err := official.EnsureFriendship(db.DB, officialID, userID)
	if err != nil {
		log.Printf("agent_id=%d failed: %v", userID, err)
		return resultFailed
	}
	if !connection.Created {
		return resultSkipped
	}
	_ = relations.InvalidateFriendCache(ctx, mq.RDB, userID)
	return resultCreated
}

// loadTargets returns agent_ids that should be friended: profile-complete,
// non-official users whose one-time official connection has not been processed
// and who have not blocked (or been blocked by) the official account.
func loadTargets(officialID int64, limit int) ([]int64, error) {
	var ids []int64
	sql := `
		SELECT a.agent_id
		  FROM agents a
		 WHERE a.is_official = FALSE
		   AND a.profile_completed_at IS NOT NULL
		   AND NOT EXISTS (
		         SELECT 1 FROM official_agent_connections connection
		          WHERE connection.official_agent_id = ? AND connection.agent_id = a.agent_id)
		   AND NOT EXISTS (
		         SELECT 1 FROM user_relations ur
		          WHERE ur.rel_type = 2
		            AND ((ur.from_uid = a.agent_id AND ur.to_uid = ?)
		              OR (ur.from_uid = ? AND ur.to_uid = a.agent_id)))
		 ORDER BY a.agent_id ASC`
	args := []any{officialID, officialID, officialID}
	if limit > 0 {
		sql += " LIMIT ?"
		args = append(args, limit)
	}
	if err := db.DB.Raw(sql, args...).Scan(&ids).Error; err != nil {
		return nil, err
	}
	return ids, nil
}
