package petws

import (
	"sync"

	"github.com/hertz-contrib/websocket"
)

type Connection struct {
	AgentID  int64
	DeviceID string
	Conn     *websocket.Conn
	Done     chan struct{}
	WriteMu  sync.Mutex
}

type Hub struct {
	mu          sync.RWMutex
	connections map[int64]map[string]*Connection
}

func NewHub() *Hub { return &Hub{connections: make(map[int64]map[string]*Connection)} }

var Global = NewHub()

// Register replaces only an older connection from the same device. Other pet
// devices, the Agent stream, and browser streams remain connected.
func (h *Hub) Register(connection *Connection) *Connection {
	h.mu.Lock()
	defer h.mu.Unlock()
	devices := h.connections[connection.AgentID]
	if devices == nil {
		devices = make(map[string]*Connection)
		h.connections[connection.AgentID] = devices
	}
	old := devices[connection.DeviceID]
	if old != nil {
		close(old.Done)
	}
	devices[connection.DeviceID] = connection
	return old
}

func (h *Hub) Unregister(connection *Connection) {
	h.mu.Lock()
	defer h.mu.Unlock()
	devices := h.connections[connection.AgentID]
	if devices == nil || devices[connection.DeviceID] != connection {
		return
	}
	delete(devices, connection.DeviceID)
	if len(devices) == 0 {
		delete(h.connections, connection.AgentID)
	}
}

func (h *Hub) Count(agentID int64) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.connections[agentID])
}
