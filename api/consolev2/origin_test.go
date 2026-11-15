package consolev2

import (
	"net/http"
	"testing"

	"eigenflux_server/pkg/config"
	"github.com/cloudwego/hertz/pkg/app/server"
	"github.com/cloudwego/hertz/pkg/common/ut"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestConsoleMultipleOrigins(t *testing.T) {
	primary := "https://alicerealm.com"
	secondary := "https://www.alicerealm.com"
	for _, tc := range []struct {
		name, origin, host string
		allowed            bool
	}{
		{"primary", primary, "alicerealm.com", true},
		{"secondary", secondary, "www.alicerealm.com", true},
		{"cross trusted domains", primary, "www.alicerealm.com", false},
		{"reverse cross trusted domains", secondary, "alicerealm.com", false},
		{"unknown same host", "https://evil.test", "evil.test", false},
		{"suffix attack", "https://www.alicerealm.com.evil.test", "www.alicerealm.com.evil.test", false},
		{"insecure", "http://www.alicerealm.com", "www.alicerealm.com", false},
		{"wrong port", "https://www.alicerealm.com:444", "www.alicerealm.com:444", false},
		{"missing", "", "www.alicerealm.com", false},
		{"null", "null", "www.alicerealm.com", false},
		{"path", secondary + "/path", "www.alicerealm.com", false},
		{"query", secondary + "?", "www.alicerealm.com", false},
		{"fragment", secondary + "#", "www.alicerealm.com", false},
		{"credentials", "https://user@www.alicerealm.com", "www.alicerealm.com", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := validConsoleSameOrigin(tc.origin, tc.host, primary, secondary); got != tc.allowed {
				t.Fatalf("REST allowed=%v", got)
			}
			if got := validConsoleWebSocketRequest(tc.origin, tc.host, consoleV2WebSocketProtocol, "", primary, secondary); got != tc.allowed {
				t.Fatalf("WebSocket allowed=%v", got)
			}
		})
	}
	if validConsoleSameOrigin(secondary, "www.alicerealm.com", primary) {
		t.Fatal("secondary trusted without configuration")
	}
	if validConsoleWebSocketRequest(secondary, "www.alicerealm.com", consoleV2WebSocketProtocol, "secret", primary, secondary) {
		t.Fatal("query token accepted")
	}
	if validConsoleWebSocketRequest(secondary, "www.alicerealm.com", "legacy", "", primary, secondary) {
		t.Fatal("wrong protocol accepted")
	}
}

func TestConsoleOriginConfigurationAndLogin(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{ConsoleV2PublicURL: "https://alicerealm.com", ConsoleV2OTPPepper: "test", ConsoleV2AllowedOrigins: []string{"https://www.alicerealm.com"}}
	svc, err := NewService(db, &fixedIDGenerator{}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if svc.publicURL != cfg.ConsoleV2PublicURL || !svc.secureCookie {
		t.Fatal("canonical handoff or cookie policy changed")
	}
	h := server.New(server.WithHostPorts("127.0.0.1:0"))
	svc.Register(h)
	for _, host := range []string{"alicerealm.com", "www.alicerealm.com"} {
		status, payload, _ := performJSON(t, h, http.MethodPost, "https://"+host+"/api/v2/auth/email/challenges", map[string]interface{}{}, ut.Header{Key: "Origin", Value: "https://" + host})
		if status != http.StatusBadRequest || responseErrorCode(t, payload) != "INVALID_REQUEST" {
			t.Fatalf("%s: %d %#v", host, status, payload)
		}
	}
	for _, bad := range []string{"https://*.eigenflux.net", "http://www.alicerealm.com", "https://www.alicerealm.com/path", "https://www.alicerealm.com?x=1", "https://user@www.alicerealm.com", "https://www.alicerealm.com#fragment", "null"} {
		cfg.ConsoleV2AllowedOrigins = []string{bad}
		if _, err := NewService(db, &fixedIDGenerator{}, cfg); err == nil {
			t.Fatalf("invalid configured origin accepted: %s", bad)
		}
	}
}
