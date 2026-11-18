package config

import "testing"

func TestListenAddrUsesConfiguredAddress(t *testing.T) {
	cfg := &Config{ServiceBindAddress: "127.0.0.1"}
	if got := cfg.ListenAddr(8080); got != "127.0.0.1:8080" {
		t.Fatalf("ListenAddr() = %q, want %q", got, "127.0.0.1:8080")
	}
}

func TestListenAddrPreservesWildcardDefault(t *testing.T) {
	cfg := &Config{}
	if got := cfg.ListenAddr(8080); got != ":8080" {
		t.Fatalf("ListenAddr() = %q, want %q", got, ":8080")
	}
}
