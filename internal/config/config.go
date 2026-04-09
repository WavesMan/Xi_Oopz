package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Port               string
	MySQLDSN           string
	RedisAddr          string
	RedisPassword      string
	AuthSecret         string
	EmailEnabled       bool
	EmailHost          string
	EmailPort          string
	EmailUser          string
	EmailPassword      string
	EmailFromName      string
	WebRTCStunURLs     []string
	WebRTCTurnURLs     []string
	WebRTCTurnUsername string
	WebRTCTurnCred     string
}

func LoadDotEnv(path string) error {
	file, err := os.Open(filepath.Clean(path))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer func(file *os.File) {
		err := file.Close()
		if err != nil {
		}
	}(file)

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}

		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		if err := os.Setenv(key, value); err != nil {
			return err
		}
	}

	return scanner.Err()
}

// Load 读取运行配置，优先使用系统环境变量，缺失项再由预加载的 .env 填充。
func Load() Config {
	return Config{
		Port:               env("PORT", "8080"),
		MySQLDSN:           env("MYSQL_DSN", "root:password@tcp(127.0.0.1:3306)/oopz?parseTime=true&multiStatements=true"),
		RedisAddr:          env("REDIS_ADDR", "127.0.0.1:6379"),
		RedisPassword:      os.Getenv("REDIS_PASSWORD"),
		AuthSecret:         env("AUTH_SECRET", "oopz-dev-secret"),
		EmailEnabled:       envBool("EMAIL_ENABLED", false),
		EmailHost:          os.Getenv("EMAIL_HOST"),
		EmailPort:          env("EMAIL_PORT", "587"),
		EmailUser:          os.Getenv("EMAIL_USER"),
		EmailPassword:      os.Getenv("EMAIL_PASSWORD"),
		EmailFromName:      env("EMAIL_FROM_NAME", "Oopz Live"),
		WebRTCStunURLs:     splitCSV(os.Getenv("WEBRTC_STUN_URLS")),
		WebRTCTurnURLs:     splitCSV(os.Getenv("WEBRTC_TURN_URLS")),
		WebRTCTurnUsername: strings.TrimSpace(os.Getenv("WEBRTC_TURN_USERNAME")),
		WebRTCTurnCred:     strings.TrimSpace(os.Getenv("WEBRTC_TURN_CREDENTIAL")),
	}
}

// WebRTCIceServers 将 WebRTC 相关环境变量转换为前端可消费的 ICE 配置列表。
func (c Config) WebRTCIceServers() []map[string]any {
	servers := make([]map[string]any, 0, len(c.WebRTCStunURLs)+1)
	for _, url := range c.WebRTCStunURLs {
		servers = append(servers, map[string]any{"urls": url})
	}

	if len(c.WebRTCTurnURLs) > 0 && c.WebRTCTurnUsername != "" && c.WebRTCTurnCred != "" {
		servers = append(servers, map[string]any{
			"urls":       c.WebRTCTurnURLs,
			"username":   c.WebRTCTurnUsername,
			"credential": c.WebRTCTurnCred,
		})
	}

	return servers
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

// splitCSV 按逗号切分并清理空白项，返回去空后的字符串列表。
func splitCSV(value string) []string {
	if strings.TrimSpace(value) == "" {
		return []string{}
	}

	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		result = append(result, trimmed)
	}
	return result
}
