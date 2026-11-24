package consolev2

import (
	"context"
	"net/http"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/cloudwego/hertz/pkg/app/server"
	redis "github.com/redis/go-redis/v9"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"eigenflux_server/pkg/config"
	"eigenflux_server/pkg/pet"
)

func TestPetPairingPublicCreateAndOneTimeExchange(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE TABLE pet_devices (
		device_id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, device_name TEXT NOT NULL,
		platform TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, status INTEGER NOT NULL,
		created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER
	)`).Error; err != nil {
		t.Fatal(err)
	}
	cache := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	svc, err := NewService(db, &fixedIDGenerator{}, &config.Config{
		ConsoleV2BootstrapSecret: "test-secret",
		ConsoleV2OTPPepper:       "test-otp-pepper",
		ConsoleV2PublicURL:       "https://console.example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	svc.redisClient = rdb
	h := server.New()
	svc.Register(h)

	status, payload, _ := performJSON(t, h, http.MethodPost, "/api/v2/pet/pairings", map[string]string{
		"device_name": "Alice desktop",
		"platform":    "windows",
	})
	if status != http.StatusCreated {
		t.Fatalf("create pairing status=%d payload=%#v", status, payload)
	}
	data := responseData(t, payload)
	pairing := data["pairing"].(map[string]interface{})
	pairingID := pairing["pairing_id"].(string)
	secret := data["pairing_secret"].(string)
	if data["dashboard_url"] != "https://console.example.test/dashboard/settings?pet_pair="+pairingID {
		t.Fatalf("unexpected dashboard URL: %#v", data["dashboard_url"])
	}

	status, payload, _ = performJSON(t, h, http.MethodPost, "/api/v2/pet/pairings/"+pairingID+"/exchange", map[string]string{"pairing_secret": secret})
	if status != http.StatusConflict || responseErrorCode(t, payload) != "PET_PAIRING_PENDING" {
		t.Fatalf("pending exchange status=%d payload=%#v", status, payload)
	}
	if _, err := pet.NewStore(db, rdb).ApprovePairing(context.Background(), 42, pairingID); err != nil {
		t.Fatal(err)
	}
	status, payload, _ = performJSON(t, h, http.MethodPost, "/api/v2/pet/pairings/"+pairingID+"/exchange", map[string]string{"pairing_secret": secret})
	if status != http.StatusOK {
		t.Fatalf("approved exchange status=%d payload=%#v", status, payload)
	}
	if token, _ := responseData(t, payload)["device_token"].(string); len(token) != len(pet.DeviceTokenPrefix)+64 {
		t.Fatalf("unexpected exchanged token: %q", token)
	}
	status, payload, _ = performJSON(t, h, http.MethodPost, "/api/v2/pet/pairings/"+pairingID+"/exchange", map[string]string{"pairing_secret": secret})
	if status != http.StatusGone || responseErrorCode(t, payload) != "PET_PAIRING_EXPIRED" {
		t.Fatalf("replayed exchange status=%d payload=%#v", status, payload)
	}
}
