package pet

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	PairingSecretPrefix = "arpp_"
	PairingTTL          = 10 * time.Minute
	PairingExchangeTTL  = 2 * time.Minute
)

var (
	ErrUnavailable = errors.New("pet service is unavailable")
	ErrPending     = errors.New("pet pairing is pending approval")
	ErrExpired     = errors.New("pet pairing expired")
	ErrPairingUsed = errors.New("pet pairing was already approved or exchanged")
)

type Pairing struct {
	PairingID  string `json:"pairing_id"`
	DeviceName string `json:"device_name"`
	Platform   string `json:"platform"`
	Status     string `json:"status"`
	ExpiresAt  int64  `json:"expires_at"`
}

type PairingGrant struct {
	Pairing
	PairingSecret string `json:"pairing_secret"`
}

func pairingKey(id string) string { return "pet:pairing:" + id }

func validateDeviceMetadata(name, platform string) (string, string, error) {
	name, platform = strings.TrimSpace(name), strings.ToLower(strings.TrimSpace(platform))
	if name == "" || utf8.RuneCountInString(name) > 100 || !assetIDPattern.MatchString(platform) {
		return "", "", ErrInvalid
	}
	return name, platform, nil
}

func newPairingSecret() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return PairingSecretPrefix + hex.EncodeToString(raw), nil
}

func (s *Store) CreatePairing(ctx context.Context, name, platform string) (PairingGrant, error) {
	if s.rdb == nil {
		return PairingGrant{}, ErrUnavailable
	}
	name, platform, err := validateDeviceMetadata(name, platform)
	if err != nil {
		return PairingGrant{}, err
	}
	secret, err := newPairingSecret()
	if err != nil {
		return PairingGrant{}, err
	}
	now := time.Now()
	pairing := Pairing{
		PairingID:  "petpair_" + strings.ReplaceAll(uuid.NewString(), "-", ""),
		DeviceName: name,
		Platform:   platform,
		Status:     "pending",
		ExpiresAt:  now.Add(PairingTTL).UnixMilli(),
	}
	key := pairingKey(pairing.PairingID)
	_, err = s.rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.HSet(ctx, key, map[string]interface{}{
			"secret_hash": HashToken(secret),
			"device_name": pairing.DeviceName,
			"platform":    pairing.Platform,
			"status":      pairing.Status,
			"expires_at":  pairing.ExpiresAt,
		})
		pipe.Expire(ctx, key, PairingTTL)
		return nil
	})
	if err != nil {
		return PairingGrant{}, err
	}
	return PairingGrant{Pairing: pairing, PairingSecret: secret}, nil
}

func pairingFromFields(id string, fields map[string]string) (Pairing, error) {
	if len(fields) == 0 {
		return Pairing{}, ErrExpired
	}
	expiresAt, err := strconv.ParseInt(fields["expires_at"], 10, 64)
	if err != nil || expiresAt <= time.Now().UnixMilli() {
		return Pairing{}, ErrExpired
	}
	status := fields["status"]
	if status == "approving" {
		status = "pending"
	}
	return Pairing{PairingID: id, DeviceName: fields["device_name"], Platform: fields["platform"], Status: status, ExpiresAt: expiresAt}, nil
}

func (s *Store) GetPairing(ctx context.Context, id string) (Pairing, error) {
	if s.rdb == nil {
		return Pairing{}, ErrUnavailable
	}
	if !strings.HasPrefix(id, "petpair_") || len(id) != len("petpair_")+32 {
		return Pairing{}, ErrNotFound
	}
	fields, err := s.rdb.HGetAll(ctx, pairingKey(id)).Result()
	if err != nil {
		return Pairing{}, err
	}
	return pairingFromFields(id, fields)
}

func (s *Store) ApprovePairing(ctx context.Context, agentID int64, id string) (Device, error) {
	if s.rdb == nil {
		return Device{}, ErrUnavailable
	}
	if agentID <= 0 {
		return Device{}, ErrInvalid
	}
	key := pairingKey(id)
	var pairing Pairing
	err := s.rdb.Watch(ctx, func(tx *redis.Tx) error {
		fields, err := tx.HGetAll(ctx, key).Result()
		if err != nil {
			return err
		}
		pairing, err = pairingFromFields(id, fields)
		if err != nil {
			return err
		}
		if fields["status"] != "pending" {
			return ErrPairingUsed
		}
		_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			pipe.HSet(ctx, key, "status", "approving", "approved_agent_id", agentID)
			return nil
		})
		return err
	}, key)
	if err != nil {
		if errors.Is(err, redis.TxFailedErr) {
			return Device{}, ErrPairingUsed
		}
		return Device{}, err
	}

	device, token, err := s.CreateDevice(ctx, agentID, pairing.DeviceName, pairing.Platform)
	if err != nil {
		_ = s.rdb.HSet(ctx, key, "status", "pending").Err()
		return Device{}, err
	}
	expiresAt := time.Now().Add(PairingExchangeTTL).UnixMilli()
	err = s.rdb.Watch(ctx, func(tx *redis.Tx) error {
		fields, readErr := tx.HGetAll(ctx, key).Result()
		if readErr != nil {
			return readErr
		}
		if len(fields) == 0 {
			return ErrExpired
		}
		if fields["status"] != "approving" || fields["approved_agent_id"] != strconv.FormatInt(agentID, 10) {
			return ErrPairingUsed
		}
		_, writeErr := tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			pipe.HSet(ctx, key, map[string]interface{}{
				"status":       "approved",
				"device_id":    device.DeviceID,
				"device_token": token,
				"expires_at":   expiresAt,
			})
			pipe.Expire(ctx, key, PairingExchangeTTL)
			return nil
		})
		return writeErr
	}, key)
	if err != nil {
		_ = s.RevokeDevice(ctx, agentID, device.DeviceID)
		_ = s.rdb.Del(ctx, key).Err()
		return Device{}, err
	}
	return device, nil
}

func (s *Store) ExchangePairing(ctx context.Context, id, secret string) (Device, string, error) {
	if s.rdb == nil {
		return Device{}, "", ErrUnavailable
	}
	if !strings.HasPrefix(secret, PairingSecretPrefix) || len(secret) != len(PairingSecretPrefix)+64 {
		return Device{}, "", ErrUnauthorized
	}
	key := pairingKey(id)
	for attempt := 0; attempt < 3; attempt++ {
		var device Device
		var token string
		err := s.rdb.Watch(ctx, func(tx *redis.Tx) error {
			fields, err := tx.HGetAll(ctx, key).Result()
			if err != nil {
				return err
			}
			if _, err = pairingFromFields(id, fields); err != nil {
				return err
			}
			expected, actual := fields["secret_hash"], HashToken(secret)
			if len(expected) != len(actual) || subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) != 1 {
				return ErrUnauthorized
			}
			if fields["status"] == "pending" || fields["status"] == "approving" {
				return ErrPending
			}
			if fields["status"] != "approved" || fields["device_token"] == "" {
				return ErrPairingUsed
			}
			deviceID, tokenValue := fields["device_id"], fields["device_token"]
			if err = s.db.WithContext(ctx).Where("device_id = ? AND status = 1", deviceID).First(&device).Error; err != nil {
				return err
			}
			token = tokenValue
			_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
				pipe.Del(ctx, key)
				return nil
			})
			return err
		}, key)
		if errors.Is(err, redis.TxFailedErr) {
			continue
		}
		return device, token, err
	}
	return Device{}, "", ErrPairingUsed
}
