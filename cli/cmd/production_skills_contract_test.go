package cmd

import (
	"github.com/GardenVilla/alicerealm/cli/internal/skills"
	"path/filepath"
	"testing"
)

func TestProductionSkillsUseStableVersions(t *testing.T) {
	if err := skills.ValidateProductionSkillVersions(filepath.Join("..", "..", "skills")); err != nil {
		t.Fatal(err)
	}
}
