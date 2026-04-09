package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// TestLoadDotEnvKeepsExistingEnv 验证已存在的系统环境变量不会被 .env 覆盖。
func TestLoadDotEnvKeepsExistingEnv(t *testing.T) {
	t.Setenv("WEBRTC_TURN_USERNAME", "system-user")

	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	content := "WEBRTC_TURN_USERNAME=dotenv-user\nWEBRTC_TURN_CREDENTIAL=dotenv-cred\n"
	if err := os.WriteFile(envPath, []byte(content), 0o600); err != nil {
		t.Fatalf("write temp env: %v", err)
	}

	if err := LoadDotEnv(envPath); err != nil {
		t.Fatalf("load dotenv: %v", err)
	}

	if got := os.Getenv("WEBRTC_TURN_USERNAME"); got != "system-user" {
		t.Fatalf("expected system env to win, got %q", got)
	}
	if got := os.Getenv("WEBRTC_TURN_CREDENTIAL"); got != "dotenv-cred" {
		t.Fatalf("expected dotenv fallback value, got %q", got)
	}
}

// TestSplitCSV 验证逗号分隔值的清理与去空行为。
func TestSplitCSV(t *testing.T) {
	got := splitCSV(" stun:a , , turn:b ,, turn:c ")
	want := []string{"stun:a", "turn:b", "turn:c"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("splitCSV mismatch, got=%v want=%v", got, want)
	}
}

// TestWebRTCIceServers 验证 TURN 条目仅在字段完整时下发。
func TestWebRTCIceServers(t *testing.T) {
	cfg := Config{
		WebRTCStunURLs: []string{"stun:stun1.example.com:3478", "stun:stun2.example.com:3478"},
		WebRTCTurnURLs: []string{"turn:turn.example.com:3478", "turn:turn.example.com:3478?transport=tcp"},
	}

	servers := cfg.WebRTCIceServers()
	if len(servers) != 2 {
		t.Fatalf("expected only stun entries when turn credentials missing, got %d", len(servers))
	}

	cfg.WebRTCTurnUsername = "u"
	cfg.WebRTCTurnCred = "p"
	servers = cfg.WebRTCIceServers()
	if len(servers) != 3 {
		t.Fatalf("expected stun + turn entries, got %d", len(servers))
	}

	last := servers[len(servers)-1]
	if last["username"] != "u" || last["credential"] != "p" {
		t.Fatalf("unexpected turn auth fields: %#v", last)
	}
}
