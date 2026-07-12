package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSelfhostEnvExampleIncludesCommitTokenSecret(t *testing.T) {
	t.Parallel()

	envExamplePath := filepath.Join("..", "..", "..", "..", "deploy", "selfhost", ".env.example")
	content, err := os.ReadFile(envExamplePath)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", envExamplePath, err)
	}

	if !strings.Contains(string(content), "SELFHOST_API_COMMIT_TOKEN_SECRET=") {
		t.Fatalf("%s is missing SELFHOST_API_COMMIT_TOKEN_SECRET", envExamplePath)
	}
}

func TestSelfhostEnvExampleIncludesTrustedProxyConfig(t *testing.T) {
	t.Parallel()

	envExamplePath := filepath.Join("..", "..", "..", "..", "deploy", "selfhost", ".env.example")
	content, err := os.ReadFile(envExamplePath)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", envExamplePath, err)
	}

	if !strings.Contains(string(content), "SELFHOST_API_TRUSTED_PROXY_CIDRS=") {
		t.Fatalf("%s is missing SELFHOST_API_TRUSTED_PROXY_CIDRS", envExamplePath)
	}
}
