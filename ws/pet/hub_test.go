package petws

import "testing"

func TestHubKeepsMultipleDevicesAndReplacesOnlySameDevice(t *testing.T) {
	hub := NewHub()
	first := &Connection{AgentID: 7, DeviceID: "desktop", Done: make(chan struct{})}
	second := &Connection{AgentID: 7, DeviceID: "laptop", Done: make(chan struct{})}
	if old := hub.Register(first); old != nil {
		t.Fatal("first connection unexpectedly replaced one")
	}
	hub.Register(second)
	if got := hub.Count(7); got != 2 {
		t.Fatalf("got %d devices, want 2", got)
	}
	replacement := &Connection{AgentID: 7, DeviceID: "desktop", Done: make(chan struct{})}
	if old := hub.Register(replacement); old != first {
		t.Fatal("same-device registration did not return old connection")
	}
	select {
	case <-first.Done:
	default:
		t.Fatal("replaced connection was not stopped")
	}
	select {
	case <-second.Done:
		t.Fatal("different device was incorrectly stopped")
	default:
	}
	if got := hub.Count(7); got != 2 {
		t.Fatalf("got %d devices after replacement, want 2", got)
	}
	hub.Unregister(first)
	if got := hub.Count(7); got != 2 {
		t.Fatal("stale unregister removed replacement")
	}
	hub.Unregister(replacement)
	if got := hub.Count(7); got != 1 {
		t.Fatalf("got %d devices after unregister, want 1", got)
	}
}
