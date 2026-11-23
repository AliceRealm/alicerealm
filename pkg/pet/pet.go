package pet

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

const (
	DeviceTokenPrefix = "arpd_"
	DefaultTTL        = 10 * time.Minute
	MaxTTL            = time.Hour
)

var (
	ErrUnauthorized = errors.New("pet device is unauthorized")
	ErrNotFriends   = errors.New("pet interactions require friendship")
	ErrBlocked      = errors.New("pet interaction is blocked")
	ErrDisabled     = errors.New("pet interactions are disabled")
	ErrNotFound     = errors.New("pet interaction not found")
	ErrInvalid      = errors.New("invalid pet interaction")
	ErrConflict     = errors.New("pet request id conflicts with an existing interaction")

	allowedEventTypes = map[string]struct{}{
		"wave": {}, "high_five": {}, "visit_request": {}, "visit_accept": {},
		"visit_decline": {}, "gift": {}, "emote": {},
	}
	assetIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
)

type Device struct {
	DeviceID   string `gorm:"column:device_id;primaryKey" json:"device_id"`
	AgentID    int64  `gorm:"column:agent_id" json:"-"`
	DeviceName string `gorm:"column:device_name" json:"device_name"`
	Platform   string `gorm:"column:platform" json:"platform"`
	TokenHash  string `gorm:"column:token_hash" json:"-"`
	Status     int16  `gorm:"column:status" json:"status"`
	CreatedAt  int64  `gorm:"column:created_at" json:"created_at"`
	LastSeenAt int64  `gorm:"column:last_seen_at" json:"last_seen_at"`
	RevokedAt  *int64 `gorm:"column:revoked_at" json:"revoked_at,omitempty"`
}

func (Device) TableName() string { return "pet_devices" }

type Preferences struct {
	AgentID                 int64 `gorm:"column:agent_id;primaryKey" json:"-"`
	AllowFriendInteractions bool  `gorm:"column:allow_friend_interactions" json:"allow_friend_interactions"`
	AllowAgentMessages      bool  `gorm:"column:allow_agent_messages" json:"allow_agent_messages"`
	DoNotDisturb            bool  `gorm:"column:do_not_disturb" json:"do_not_disturb"`
	UpdatedAt               int64 `gorm:"column:updated_at" json:"updated_at"`
}

func (Preferences) TableName() string { return "pet_preferences" }

type JSONPayload json.RawMessage

func (payload JSONPayload) Value() (driver.Value, error) {
	if len(payload) == 0 {
		return "{}", nil
	}
	return string(payload), nil
}

func (payload *JSONPayload) Scan(value interface{}) error {
	switch typed := value.(type) {
	case []byte:
		*payload = append((*payload)[:0], typed...)
	case string:
		*payload = append((*payload)[:0], typed...)
	case nil:
		*payload = JSONPayload("{}")
	default:
		return fmt.Errorf("unsupported pet payload type %T", value)
	}
	return nil
}

func (payload JSONPayload) MarshalJSON() ([]byte, error) {
	if len(payload) == 0 {
		return []byte("{}"), nil
	}
	if !json.Valid(payload) {
		return nil, errors.New("invalid stored pet payload")
	}
	return payload, nil
}

type Interaction struct {
	InteractionID   int64       `gorm:"column:interaction_id;primaryKey" json:"interaction_id,string"`
	RequestID       string      `gorm:"column:request_id" json:"request_id"`
	SenderAgentID   int64       `gorm:"column:sender_agent_id" json:"sender_agent_id,string"`
	SenderDeviceID  string      `gorm:"column:sender_device_id" json:"sender_device_id"`
	ReceiverAgentID int64       `gorm:"column:receiver_agent_id" json:"receiver_agent_id,string"`
	EventType       string      `gorm:"column:event_type" json:"event_type"`
	Payload         JSONPayload `gorm:"column:payload;type:jsonb" json:"payload"`
	CreatedAt       int64       `gorm:"column:created_at" json:"created_at"`
	ExpiresAt       int64       `gorm:"column:expires_at" json:"expires_at"`
	AcknowledgedAt  *int64      `gorm:"column:acknowledged_at" json:"acknowledged_at,omitempty"`
}

func (Interaction) TableName() string { return "pet_interactions" }

type InteractionPayload struct {
	Message              string `json:"message,omitempty"`
	GiftID               string `json:"gift_id,omitempty"`
	EmoteID              string `json:"emote_id,omitempty"`
	ReplyToInteractionID string `json:"reply_to_interaction_id,omitempty"`
}

type CreateInteractionInput struct {
	RequestID       string
	ReceiverAgentID int64
	EventType       string
	Payload         InteractionPayload
	TTL             time.Duration
}

type Store struct {
	db  *gorm.DB
	rdb *redis.Client
}

func NewStore(db *gorm.DB, rdb *redis.Client) *Store { return &Store{db: db, rdb: rdb} }

func NewDeviceToken() (string, string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token := DeviceTokenPrefix + hex.EncodeToString(raw)
	return token, HashToken(token), nil
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *Store) CreateDevice(ctx context.Context, agentID int64, name, platform string) (Device, string, error) {
	name, platform = strings.TrimSpace(name), strings.ToLower(strings.TrimSpace(platform))
	if agentID <= 0 || name == "" || utf8.RuneCountInString(name) > 100 || !assetIDPattern.MatchString(platform) {
		return Device{}, "", ErrInvalid
	}
	token, hash, err := NewDeviceToken()
	if err != nil {
		return Device{}, "", err
	}
	now := time.Now().UnixMilli()
	device := Device{DeviceID: "petdev_" + strings.ReplaceAll(uuid.NewString(), "-", ""), AgentID: agentID, DeviceName: name, Platform: platform, TokenHash: hash, Status: 1, CreatedAt: now, LastSeenAt: now}
	if err := s.db.WithContext(ctx).Create(&device).Error; err != nil {
		return Device{}, "", err
	}
	return device, token, nil
}

func (s *Store) ListDevices(ctx context.Context, agentID int64) ([]Device, error) {
	var devices []Device
	err := s.db.WithContext(ctx).Where("agent_id = ?", agentID).Order("created_at DESC").Find(&devices).Error
	return devices, err
}

func (s *Store) RevokeDevice(ctx context.Context, agentID int64, deviceID string) error {
	now := time.Now().UnixMilli()
	result := s.db.WithContext(ctx).Model(&Device{}).Where("device_id = ? AND agent_id = ? AND status = 1", deviceID, agentID).Updates(map[string]interface{}{"status": 2, "revoked_at": now})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) AuthenticateDevice(ctx context.Context, token string) (Device, error) {
	if !strings.HasPrefix(token, DeviceTokenPrefix) || len(token) != len(DeviceTokenPrefix)+64 {
		return Device{}, ErrUnauthorized
	}
	var device Device
	err := s.db.WithContext(ctx).Where("token_hash = ? AND status = 1 AND revoked_at IS NULL", HashToken(token)).First(&device).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Device{}, ErrUnauthorized
	}
	if err != nil {
		return Device{}, err
	}
	now := time.Now().UnixMilli()
	_ = s.db.WithContext(ctx).Model(&Device{}).Where("device_id = ? AND last_seen_at < ?", device.DeviceID, now-300000).Update("last_seen_at", now).Error
	return device, nil
}

func (s *Store) GetPreferences(ctx context.Context, agentID int64) (Preferences, error) {
	var prefs Preferences
	err := s.db.WithContext(ctx).Where("agent_id = ?", agentID).First(&prefs).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Preferences{AgentID: agentID, AllowFriendInteractions: true, AllowAgentMessages: true}, nil
	}
	return prefs, err
}

func (s *Store) PutPreferences(ctx context.Context, prefs Preferences) error {
	prefs.UpdatedAt = time.Now().UnixMilli()
	return s.db.WithContext(ctx).Save(&prefs).Error
}

func ValidateInteraction(input CreateInteractionInput) error {
	input.RequestID = strings.TrimSpace(input.RequestID)
	if input.RequestID == "" || len(input.RequestID) > 128 || input.ReceiverAgentID <= 0 {
		return ErrInvalid
	}
	if _, ok := allowedEventTypes[input.EventType]; !ok {
		return ErrInvalid
	}
	if utf8.RuneCountInString(input.Payload.Message) > 200 || (input.Payload.GiftID != "" && !assetIDPattern.MatchString(input.Payload.GiftID)) || (input.Payload.EmoteID != "" && !assetIDPattern.MatchString(input.Payload.EmoteID)) {
		return ErrInvalid
	}
	if input.Payload.ReplyToInteractionID != "" {
		if len(input.Payload.ReplyToInteractionID) > 19 {
			return ErrInvalid
		}
		if id, err := strconv.ParseInt(input.Payload.ReplyToInteractionID, 10, 64); err != nil || id <= 0 {
			return ErrInvalid
		}
	}
	if input.EventType == "gift" && input.Payload.GiftID == "" || input.EventType == "emote" && input.Payload.EmoteID == "" {
		return ErrInvalid
	}
	return nil
}

func (s *Store) CreateInteraction(ctx context.Context, sender Device, input CreateInteractionInput) (Interaction, error) {
	if err := ValidateInteraction(input); err != nil || sender.AgentID == input.ReceiverAgentID {
		return Interaction{}, ErrInvalid
	}
	var relation struct{ Friends, Blocked bool }
	err := s.db.WithContext(ctx).Raw(`SELECT
		EXISTS(SELECT 1 FROM user_relations WHERE from_uid = ? AND to_uid = ? AND rel_type = 1) AS friends,
		EXISTS(SELECT 1 FROM user_relations WHERE ((from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?)) AND rel_type = 2) AS blocked`,
		sender.AgentID, input.ReceiverAgentID, sender.AgentID, input.ReceiverAgentID, input.ReceiverAgentID, sender.AgentID).Scan(&relation).Error
	if err != nil {
		return Interaction{}, err
	}
	if relation.Blocked {
		return Interaction{}, ErrBlocked
	}
	if !relation.Friends {
		return Interaction{}, ErrNotFriends
	}
	prefs, err := s.GetPreferences(ctx, input.ReceiverAgentID)
	if err != nil {
		return Interaction{}, err
	}
	if !prefs.AllowFriendInteractions || prefs.DoNotDisturb {
		return Interaction{}, ErrDisabled
	}
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		return Interaction{}, ErrInvalid
	}
	ttl := input.TTL
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	if ttl > MaxTTL {
		ttl = MaxTTL
	}
	now := time.Now().UnixMilli()
	interaction := Interaction{RequestID: strings.TrimSpace(input.RequestID), SenderAgentID: sender.AgentID, SenderDeviceID: sender.DeviceID, ReceiverAgentID: input.ReceiverAgentID, EventType: input.EventType, Payload: JSONPayload(payload), CreatedAt: now, ExpiresAt: now + ttl.Milliseconds()}
	if err := s.db.WithContext(ctx).Create(&interaction).Error; err != nil {
		var existing Interaction
		if lookupErr := s.db.WithContext(ctx).Where("sender_agent_id = ? AND request_id = ?", sender.AgentID, interaction.RequestID).First(&existing).Error; lookupErr == nil {
			if existing.ReceiverAgentID != interaction.ReceiverAgentID || existing.EventType != interaction.EventType || string(existing.Payload) != string(interaction.Payload) {
				return Interaction{}, ErrConflict
			}
			return existing, nil
		}
		return Interaction{}, err
	}
	if s.rdb != nil {
		_ = s.rdb.Publish(ctx, fmt.Sprintf("pet:push:%d", input.ReceiverAgentID), interaction.InteractionID).Err()
	}
	return interaction, nil
}

func (s *Store) ListInteractions(ctx context.Context, receiverAgentID, cursor int64, limit int) ([]Interaction, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	var interactions []Interaction
	err := s.db.WithContext(ctx).Where("receiver_agent_id = ? AND interaction_id > ? AND expires_at > ? AND acknowledged_at IS NULL", receiverAgentID, cursor, time.Now().UnixMilli()).Order("interaction_id ASC").Limit(limit).Find(&interactions).Error
	return interactions, err
}

func (s *Store) Acknowledge(ctx context.Context, receiverAgentID, interactionID int64) error {
	now := time.Now().UnixMilli()
	result := s.db.WithContext(ctx).Model(&Interaction{}).Where("interaction_id = ? AND receiver_agent_id = ?", interactionID, receiverAgentID).Where("acknowledged_at IS NULL").Update("acknowledged_at", now)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		var count int64
		if err := s.db.WithContext(ctx).Model(&Interaction{}).Where("interaction_id = ? AND receiver_agent_id = ?", interactionID, receiverAgentID).Count(&count).Error; err != nil {
			return err
		}
		if count == 0 {
			return ErrNotFound
		}
	}
	return nil
}
