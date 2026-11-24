package consolev2

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/cloudwego/hertz/pkg/app"
	redis "github.com/redis/go-redis/v9"

	"eigenflux_server/pkg/pet"
)

type petCreateDeviceRequest struct {
	DeviceName string `json:"device_name"`
	Platform   string `json:"platform"`
}

type petExchangePairingRequest struct {
	PairingSecret string `json:"pairing_secret"`
}

type petPreferenceRequest struct {
	AllowFriendInteractions bool `json:"allow_friend_interactions"`
	AllowAgentMessages      bool `json:"allow_agent_messages"`
	DoNotDisturb            bool `json:"do_not_disturb"`
}

type petCreateInteractionRequest struct {
	RequestID       string                 `json:"request_id"`
	ReceiverAgentID string                 `json:"receiver_agent_id"`
	EventType       string                 `json:"event_type"`
	Payload         pet.InteractionPayload `json:"payload"`
	TTLSeconds      int64                  `json:"ttl_seconds,omitempty"`
}

func (s *Service) petStore() *pet.Store { return pet.NewStore(s.db, s.redisClient) }

var petPairingRateScript = redis.NewScript(`
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if count > tonumber(ARGV[2]) then return 0 end
return 1
`)

func (s *Service) allowPetPairingCreate(ctx context.Context, clientIPHash string) (bool, error) {
	if s.redisClient == nil {
		return false, pet.ErrUnavailable
	}
	allowed, err := petPairingRateScript.Run(ctx, s.redisClient, []string{"console:v2:pet-pairing:ip:" + clientIPHash}, 60, 20).Int()
	return allowed == 1, err
}

func (s *Service) createPetPairing(ctx context.Context, c *app.RequestContext) {
	allowed, err := s.allowPetPairingCreate(ctx, s.clientIPHash(c))
	if err != nil {
		fail(c, http.StatusServiceUnavailable, "PET_PAIRING_UNAVAILABLE", "pet pairing is temporarily unavailable", nil)
		return
	}
	if !allowed {
		fail(c, http.StatusTooManyRequests, "PET_PAIRING_RATE_LIMITED", "too many pet pairing attempts", nil)
		return
	}
	var request petCreateDeviceRequest
	if err := decodeBody(c, &request); err != nil {
		fail(c, http.StatusBadRequest, "PET_PAIRING_INVALID", "device_name and platform are required", nil)
		return
	}
	grant, err := s.petStore().CreatePairing(ctx, request.DeviceName, request.Platform)
	if err != nil {
		if errors.Is(err, pet.ErrInvalid) {
			fail(c, http.StatusBadRequest, "PET_PAIRING_INVALID", "device_name or platform is invalid", nil)
			return
		}
		fail(c, http.StatusServiceUnavailable, "PET_PAIRING_UNAVAILABLE", "pet pairing is temporarily unavailable", nil)
		return
	}
	dashboardURL := s.publicURL + "/dashboard/settings?pet_pair=" + url.QueryEscape(grant.PairingID)
	reply(c, http.StatusCreated, map[string]interface{}{"pairing": grant.Pairing, "pairing_secret": grant.PairingSecret, "dashboard_url": dashboardURL})
}

func (s *Service) getPetPairing(ctx context.Context, c *app.RequestContext) {
	pairing, err := s.petStore().GetPairing(ctx, c.Param("pairing_id"))
	if err != nil {
		if errors.Is(err, pet.ErrExpired) || errors.Is(err, pet.ErrNotFound) {
			fail(c, http.StatusNotFound, "PET_PAIRING_NOT_FOUND", "pet pairing was not found or expired", nil)
			return
		}
		fail(c, http.StatusServiceUnavailable, "PET_PAIRING_UNAVAILABLE", "pet pairing is temporarily unavailable", nil)
		return
	}
	reply(c, http.StatusOK, pairing)
}

func (s *Service) approvePetPairing(ctx context.Context, c *app.RequestContext) {
	id, ok := agentID(c)
	if !ok {
		fail(c, http.StatusUnauthorized, "CONSOLE_SESSION_REQUIRED", "Console V2 session is required", nil)
		return
	}
	device, err := s.petStore().ApprovePairing(ctx, id, c.Param("pairing_id"))
	if err != nil {
		switch {
		case errors.Is(err, pet.ErrExpired), errors.Is(err, pet.ErrNotFound):
			fail(c, http.StatusNotFound, "PET_PAIRING_NOT_FOUND", "pet pairing was not found or expired", nil)
		case errors.Is(err, pet.ErrPairingUsed):
			fail(c, http.StatusConflict, "PET_PAIRING_ALREADY_USED", "pet pairing was already approved", nil)
		default:
			fail(c, http.StatusServiceUnavailable, "PET_PAIRING_APPROVE_FAILED", "pet pairing could not be approved", nil)
		}
		return
	}
	reply(c, http.StatusOK, map[string]interface{}{"device": device, "approved": true})
}

func (s *Service) exchangePetPairing(ctx context.Context, c *app.RequestContext) {
	var request petExchangePairingRequest
	if err := decodeBody(c, &request); err != nil {
		fail(c, http.StatusBadRequest, "PET_PAIRING_INVALID", "pairing_secret is required", nil)
		return
	}
	device, token, err := s.petStore().ExchangePairing(ctx, c.Param("pairing_id"), request.PairingSecret)
	if err != nil {
		switch {
		case errors.Is(err, pet.ErrPending):
			fail(c, http.StatusConflict, "PET_PAIRING_PENDING", "pet pairing is waiting for owner approval", nil)
		case errors.Is(err, pet.ErrUnauthorized):
			fail(c, http.StatusUnauthorized, "PET_PAIRING_SECRET_INVALID", "pet pairing secret is invalid", nil)
		case errors.Is(err, pet.ErrExpired), errors.Is(err, pet.ErrPairingUsed):
			fail(c, http.StatusGone, "PET_PAIRING_EXPIRED", "pet pairing expired or was already exchanged", nil)
		default:
			fail(c, http.StatusServiceUnavailable, "PET_PAIRING_EXCHANGE_FAILED", "pet pairing could not be exchanged", nil)
		}
		return
	}
	reply(c, http.StatusOK, map[string]interface{}{"device": device, "device_token": token, "token_displayed_once": true})
}

func (s *Service) createPetDevice(ctx context.Context, c *app.RequestContext) {
	id, ok := agentID(c)
	if !ok {
		fail(c, http.StatusUnauthorized, "CONSOLE_SESSION_REQUIRED", "Console V2 session is required", nil)
		return
	}
	var request petCreateDeviceRequest
	if err := decodeBody(c, &request); err != nil {
		fail(c, http.StatusBadRequest, "PET_DEVICE_INVALID", "device_name and platform are required", nil)
		return
	}
	device, token, err := s.petStore().CreateDevice(ctx, id, request.DeviceName, request.Platform)
	if err != nil {
		if errors.Is(err, pet.ErrInvalid) {
			fail(c, http.StatusBadRequest, "PET_DEVICE_INVALID", "device_name or platform is invalid", nil)
			return
		}
		fail(c, http.StatusInternalServerError, "PET_DEVICE_CREATE_FAILED", "could not create pet device", nil)
		return
	}
	reply(c, http.StatusCreated, map[string]interface{}{"device": device, "device_token": token, "token_displayed_once": true})
}

func (s *Service) listPetDevices(ctx context.Context, c *app.RequestContext) {
	id, _ := agentID(c)
	devices, err := s.petStore().ListDevices(ctx, id)
	if err != nil {
		fail(c, http.StatusInternalServerError, "PET_DEVICES_READ_FAILED", "could not read pet devices", nil)
		return
	}
	reply(c, http.StatusOK, map[string]interface{}{"devices": devices})
}

func (s *Service) revokePetDevice(ctx context.Context, c *app.RequestContext) {
	id, _ := agentID(c)
	err := s.petStore().RevokeDevice(ctx, id, c.Param("device_id"))
	if errors.Is(err, pet.ErrNotFound) {
		fail(c, http.StatusNotFound, "PET_DEVICE_NOT_FOUND", "pet device was not found", nil)
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, "PET_DEVICE_REVOKE_FAILED", "could not revoke pet device", nil)
		return
	}
	reply(c, http.StatusOK, map[string]bool{"revoked": true})
}

func (s *Service) getPetPreferences(ctx context.Context, c *app.RequestContext) {
	id, _ := agentID(c)
	prefs, err := s.petStore().GetPreferences(ctx, id)
	if err != nil {
		fail(c, http.StatusInternalServerError, "PET_PREFERENCES_READ_FAILED", "could not read pet preferences", nil)
		return
	}
	reply(c, http.StatusOK, prefs)
}

func (s *Service) putPetPreferences(ctx context.Context, c *app.RequestContext) {
	id, _ := agentID(c)
	var request petPreferenceRequest
	if err := decodeBody(c, &request); err != nil {
		fail(c, http.StatusBadRequest, "PET_PREFERENCES_INVALID", "pet preferences are invalid", nil)
		return
	}
	prefs := pet.Preferences{AgentID: id, AllowFriendInteractions: request.AllowFriendInteractions, AllowAgentMessages: request.AllowAgentMessages, DoNotDisturb: request.DoNotDisturb}
	if err := s.petStore().PutPreferences(ctx, prefs); err != nil {
		fail(c, http.StatusInternalServerError, "PET_PREFERENCES_WRITE_FAILED", "could not update pet preferences", nil)
		return
	}
	prefs, _ = s.petStore().GetPreferences(ctx, id)
	reply(c, http.StatusOK, prefs)
}

func (s *Service) petDeviceAuth() app.HandlerFunc {
	return func(ctx context.Context, c *app.RequestContext) {
		header := string(c.GetHeader("Authorization"))
		if !strings.HasPrefix(header, "Bearer ") {
			fail(c, http.StatusUnauthorized, "PET_DEVICE_AUTH_REQUIRED", "pet device bearer token is required", nil)
			c.Abort()
			return
		}
		device, err := s.petStore().AuthenticateDevice(ctx, strings.TrimPrefix(header, "Bearer "))
		if err != nil {
			if errors.Is(err, pet.ErrUnauthorized) {
				fail(c, http.StatusUnauthorized, "PET_DEVICE_AUTH_INVALID", "pet device bearer token is invalid or revoked", nil)
			} else {
				fail(c, http.StatusServiceUnavailable, "PET_DEVICE_AUTH_UNAVAILABLE", "pet device authentication is temporarily unavailable", nil)
			}
			c.Abort()
			return
		}
		c.Set("pet_device", device)
		c.Set("agent_id", device.AgentID)
		c.Next(ctx)
	}
}

func petDevice(c *app.RequestContext) (pet.Device, bool) {
	value, ok := c.Get("pet_device")
	device, typeOK := value.(pet.Device)
	return device, ok && typeOK
}

func (s *Service) createPetInteraction(ctx context.Context, c *app.RequestContext) {
	device, _ := petDevice(c)
	var request petCreateInteractionRequest
	if err := decodeBody(c, &request); err != nil {
		fail(c, http.StatusBadRequest, "PET_INTERACTION_INVALID", "pet interaction body is invalid", nil)
		return
	}
	receiverID, err := strconv.ParseInt(request.ReceiverAgentID, 10, 64)
	if err != nil || receiverID <= 0 {
		fail(c, http.StatusBadRequest, "PET_INTERACTION_INVALID", "receiver_agent_id must be a positive decimal string", nil)
		return
	}
	interaction, err := s.petStore().CreateInteraction(ctx, device, pet.CreateInteractionInput{RequestID: request.RequestID, ReceiverAgentID: receiverID, EventType: request.EventType, Payload: request.Payload, TTL: time.Duration(request.TTLSeconds) * time.Second})
	if err != nil {
		switch {
		case errors.Is(err, pet.ErrInvalid):
			fail(c, http.StatusBadRequest, "PET_INTERACTION_INVALID", "pet interaction type or payload is invalid", nil)
		case errors.Is(err, pet.ErrNotFriends):
			fail(c, http.StatusForbidden, "PET_FRIEND_REQUIRED", "pet interactions are available between friends only", nil)
		case errors.Is(err, pet.ErrBlocked):
			fail(c, http.StatusForbidden, "PET_INTERACTION_BLOCKED", "pet interaction is blocked", nil)
		case errors.Is(err, pet.ErrDisabled):
			fail(c, http.StatusConflict, "PET_INTERACTION_DISABLED", "the receiving pet is not accepting interactions", nil)
		case errors.Is(err, pet.ErrConflict):
			fail(c, http.StatusConflict, "PET_REQUEST_CONFLICT", "request_id was already used for a different interaction", nil)
		default:
			fail(c, http.StatusInternalServerError, "PET_INTERACTION_CREATE_FAILED", "could not create pet interaction", nil)
		}
		return
	}
	reply(c, http.StatusCreated, interaction)
}

func (s *Service) listPetInteractions(ctx context.Context, c *app.RequestContext) {
	device, _ := petDevice(c)
	cursor, err := strconv.ParseInt(defaultString(c.Query("cursor"), "0"), 10, 64)
	if err != nil || cursor < 0 {
		fail(c, http.StatusBadRequest, "PET_CURSOR_INVALID", "cursor must be a non-negative decimal integer", nil)
		return
	}
	limit, err := strconv.Atoi(defaultString(c.Query("limit"), "50"))
	if err != nil || limit < 1 || limit > 100 {
		fail(c, http.StatusBadRequest, "PET_LIMIT_INVALID", "limit must be between 1 and 100", nil)
		return
	}
	interactions, err := s.petStore().ListInteractions(ctx, device.AgentID, cursor, limit)
	if err != nil {
		fail(c, http.StatusInternalServerError, "PET_INTERACTIONS_READ_FAILED", "could not read pet interactions", nil)
		return
	}
	next := cursor
	if len(interactions) > 0 {
		next = interactions[len(interactions)-1].InteractionID
	}
	reply(c, http.StatusOK, map[string]interface{}{"interactions": interactions, "next_cursor": strconv.FormatInt(next, 10)})
}

func (s *Service) acknowledgePetInteraction(ctx context.Context, c *app.RequestContext) {
	device, _ := petDevice(c)
	id, err := strconv.ParseInt(c.Param("interaction_id"), 10, 64)
	if err != nil || id <= 0 {
		fail(c, http.StatusBadRequest, "PET_INTERACTION_ID_INVALID", "interaction_id is invalid", nil)
		return
	}
	err = s.petStore().Acknowledge(ctx, device.AgentID, id)
	if errors.Is(err, pet.ErrNotFound) {
		fail(c, http.StatusNotFound, "PET_INTERACTION_NOT_FOUND", "pet interaction was not found", nil)
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, "PET_INTERACTION_ACK_FAILED", "could not acknowledge pet interaction", nil)
		return
	}
	reply(c, http.StatusOK, map[string]bool{"acknowledged": true})
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
