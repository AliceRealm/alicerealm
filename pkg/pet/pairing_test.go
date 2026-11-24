package pet

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	redis "github.com/redis/go-redis/v9"
)

func newPairingTestStore(t *testing.T) *Store {
	t.Helper()
	store, _ := newPetTestStore(t)
	server := miniredis.RunT(t)
	store.rdb = redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = store.rdb.Close() })
	return store
}

func TestPairingIsApprovedAndExchangedExactlyOnce(t *testing.T) {
	store := newPairingTestStore(t)
	ctx := context.Background()
	grant, err := store.CreatePairing(ctx, "Alice's desktop", "windows")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(grant.PairingID, "petpair_") || !strings.HasPrefix(grant.PairingSecret, PairingSecretPrefix) {
		t.Fatalf("unexpected pairing grant: %#v", grant)
	}
	visible, err := store.GetPairing(ctx, grant.PairingID)
	if err != nil || visible.Status != "pending" || visible.DeviceName != "Alice's desktop" {
		t.Fatalf("unexpected visible pairing: %#v, %v", visible, err)
	}
	if _, _, err := store.ExchangePairing(ctx, grant.PairingID, grant.PairingSecret); !errors.Is(err, ErrPending) {
		t.Fatalf("got %v before approval, want ErrPending", err)
	}
	if _, _, err := store.ExchangePairing(ctx, grant.PairingID, PairingSecretPrefix+strings.Repeat("0", 64)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("got %v for wrong secret, want ErrUnauthorized", err)
	}
	approved, err := store.ApprovePairing(ctx, 42, grant.PairingID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApprovePairing(ctx, 42, grant.PairingID); !errors.Is(err, ErrPairingUsed) {
		t.Fatalf("second approval returned %v, want ErrPairingUsed", err)
	}
	device, token, err := store.ExchangePairing(ctx, grant.PairingID, grant.PairingSecret)
	if err != nil {
		t.Fatal(err)
	}
	if device.DeviceID != approved.DeviceID || !strings.HasPrefix(token, DeviceTokenPrefix) {
		t.Fatalf("unexpected exchange result: %#v %q", device, token)
	}
	if authenticated, err := store.AuthenticateDevice(ctx, token); err != nil || authenticated.DeviceID != approved.DeviceID {
		t.Fatalf("exchanged token did not authenticate: %#v %v", authenticated, err)
	}
	if _, _, err := store.ExchangePairing(ctx, grant.PairingID, grant.PairingSecret); !errors.Is(err, ErrExpired) {
		t.Fatalf("second exchange returned %v, want ErrExpired", err)
	}
}

func TestPairingRejectsInvalidDeviceMetadata(t *testing.T) {
	store := newPairingTestStore(t)
	for _, test := range []struct{ name, platform string }{
		{"", "windows"},
		{"desktop", "../../windows"},
		{strings.Repeat("界", 101), "windows"},
	} {
		if _, err := store.CreatePairing(context.Background(), test.name, test.platform); !errors.Is(err, ErrInvalid) {
			t.Fatalf("CreatePairing(%q, %q) returned %v, want ErrInvalid", test.name, test.platform, err)
		}
	}
}
