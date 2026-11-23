package petws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/hertz-contrib/websocket"
	"github.com/redis/go-redis/v9"

	"eigenflux_server/pkg/logger"
	petstore "eigenflux_server/pkg/pet"
)

const (
	closeReplaced   = 4002
	petPingInterval = 30 * time.Second
	petPongWait     = 45 * time.Second
)

type Handler struct {
	store    *petstore.Store
	rdb      *redis.Client
	hub      *Hub
	upgrader *websocket.HertzUpgrader
}

func New(store *petstore.Store, rdb *redis.Client) *Handler {
	return &Handler{store: store, rdb: rdb, hub: Global, upgrader: &websocket.HertzUpgrader{CheckOrigin: func(*app.RequestContext) bool { return true }}}
}

func (h *Handler) Serve(ctx context.Context, c *app.RequestContext) {
	token := c.Query("token")
	device, err := h.store.AuthenticateDevice(ctx, token)
	if err != nil {
		status, code := http.StatusServiceUnavailable, "PET_DEVICE_AUTH_UNAVAILABLE"
		if errors.Is(err, petstore.ErrUnauthorized) {
			status, code = http.StatusUnauthorized, "PET_DEVICE_AUTH_INVALID"
		}
		c.JSON(status, map[string]interface{}{"error": map[string]string{"code": code, "message": "pet device authentication failed"}})
		c.Abort()
		return
	}
	cursor, err := strconv.ParseInt(defaultValue(c.Query("cursor"), "0"), 10, 64)
	if err != nil || cursor < 0 {
		c.JSON(http.StatusBadRequest, map[string]interface{}{"error": map[string]string{"code": "PET_CURSOR_INVALID", "message": "cursor must be a non-negative decimal integer"}})
		c.Abort()
		return
	}
	err = h.upgrader.Upgrade(c, func(ws *websocket.Conn) {
		connectionContext, cancel := context.WithCancel(context.Background())
		defer cancel()
		connection := &Connection{AgentID: device.AgentID, DeviceID: device.DeviceID, Conn: ws, Done: make(chan struct{})}
		if old := h.hub.Register(connection); old != nil {
			old.WriteMu.Lock()
			_ = old.Conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(closeReplaced, "same pet device reconnected"))
			old.WriteMu.Unlock()
			_ = old.Conn.Close()
		}
		defer func() {
			h.hub.Unregister(connection)
			_ = ws.Close()
		}()
		logger.Default().Info("pet ws: connected", "agentID", device.AgentID, "deviceID", device.DeviceID, "cursor", cursor)
		go h.pushLoop(connectionContext, cancel, connection, cursor)
		go h.pingLoop(connectionContext, cancel, connection)
		ws.SetReadDeadline(time.Now().Add(petPongWait))
		ws.SetPongHandler(func(string) error { return ws.SetReadDeadline(time.Now().Add(petPongWait)) })
		for {
			if _, _, readErr := ws.ReadMessage(); readErr != nil {
				logger.Default().Info("pet ws: disconnected", "agentID", device.AgentID, "deviceID", device.DeviceID, "err", readErr)
				return
			}
		}
	})
	if err != nil {
		logger.Ctx(ctx).Error("pet ws: upgrade failed", "agentID", device.AgentID, "deviceID", device.DeviceID, "err", err)
	}
}

func (h *Handler) pushLoop(ctx context.Context, cancel context.CancelFunc, connection *Connection, cursor int64) {
	var wake <-chan *redis.Message
	var pubsub *redis.PubSub
	if h.rdb != nil {
		pubsub = h.rdb.Subscribe(ctx, fmt.Sprintf("pet:push:%d", connection.AgentID))
		defer pubsub.Close()
		wake = pubsub.Channel()
	}
	poll := time.NewTicker(15 * time.Second)
	defer poll.Stop()
	flush := func() bool {
		for {
			items, err := h.store.ListInteractions(ctx, connection.AgentID, cursor, 100)
			if err != nil {
				logger.Default().Error("pet ws: fetch failed", "agentID", connection.AgentID, "err", err)
				return true
			}
			if len(items) == 0 {
				return true
			}
			for _, item := range items {
				payload, _ := json.Marshal(map[string]interface{}{"type": "pet.interaction", "data": item})
				connection.WriteMu.Lock()
				err = connection.Conn.WriteMessage(websocket.TextMessage, payload)
				connection.WriteMu.Unlock()
				if err != nil {
					cancel()
					return false
				}
				cursor = item.InteractionID
			}
			if len(items) < 100 {
				return true
			}
		}
	}
	if !flush() {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-connection.Done:
			return
		case <-wake:
			if !flush() {
				return
			}
		case <-poll.C:
			if !flush() {
				return
			}
		}
	}
}

func (h *Handler) pingLoop(ctx context.Context, cancel context.CancelFunc, connection *Connection) {
	ticker := time.NewTicker(petPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-connection.Done:
			return
		case <-ticker.C:
			connection.WriteMu.Lock()
			err := connection.Conn.WriteMessage(websocket.PingMessage, nil)
			connection.WriteMu.Unlock()
			if err != nil {
				cancel()
				return
			}
		}
	}
}

func defaultValue(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
