package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Port          string
	HTTPSEnabled  bool
	TLSCertFile   string
	TLSKeyFile    string
	MySQLDSN      string
	RedisAddr     string
	RedisPassword string
	AuthSecret    string
	EmailEnabled  bool
	EmailHost     string
	EmailPort     string
	EmailUser     string
	EmailPassword string
	EmailFromName string
}

func LoadDotEnv(path string) error {
	file, err := os.Open(filepath.Clean(path))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer file.Close()

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

func Load() Config {
	return Config{
		Port:          env("PORT", "8080"),
		HTTPSEnabled:  envBool("HTTPS_ENABLED", false),
		TLSCertFile:   os.Getenv("TLS_CERT_FILE"),
		TLSKeyFile:    os.Getenv("TLS_KEY_FILE"),
		MySQLDSN:      env("MYSQL_DSN", "root:password@tcp(127.0.0.1:3306)/oopz?parseTime=true&multiStatements=true"),
		RedisAddr:     env("REDIS_ADDR", "127.0.0.1:6379"),
		RedisPassword: os.Getenv("REDIS_PASSWORD"),
		AuthSecret:    env("AUTH_SECRET", "oopz-dev-secret"),
		EmailEnabled:  envBool("EMAIL_ENABLED", false),
		EmailHost:     os.Getenv("EMAIL_HOST"),
		EmailPort:     env("EMAIL_PORT", "587"),
		EmailUser:     os.Getenv("EMAIL_USER"),
		EmailPassword: os.Getenv("EMAIL_PASSWORD"),
		EmailFromName: env("EMAIL_FROM_NAME", "Oopz Live"),
	}
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
