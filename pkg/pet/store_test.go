package pet

import (
	"context"
	"errors"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newPetTestStore(t *testing.T) (*Store, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`CREATE TABLE pet_devices (device_id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, device_name TEXT NOT NULL, platform TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, status INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER)`,
		`CREATE TABLE pet_preferences (agent_id INTEGER PRIMARY KEY, allow_friend_interactions BOOLEAN NOT NULL, allow_agent_messages BOOLEAN NOT NULL, do_not_disturb BOOLEAN NOT NULL, updated_at INTEGER NOT NULL)`,
		`CREATE TABLE pet_interactions (interaction_id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, sender_agent_id INTEGER NOT NULL, sender_device_id TEXT NOT NULL, receiver_agent_id INTEGER NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, acknowledged_at INTEGER, UNIQUE(sender_agent_id, request_id))`,
		`CREATE TABLE user_relations (from_uid INTEGER NOT NULL, to_uid INTEGER NOT NULL, rel_type INTEGER NOT NULL)`,
	}
	for _, statement := range statements {
		if err := db.Exec(statement).Error; err != nil {
			t.Fatal(err)
		}
	}
	return NewStore(db, nil), db
}

func TestStoreRequiresFriendshipAndHonorsBlock(t *testing.T) {
	store, db := newPetTestStore(t)
	ctx := context.Background()
	device, _, err := store.CreateDevice(ctx, 1, "Main desktop", "windows")
	if err != nil {
		t.Fatal(err)
	}
	input := CreateInteractionInput{RequestID: "request-1", ReceiverAgentID: 2, EventType: "wave", Payload: InteractionPayload{Message: "hi"}}
	if _, err := store.CreateInteraction(ctx, device, input); !errors.Is(err, ErrNotFriends) {
		t.Fatalf("got %v, want ErrNotFriends", err)
	}
	if err := db.Exec(`INSERT INTO user_relations (from_uid, to_uid, rel_type) VALUES (1, 2, 1)`).Error; err != nil {
		t.Fatal(err)
	}
	interaction, err := store.CreateInteraction(ctx, device, input)
	if err != nil {
		t.Fatal(err)
	}
	items, err := store.ListInteractions(ctx, 2, 0, 50)
	if err != nil || len(items) != 1 {
		t.Fatalf("pending list returned %d items, %v", len(items), err)
	}
	if err := store.Acknowledge(ctx, 2, interaction.InteractionID); err != nil {
		t.Fatal(err)
	}
	items, err = store.ListInteractions(ctx, 2, 0, 50)
	if err != nil || len(items) != 0 {
		t.Fatalf("acknowledged interaction was redelivered: %d items, %v", len(items), err)
	}
	duplicate, err := store.CreateInteraction(ctx, device, input)
	if err != nil || duplicate.InteractionID != interaction.InteractionID {
		t.Fatalf("idempotent retry returned %#v, %v", duplicate, err)
	}
	input.EventType = "high_five"
	if _, err := store.CreateInteraction(ctx, device, input); !errors.Is(err, ErrConflict) {
		t.Fatalf("got %v, want ErrConflict", err)
	}
	if err := db.Exec(`INSERT INTO user_relations (from_uid, to_uid, rel_type) VALUES (2, 1, 2)`).Error; err != nil {
		t.Fatal(err)
	}
	input.RequestID = "request-2"
	if _, err := store.CreateInteraction(ctx, device, input); !errors.Is(err, ErrBlocked) {
		t.Fatalf("got %v, want ErrBlocked", err)
	}
}

func TestStoreDeviceRevocationInvalidatesToken(t *testing.T) {
	store, _ := newPetTestStore(t)
	ctx := context.Background()
	device, token, err := store.CreateDevice(ctx, 1, "Laptop", "linux")
	if err != nil {
		t.Fatal(err)
	}
	if authenticated, err := store.AuthenticateDevice(ctx, token); err != nil || authenticated.DeviceID != device.DeviceID {
		t.Fatalf("device authentication returned %#v, %v", authenticated, err)
	}
	if err := store.RevokeDevice(ctx, 1, device.DeviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AuthenticateDevice(ctx, token); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("got %v after revocation, want ErrUnauthorized", err)
	}
}
