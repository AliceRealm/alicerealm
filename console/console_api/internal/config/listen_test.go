package config

import "testing"

func TestListenAddrUsesConfiguredAddress(t *testing.T) {
	cfg := &Config{ConsoleApiPort: 8090, ServiceBindAddress: "127.0.0.1"}
	if got := cfg.ListenAddr(); got != "127.0.0.1:8090" {
		t.Fatalf("ListenAddr() = %q, want %q", got, "127.0.0.1:8090")
	}
}

func TestListenAddrPreservesWildcardDefault(t *testing.T) {
	cfg := &Config{ConsoleApiPort: 8090}
	if got := cfg.ListenAddr(); got != ":8090" {
		t.Fatalf("ListenAddr() = %q, want %q", got, ":8090")
	}
}
