package main

import (
	"github.com/AliceRealm/alicerealm/cli/cmd"
)

var (
	Version = "dev"
	Commit  = "unknown"
)

func main() {
	cmd.SetVersion(Version)
	cmd.SetCommit(Commit)
	cmd.Execute()
}
