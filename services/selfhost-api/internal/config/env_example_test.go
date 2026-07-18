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

func TestSelfhostComposeNetworkSettingsAreOverridable(t *testing.T) {
	t.Parallel()

	rootPath := filepath.Join("..", "..", "..", "..")
	envExample, err := os.ReadFile(filepath.Join(rootPath, "deploy", "selfhost", ".env.example"))
	if err != nil {
		t.Fatalf("ReadFile(.env.example) error = %v", err)
	}
	compose, err := os.ReadFile(filepath.Join(rootPath, "deploy", "selfhost", "docker-compose.yml"))
	if err != nil {
		t.Fatalf("ReadFile(docker-compose.yml) error = %v", err)
	}

	for _, setting := range []string{
		"SELFHOST_NETWORK_SUBNET=172.30.0.0/24",
		"SELFHOST_WEB_IP=172.30.0.2",
		"SELFHOST_API_TRUSTED_PROXY_CIDRS=172.30.0.2/32",
	} {
		if !strings.Contains(string(envExample), setting) {
			t.Fatalf(".env.example is missing default setting %s", setting)
		}
	}
	for _, expression := range []string{
		"${SELFHOST_WEB_IP:-172.30.0.2}",
		"${SELFHOST_NETWORK_SUBNET:-172.30.0.0/24}",
	} {
		if !strings.Contains(string(compose), expression) {
			t.Fatalf("docker-compose.yml is missing override expression %s", expression)
		}
	}
}

func TestSelfhostCaddyfileStripsSpoofableClientIPHeaders(t *testing.T) {
	t.Parallel()

	caddyfilePath := filepath.Join("..", "..", "..", "..", "deploy", "selfhost", "Caddyfile")
	content, err := os.ReadFile(caddyfilePath)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", caddyfilePath, err)
	}

	want := "reverse_proxy @api api:8788 {\n" +
		"      header_up -CF-Connecting-IP\n" +
		"      header_up -X-Real-IP\n"
	if !strings.Contains(string(content), want) {
		t.Fatalf("%s must strip spoofable client IP headers in the API proxy", caddyfilePath)
	}
}
