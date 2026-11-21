package website_test

import (
	"io"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --- E2E tests (require running API gateway) ---

func TestInstallDocumentIsPublished(t *testing.T) {
	resp, err := http.Get(websiteBaseURL + "/install.md")
	if err != nil {
		t.Skipf("API gateway not running: %v", err)
		return
	}
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.Contains(t, string(body), "# Install AliceRealm")
}

func TestSkillEntryIsRetired(t *testing.T) {
	resp, err := http.Get(websiteBaseURL + "/skill.md")
	if err != nil {
		t.Skipf("API gateway not running: %v", err)
		return
	}
	defer resp.Body.Close()
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestReferenceEndpointsAreRetired(t *testing.T) {
	for _, module := range []string{"auth", "onboarding", "feed", "publish", "message", "relations"} {
		t.Run(module, func(t *testing.T) {
			resp, err := http.Get(websiteBaseURL + "/references/" + module + ".md")
			if err != nil {
				t.Skipf("API gateway not running: %v", err)
				return
			}
			defer resp.Body.Close()
			assert.Equal(t, http.StatusNotFound, resp.StatusCode)
		})
	}
}
