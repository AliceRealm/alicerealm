package main

import (
	"testing"

	"eigenflux_server/pkg/config"
)

func TestRunOperatorCommandRouting(t *testing.T) {
	cfg := &config.Config{}
	if handled, err := runOperatorCommand(cfg, nil); handled || err != nil {
		t.Fatalf("ordinary service start must not be handled: handled=%t err=%v", handled, err)
	}
	if handled, err := runOperatorCommand(cfg, []string{"unknown"}); handled || err != nil {
		t.Fatalf("unknown arguments must remain on the service path: handled=%t err=%v", handled, err)
	}
	if handled, err := runOperatorCommand(cfg, []string{officialBootstrapCommand, "--limit", "-1"}); !handled || err == nil {
		t.Fatalf("negative limit must be rejected: handled=%t err=%v", handled, err)
	}
}
