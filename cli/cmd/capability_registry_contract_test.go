package cmd

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

var registryCLIContractPattern = regexp.MustCompile(`capability\("[^"]+", "(alicerealm [^"]+)"`)

func TestCapabilityRegistryMatchesFunctionalCLILeaves(t *testing.T) {
	source, err := os.ReadFile("../../api/consolev2/capability_registry.go")
	if err != nil {
		t.Fatal(err)
	}
	registered := map[string]bool{}
	for _, match := range registryCLIContractPattern.FindAllStringSubmatch(string(source), -1) {
		words := strings.Fields(match[1])
		path := []string{"alicerealm"}
		for _, word := range words[1:] {
			if strings.HasPrefix(word, "-") {
				break
			}
			path = append(path, word)
		}
		registered[strings.Join(path, " ")] = true
	}

	functional := map[string]bool{}
	var walk func(*cobra.Command, []string)
	walk = func(command *cobra.Command, parent []string) {
		path := append(parent, command.Name())
		children := command.Commands()
		if command != rootCmd && command.Runnable() && !command.Hidden && !strings.Contains(strings.Join(path, " "), "alicerealm completion") {
			functional[strings.Join(path, " ")] = true
		}
		for _, child := range children {
			walk(child, path)
		}
	}
	walk(rootCmd, nil)

	// Local commands do not require server capability publication. Keep this
	// explicit so adding a network command still requires a catalog contract.
	localDiagnostics := map[string]bool{"alicerealm feed status": true, "alicerealm feed defer": true, "alicerealm feed next": true, "alicerealm feed recover": true, "alicerealm app status": true, "alicerealm app request": true, "alicerealm app progress": true, "alicerealm app login": true, "alicerealm watch recover": true, "alicerealm watch notices": true, "alicerealm heartbeat recovery-notice-ack": true, "alicerealm heartbeat rules": true, "alicerealm heartbeat cycle-check": true, "alicerealm heartbeat stop-check": true, "alicerealm heartbeat host-observe": true, "alicerealm heartbeat guard-setup": true, "alicerealm heartbeat permission-check": true, "alicerealm heartbeat upgrade-repair": true, "alicerealm heartbeat upgrade-repair-report": true, "alicerealm heartbeat upgrade-repair-ack": true}
	for path := range localDiagnostics {
		if !functional[path] {
			t.Fatalf("stale local diagnostic: %s", path)
		}
	}
	var missing, stale []string
	for path := range functional {
		if !registered[path] && !localDiagnostics[path] {
			missing = append(missing, path)
		}
	}
	for path := range registered {
		if !functional[path] {
			stale = append(stale, path)
		}
	}
	sort.Strings(missing)
	sort.Strings(stale)
	if len(missing) > 0 || len(stale) > 0 {
		t.Fatalf("capability registry mismatch\nmissing: %v\nstale: %v", missing, stale)
	}
}

func TestDistributedSkillsDoNotWriteSecurityThroughConfigSet(t *testing.T) {
	paths := []string{
		"../../skills/ar-profile/SKILL.md",
		"../../skills/ar-onboarding/SKILL.md",
		"../../skills/ar-onboarding/references/prefill.md",
		"../../skills/ar-broadcast/SKILL.md",
		"../../skills/ar-broadcast/references/feed.md",
	}
	for _, path := range paths {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"recurring_publish", "auto_reply_pm", "auto_comment", "show_add_friend"} {
			if strings.Contains(string(body), "config set --key "+key) {
				t.Fatalf("%s writes security key %s through config set", path, key)
			}
		}
	}
}
