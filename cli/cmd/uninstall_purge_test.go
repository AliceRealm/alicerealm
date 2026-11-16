package cmd

import (
	"github.com/AliceRealm/alicerealm/cli/internal/auth"
	"github.com/AliceRealm/alicerealm/cli/internal/config"
	"github.com/AliceRealm/alicerealm/cli/internal/maintenance"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestUninstallPurgeHomeAndLinkBoundary(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, ".alicerealm")
	outside := filepath.Join(base, "outside")
	for _, path := range []string{filepath.Join(home, "servers", "prod", "credentials.json"), filepath.Join(home, "servers", "prod", "data", "history.json"), filepath.Join(home, "config.json"), outside} {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	lock := filepath.Join(home, "watch", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.lock")
	if err := os.MkdirAll(filepath.Dir(lock), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lock, []byte("lock"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(home, "linked-data")); err != nil {
		t.Skip(err)
	}
	home, _ = filepath.EvalSymlinks(home)
	o := uninstallObservation{Executable: filepath.Join(base, "alicerealm"), Homes: []installationHome{{Home: home}}}
	if err := o.purgeHomes(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(home, "servers"), filepath.Join(home, "config.json"), filepath.Join(home, "linked-data")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("retained data %s: %v", path, err)
		}
	}
	for _, path := range []string{lock, outside} {
		if _, err := os.Stat(path); err != nil {
			t.Fatal(err)
		}
	}
}
func TestUninstallPurgeValidatesAllHomesBeforeRemoval(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, ".alicerealm")
	if err := os.MkdirAll(home, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(home, "credentials.json")
	if err := os.WriteFile(marker, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	o := uninstallObservation{Homes: []installationHome{{Home: home}, {Home: base}}}
	if err := o.purgeHomes(); err == nil {
		t.Fatal("foreign directory accepted")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("removed before complete validation", err)
	}
}

func TestFinalizerRejectsLinkedHomeBeforeRemovingOriginal(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(base, "outside")
	home := filepath.Join(base, ".alicerealm")
	bin := filepath.Join(base, "original")
	if err := os.MkdirAll(outside, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("original"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, home); err != nil {
		t.Skip(err)
	}
	o := uninstallObservation{Executable: bin, Homes: []installationHome{{Home: home}}}
	if err := o.removeOriginal(); err == nil {
		t.Fatal("linked Home accepted")
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatal("original removed before validating Home", err)
	}
	o.audit("partial", "uninstall_failed")
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatal("outside Home mutated", err)
	}
}

func TestUninstallTerminalFollowsDataCleanup(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "removed", true: "partial"}[fail], func(t *testing.T) {
			restore := config.UseHomeDir(config.HomeDir())
			defer restore()
			config.SetHomeDir(filepath.Join(t.TempDir(), ".alicerealm"))
			home := config.HomeDir()
			var received []maintenance.Event
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req struct {
					Events []maintenance.Event `json:"events"`
				}
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
					t.Error(err)
				}
				received = append(received, req.Events...)
				if r.Header.Get("Authorization") != "Bearer fixture-token" {
					t.Error("missing captured credentials")
				}
				if !fail {
					if _, err := os.Stat(filepath.Join(home, "config.json")); !os.IsNotExist(err) {
						t.Error("success reported before data cleanup")
					}
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"code":0,"data":{}}`))
			}))
			defer srv.Close()
			cfg := config.Config{DefaultServer: "test", Servers: []config.Server{{Name: "test", Endpoint: srv.URL}}}
			if err := cfg.Save(); err != nil {
				t.Fatal(err)
			}
			home, _ = filepath.EvalSymlinks(home)
			config.SetHomeDir(home)
			if err := auth.SaveV2Credentials("test", &auth.V2Credentials{AgentID: "42", AccessToken: "fixture-token", RefreshToken: "fixture-refresh", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}); err != nil {
				t.Fatal(err)
			}
			o := newUninstallObservation(filepath.Join(filepath.Dir(home), "alicerealm"), "manual", "not_provided", "")
			o.Homes = []installationHome{{Home: home}}
			o.discoverScopes()
			if len(o.Scopes) != 1 {
				t.Fatalf("expected authenticated scope, got %d", len(o.Scopes))
			}
			if fail {
				o.Homes = append(o.Homes, installationHome{Home: filepath.Dir(home)})
			}
			err := o.finishAndPurge("removed", "")
			if (err != nil) != fail {
				t.Fatalf("cleanup result %v", err)
			}
			expected := map[bool]string{false: "removed", true: "partial"}[fail]
			if len(received) != 1 || received[0].Result != expected {
				t.Fatalf("wrong terminal events: %+v", received)
			}
			if !fail {
				if _, err := os.Stat(home); !os.IsNotExist(err) {
					t.Fatal("terminal upload recreated Home", err)
				}
			}
		})
	}
}

func TestUninstallPartialStillClearsLocalData(t *testing.T) {
	restore := config.UseHomeDir(config.HomeDir())
	defer restore()
	home := filepath.Join(t.TempDir(), ".alicerealm")
	if err := os.MkdirAll(home, 0700); err != nil {
		t.Fatal(err)
	}
	home, _ = filepath.EvalSymlinks(home)
	config.SetHomeDir(home)
	if err := os.WriteFile(filepath.Join(home, "credentials.json"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	o := newUninstallObservation(filepath.Join(filepath.Dir(home), "alicerealm"), "manual", "not_provided", "")
	o.Homes = []installationHome{{Home: home}}
	o.Partial = true
	if err := o.finishAndPurge("partial", "managed_content_preserved"); err != nil {
		t.Fatal(err)
	}
	if o.Result != "partial" {
		t.Fatalf("wrong result: %s", o.Result)
	}
	if _, err := os.Lstat(home); !os.IsNotExist(err) {
		t.Fatalf("partial retained or recreated Home: %v", err)
	}
}
