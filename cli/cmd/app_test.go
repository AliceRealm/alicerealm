package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/AliceRealm/alicerealm/cli/internal/config"
)

func writeAppBridgeFixture(t *testing.T, state appBridgeState) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(appBridgeStatePath()), 0700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(appBridgeStatePath(), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestLoadAppBridgeRequiresLoopback(t *testing.T) {
	restore := config.UseHomeDir(t.TempDir())
	defer restore()
	writeAppBridgeFixture(t, appBridgeState{Version: 1, BaseURL: "https://example.com", BridgeToken: "secret"})
	if _, err := loadAppBridge(); err == nil {
		t.Fatal("accepted a non-loopback App bridge")
	}
}

func TestAppBridgeRequestWaitAndProgress(t *testing.T) {
	const token = "bridge-test-token"
	status := "pending"
	events := []appPermissionEvent{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+token {
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/bridge/v1/requests":
			_ = json.NewEncoder(response).Encode(appEnvelope[appPermission]{Data: appPermission{ID: "request-1", Kind: "install_skills", Status: status}})
		case request.Method == http.MethodGet && request.URL.Path == "/bridge/v1/requests/request-1":
			_ = json.NewEncoder(response).Encode(appEnvelope[appPermission]{Data: appPermission{ID: "request-1", Kind: "install_skills", Status: status, Events: events}})
		case request.Method == http.MethodPost && request.URL.Path == "/bridge/v1/requests/request-1/events":
			var event appPermissionEvent
			_ = json.NewDecoder(request.Body).Decode(&event)
			events = append(events, event)
			_ = json.NewEncoder(response).Encode(appEnvelope[appPermission]{Data: appPermission{ID: "request-1", Status: status, Events: events}})
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	restore := config.UseHomeDir(t.TempDir())
	defer restore()
	writeAppBridgeFixture(t, appBridgeState{Version: 1, BaseURL: server.URL, BridgeToken: token})
	state, err := loadAppBridge()
	if err != nil {
		t.Fatal(err)
	}
	created, err := appBridgeJSON[appPermission](t.Context(), state, http.MethodPost, "/bridge/v1/requests", map[string]string{"kind": "install_skills"})
	if err != nil || created.ID != "request-1" {
		t.Fatalf("created=%+v err=%v", created, err)
	}
	go func() {
		time.Sleep(80 * time.Millisecond)
		status = "approved"
	}()
	approved, err := waitAppPermission(t.Context(), state, created.ID, 2*time.Second)
	if err != nil || approved.Status != "approved" {
		t.Fatalf("approved=%+v err=%v", approved, err)
	}
	progress, err := appBridgeJSON[appPermission](t.Context(), state, http.MethodPost, "/bridge/v1/requests/request-1/events", map[string]string{
		"stage": "skills_sync", "status": "completed", "message": "done",
	})
	if err != nil || len(progress.Events) != 1 || progress.Events[0].Stage != "skills_sync" {
		t.Fatalf("progress=%+v err=%v", progress, err)
	}
}

func TestWaitAppPermissionStopsOnDenial(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(appEnvelope[appPermission]{Data: appPermission{ID: "request-2", Status: "denied"}})
	}))
	defer server.Close()
	state := appBridgeState{Version: 1, BaseURL: server.URL, BridgeToken: "token"}
	if _, err := waitAppPermission(t.Context(), state, "request-2", time.Second); err == nil {
		t.Fatal("denied request did not stop waiting")
	}
}

func TestLocalAppLoginURLPreservesHandoffSecret(t *testing.T) {
	got, err := localAppLoginURL(
		"http://127.0.0.1:4181",
		"https://app.alicerealm.com/dashboard/handoff?ticket=efht_test#nonce=secret",
	)
	if err != nil {
		t.Fatal(err)
	}
	want := "http://127.0.0.1:4181/dashboard/handoff?ticket=efht_test#nonce=secret"
	if got != want {
		t.Fatalf("local login URL = %q, want %q", got, want)
	}
}
