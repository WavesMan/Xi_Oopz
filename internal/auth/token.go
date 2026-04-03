package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type TokenManager struct {
	secret []byte
	ttl    time.Duration
}

func NewTokenManager(secret string, ttl time.Duration) *TokenManager {
	return &TokenManager{
		secret: []byte(secret),
		ttl:    ttl,
	}
}

func (m *TokenManager) Issue(userID int64) (string, error) {
	expiresAt := time.Now().Add(m.ttl).Unix()
	payload := fmt.Sprintf("%d:%d", userID, expiresAt)
	signature := m.sign(payload)
	token := fmt.Sprintf("%s:%s", payload, signature)
	return base64.RawURLEncoding.EncodeToString([]byte(token)), nil
}

func (m *TokenManager) Parse(token string) (int64, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return 0, fmt.Errorf("decode token: %w", err)
	}

	parts := strings.Split(string(raw), ":")
	if len(parts) != 3 {
		return 0, fmt.Errorf("invalid token format")
	}

	payload := strings.Join(parts[:2], ":")
	if !hmac.Equal([]byte(parts[2]), []byte(m.sign(payload))) {
		return 0, fmt.Errorf("invalid token signature")
	}

	userID, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid user id")
	}
	expiresAt, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid token expiry")
	}
	if time.Now().Unix() > expiresAt {
		return 0, fmt.Errorf("token expired")
	}
	return userID, nil
}

func (m *TokenManager) sign(payload string) string {
	mac := hmac.New(sha256.New, m.secret)
	_, _ = mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
