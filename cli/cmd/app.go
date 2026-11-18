package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/AliceRealm/alicerealm/cli/internal/config"
	"github.com/AliceRealm/alicerealm/cli/internal/output"
	"github.com/spf13/cobra"
)

type appBridgeState struct {
	Version     int    `json:"version"`
	PID         int    `json:"pid"`
	BaseURL     string `json:"base_url"`
	BridgeToken string `json:"bridge_token"`
	StartedAt   int64  `json:"started_at"`
}

type appPermissionEvent struct {
	ID        string `json:"id"`
	Stage     string `json:"stage"`
	Status    string `json:"status"`
	Message   string `json:"message"`
	CreatedAt int64  `json:"created_at"`
}

type appPermission struct {
	ID         string               `json:"id"`
	Kind       string               `json:"kind"`
	Title      string               `json:"title"`
	Summary    string               `json:"summary"`
	SourceHost string               `json:"source_host"`
	AgentLabel string               `json:"agent_label"`
	Operations []string             `json:"operations"`
	Status     string               `json:"status"`
	CreatedAt  int64                `json:"created_at"`
	ExpiresAt  int64                `json:"expires_at"`
	DecidedAt  *int64               `json:"decided_at"`
	Events     []appPermissionEvent `json:"events"`
}

type appEnvelope[T any] struct {
	Data  T `json:"data"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

var appHTTPClient = &http.Client{Timeout: 10 * time.Second}

func appBridgeStatePath() string {
	return filepath.Join(config.HomeDir(), "app", "bridge.json")
}

func loadAppBridge() (appBridgeState, error) {
	var state appBridgeState
	data, err := os.ReadFile(appBridgeStatePath())
	if err != nil {
		if os.IsNotExist(err) {
			return state, errors.New("AliceRealm App is not running; open the local App first")
		}
		return state, fmt.Errorf("read AliceRealm App bridge: %w", err)
	}
	if len(data) > 16<<10 || json.Unmarshal(data, &state) != nil || state.Version != 1 || strings.TrimSpace(state.BridgeToken) == "" {
		return state, errors.New("AliceRealm App bridge state is invalid; restart the local App")
	}
	u, err := url.Parse(state.BaseURL)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return state, errors.New("AliceRealm App bridge URL is invalid")
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return state, errors.New("AliceRealm App bridge must use a loopback address")
	}
	return state, nil
}

func appBridgeJSON[T any](ctx context.Context, state appBridgeState, method, path string, body interface{}) (T, error) {
	var zero T
	var encoded io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return zero, err
		}
		encoded = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(state.BaseURL, "/")+path, encoded)
	if err != nil {
		return zero, err
	}
	request.Header.Set("Authorization", "Bearer "+state.BridgeToken)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := appHTTPClient.Do(request)
	if err != nil {
		return zero, fmt.Errorf("connect to AliceRealm App: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return zero, err
	}
	var envelope appEnvelope[T]
	if json.Unmarshal(data, &envelope) != nil {
		return zero, fmt.Errorf("AliceRealm App returned HTTP %d with an invalid response", response.StatusCode)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || envelope.Error != nil {
		if envelope.Error != nil && envelope.Error.Message != "" {
			return zero, fmt.Errorf("AliceRealm App: %s", envelope.Error.Message)
		}
		return zero, fmt.Errorf("AliceRealm App returned HTTP %d", response.StatusCode)
	}
	return envelope.Data, nil
}

func waitAppPermission(ctx context.Context, state appBridgeState, id string, timeout time.Duration) (appPermission, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		permission, err := appBridgeJSON[appPermission](ctx, state, http.MethodGet, "/bridge/v1/requests/"+url.PathEscape(id), nil)
		if err != nil {
			return permission, err
		}
		switch permission.Status {
		case "approved":
			return permission, nil
		case "denied", "expired", "cancelled":
			return permission, fmt.Errorf("AliceRealm App permission %s", permission.Status)
		}
		select {
		case <-ctx.Done():
			return permission, errors.New("timed out waiting for AliceRealm App approval")
		case <-ticker.C:
		}
	}
}

func localAppLoginURL(baseURL, dashboardURL string) (string, error) {
	remote, err := url.Parse(dashboardURL)
	if err != nil || remote.Scheme == "" || remote.Host == "" {
		return "", errors.New("AliceRealm returned an invalid dashboard link")
	}
	local, err := url.Parse(baseURL)
	if err != nil || local.Scheme != "http" || local.Host == "" {
		return "", errors.New("AliceRealm App returned an invalid local URL")
	}
	remote.Scheme, remote.Host = local.Scheme, local.Host
	return remote.String(), nil
}

func newAppCommand() *cobra.Command {
	root := &cobra.Command{
		Use:   "app",
		Short: "Connect the current Agent to the local AliceRealm App",
		Long:  "Use the local AliceRealm App as the approval and progress surface for this Agent. The App itself does not run an Agent.",
	}
	status := &cobra.Command{
		Use:   "status",
		Short: "Check the loopback AliceRealm App bridge",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			state, err := loadAppBridge()
			if err != nil {
				return err
			}
			data, err := appBridgeJSON[map[string]interface{}](cmd.Context(), state, http.MethodGet, "/bridge/v1/status", nil)
			if err != nil {
				return err
			}
			output.PrintData(data, resolveFormat())
			return nil
		},
	}
	request := &cobra.Command{
		Use:   "request",
		Short: "Ask the user to approve one fixed AliceRealm permission in the local App",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			kind, _ := cmd.Flags().GetString("kind")
			host, _ := cmd.Flags().GetString("source-host")
			label, _ := cmd.Flags().GetString("agent-label")
			operations, _ := cmd.Flags().GetStringArray("operation")
			wait, _ := cmd.Flags().GetBool("wait")
			timeout, _ := cmd.Flags().GetDuration("timeout")
			state, err := loadAppBridge()
			if err != nil {
				return err
			}
			permission, err := appBridgeJSON[appPermission](cmd.Context(), state, http.MethodPost, "/bridge/v1/requests", map[string]interface{}{
				"kind": kind, "source_host": host, "agent_label": label, "operations": operations,
			})
			if err != nil {
				return err
			}
			if wait {
				permission, err = waitAppPermission(cmd.Context(), state, permission.ID, timeout)
				if err != nil {
					output.PrintData(permission, resolveFormat())
					return err
				}
			}
			output.PrintData(permission, resolveFormat())
			return nil
		},
	}
	request.Flags().String("kind", "", "install_skills|connect_network|notifications|recurring_check|execute_alicerealm|host_rules|profile_prefill")
	request.Flags().String("source-host", "agent", "requesting Agent host, such as codex or claude-code")
	request.Flags().String("agent-label", "current Agent", "short user-visible Agent label")
	request.Flags().StringArray("operation", nil, "exact user-visible operation; repeat for multiple operations")
	request.Flags().Bool("wait", false, "wait for the user to approve or deny the request")
	request.Flags().Duration("timeout", 10*time.Minute, "maximum approval wait when --wait is set")
	_ = request.MarkFlagRequired("kind")

	progress := &cobra.Command{
		Use:   "progress",
		Short: "Report installation progress to an existing App permission request",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			id, _ := cmd.Flags().GetString("request")
			stage, _ := cmd.Flags().GetString("stage")
			status, _ := cmd.Flags().GetString("status")
			message, _ := cmd.Flags().GetString("message")
			state, err := loadAppBridge()
			if err != nil {
				return err
			}
			permission, err := appBridgeJSON[appPermission](cmd.Context(), state, http.MethodPost, "/bridge/v1/requests/"+url.PathEscape(id)+"/events", map[string]string{
				"stage": stage, "status": status, "message": message,
			})
			if err != nil {
				return err
			}
			output.PrintData(permission, resolveFormat())
			return nil
		},
	}
	progress.Flags().String("request", "", "permission request ID")
	progress.Flags().String("stage", "", "stable progress stage name")
	progress.Flags().String("status", "", "pending|running|completed|failed|blocked|skipped")
	progress.Flags().String("message", "", "short user-visible progress message")
	_ = progress.MarkFlagRequired("request")
	_ = progress.MarkFlagRequired("stage")
	_ = progress.MarkFlagRequired("status")

	login := &cobra.Command{
		Use:   "login",
		Short: "Create a one-time Agent login link for the running local App",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			state, err := loadAppBridge()
			if err != nil {
				return err
			}
			link, err := createDashboardLoginLink(serverFlag)
			if err != nil {
				return err
			}
			link.URL, err = localAppLoginURL(state.BaseURL, link.URL)
			if err != nil {
				return err
			}
			output.PrintMessage("Local AliceRealm App login link (single use):")
			output.PrintData(link, resolveFormat())
			return nil
		},
	}

	root.AddCommand(status, request, progress, login)
	return root
}

func init() {
	rootCmd.AddCommand(newAppCommand())
}
