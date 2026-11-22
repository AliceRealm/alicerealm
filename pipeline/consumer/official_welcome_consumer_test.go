package consumer

import (
	"errors"
	"testing"
	"time"

	"eigenflux_server/pipeline/official"
	"eigenflux_server/pkg/config"
	"eigenflux_server/pkg/db"
	"eigenflux_server/pkg/mq"
	pmdal "eigenflux_server/rpc/pm/dal"

	"gorm.io/gorm/logger"
)

// TestEnsureFriendship covers the deterministic friend-establishment used by the
// welcome flow: a pending request is accepted, the relation is created, and a
// second call is a no-op (no duplicate rows). Does not require the PM service.
func TestEnsureFriendship(t *testing.T) {
	cfg := config.Load()
	db.InitWithLogLevel(cfg.PgDSN, logger.Silent)
	mq.Init(cfg.RedisAddr, cfg.RedisPassword)

	const officialID int64 = 9_200_000_000_000_000_001
	const userID int64 = 9_200_000_000_000_000_002
	const reqID int64 = 9_200_000_000_000_000_010

	clean := func() {
		db.DB.Exec("DELETE FROM official_agent_connections WHERE official_agent_id = ? OR agent_id = ?", officialID, userID)
		db.DB.Exec("DELETE FROM user_relations WHERE from_uid IN (?, ?) OR to_uid IN (?, ?)", officialID, userID, officialID, userID)
		db.DB.Exec("DELETE FROM friend_requests WHERE from_uid IN (?, ?) OR to_uid IN (?, ?)", officialID, userID, officialID, userID)
		db.DB.Exec("DELETE FROM agents WHERE agent_id IN (?, ?)", officialID, userID)
	}
	clean()
	t.Cleanup(clean)
	now := time.Now().UnixMilli()
	if err := db.DB.Exec(`INSERT INTO agents
		(agent_id, email, agent_name, bio, created_at, updated_at, profile_completed_at, is_official)
		VALUES (?, ?, 'Official fixture', '', ?, ?, ?, TRUE),
		       (?, ?, 'Member fixture', '', ?, ?, ?, FALSE)`,
		officialID, "official-friend-test@alicerealm.test", now, now, now,
		userID, "member-friend-test@alicerealm.test", now, now, now).Error; err != nil {
		t.Fatalf("seed agents: %v", err)
	}

	// A pending request user->official exists (the onboarding apply step).
	if _, err := pmdal.CreateFriendRequest(db.DB, reqID, userID, officialID, "", ""); err != nil {
		t.Fatalf("seed pending request: %v", err)
	}

	connection, err := official.EnsureFriendship(db.DB, officialID, userID)
	if err != nil {
		t.Fatalf("ensureFriendship: %v", err)
	}
	if !connection.Created || !connection.Active || !connection.Processed {
		t.Fatalf("unexpected first connection result: %+v", connection)
	}

	friend, err := pmdal.IsFriend(db.DB, officialID, userID)
	if err != nil {
		t.Fatalf("IsFriend: %v", err)
	}
	if !friend {
		t.Fatal("expected official and user to be friends")
	}

	req, err := pmdal.GetFriendRequest(db.DB, reqID)
	if err != nil {
		t.Fatalf("GetFriendRequest: %v", err)
	}
	if req.Status != pmdal.RequestStatusAccepted {
		t.Fatalf("request status = %d, want accepted (%d)", req.Status, pmdal.RequestStatusAccepted)
	}

	// Idempotent: a second call must not create duplicate relation rows.
	connection, err = official.EnsureFriendship(db.DB, officialID, userID)
	if err != nil {
		t.Fatalf("ensureFriendship (second call): %v", err)
	}
	if connection.Created || !connection.Active || !connection.Processed {
		t.Fatalf("unexpected replay result: %+v", connection)
	}
	var pairs int64
	db.DB.Raw(
		"SELECT count(*) FROM user_relations WHERE rel_type = ? AND ((from_uid=? AND to_uid=?) OR (from_uid=? AND to_uid=?))",
		pmdal.RelTypeFriend, officialID, userID, userID, officialID,
	).Scan(&pairs)
	if pairs != 2 {
		t.Fatalf("friend relation rows = %d, want 2", pairs)
	}

	// A deliberate unfriend is durable: later profile-update events must not
	// recreate the platform-managed relationship.
	if err := pmdal.DeleteFriendRelation(db.DB, officialID, userID); err != nil {
		t.Fatalf("unfriend: %v", err)
	}
	connection, err = official.EnsureFriendship(db.DB, officialID, userID)
	if err != nil {
		t.Fatalf("ensureFriendship after unfriend: %v", err)
	}
	if connection.Created || connection.Active || !connection.Processed {
		t.Fatalf("unfriend was not preserved: %+v", connection)
	}

	// The first-connection path respects blocks in both directions and never
	// writes its durable marker when the boundary rejects the relationship.
	if err := db.DB.Exec(`DELETE FROM official_agent_connections
		WHERE official_agent_id = ? AND agent_id = ?`, officialID, userID).Error; err != nil {
		t.Fatalf("reset connection marker: %v", err)
	}
	for _, tc := range []struct {
		name           string
		fromUID, toUID int64
	}{
		{name: "member blocks official", fromUID: userID, toUID: officialID},
		{name: "official blocks member", fromUID: officialID, toUID: userID},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := pmdal.CreateBlockRelation(db.DB, tc.fromUID, tc.toUID, "test"); err != nil {
				t.Fatalf("seed block: %v", err)
			}
			if _, err := official.EnsureFriendship(db.DB, officialID, userID); !errors.Is(err, official.ErrOfficialFriendBlocked) {
				t.Fatalf("EnsureFriendship error = %v, want blocked", err)
			}
			if err := pmdal.DeleteBlockRelation(db.DB, tc.fromUID, tc.toUID); err != nil {
				t.Fatalf("remove block: %v", err)
			}
		})
	}

	if err := db.DB.Exec(`UPDATE agents SET is_official = FALSE WHERE agent_id = ?`, officialID).Error; err != nil {
		t.Fatalf("remove official flag: %v", err)
	}
	if _, err := official.EnsureFriendship(db.DB, officialID, userID); !errors.Is(err, official.ErrOfficialAccountInvalid) {
		t.Fatalf("EnsureFriendship error = %v, want invalid official account", err)
	}
}
