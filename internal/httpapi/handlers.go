package httpapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"

	"oopz/internal/auth"
	"oopz/internal/models"
	"oopz/internal/notify"
	"oopz/internal/realtime"
	"oopz/internal/store"
)

type Handler struct {
	store      *store.Store
	hub        *realtime.Hub
	auth       *auth.TokenManager
	rdb        *redis.Client
	mail       *notify.Mailer
	iceServers []map[string]any
}

// NewHandler 创建 HTTP 处理器，并注入统一的 ICE 配置来源。
func NewHandler(s *store.Store, hub *realtime.Hub, authManager *auth.TokenManager, rdb *redis.Client, mailer *notify.Mailer, iceServers []map[string]any) *Handler {
	return &Handler{store: s, hub: hub, auth: authManager, rdb: rdb, mail: mailer, iceServers: iceServers}
}

func (h *Handler) Healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) CreateGuestUser(c *gin.Context) {
	var req struct {
		DisplayName string `json:"displayName"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}

	user, err := h.store.CreateGuestUser(req.DisplayName)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	domainID, err := h.store.GetDefaultDomainID()
	if err == nil {
		_ = h.store.EnsureDomainMembership(domainID, user.ID, "member")
	}

	c.JSON(http.StatusOK, user)
}

func (h *Handler) Register(c *gin.Context) {
	var req struct {
		DisplayName string `json:"displayName"`
		Email       string `json:"email"`
		Password    string `json:"password"`
		Code        string `json:"code"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	req.Email = normalizeEmail(req.Email)
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	req.Code = strings.TrimSpace(req.Code)
	if req.DisplayName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "displayName is required"})
		return
	}
	if err := validateEmail(req.Email); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid email"})
		return
	}
	if len(strings.TrimSpace(req.Password)) < 6 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "password must be at least 6 characters"})
		return
	}
	if req.Code == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "verification code is required"})
		return
	}
	code, err := h.readVerificationCode(c.Request.Context(), req.Email)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if code != req.Code {
		c.JSON(http.StatusBadRequest, gin.H{"error": "验证码错误"})
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "password hashing failed"})
		return
	}

	user, err := h.store.CreateAccount(req.Email, req.DisplayName, string(hash))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.clearVerificationCode(c.Request.Context(), req.Email)

	token, err := h.auth.Issue(user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token issue failed"})
		return
	}

	domainID, err := h.store.GetDefaultDomainID()
	if err == nil {
		_ = h.store.EnsureDomainMembership(domainID, user.ID, "member")
	}

	c.JSON(http.StatusOK, models.AuthResponse{Token: token, User: user})
}

func (h *Handler) Login(c *gin.Context) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	req.Email = normalizeEmail(req.Email)

	user, passwordHash, err := h.store.GetUserAuthByEmail(req.Email)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid email or password"})
		return
	}
	if passwordHash == "" || bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(req.Password)) != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid email or password"})
		return
	}

	token, err := h.auth.Issue(user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token issue failed"})
		return
	}
	c.JSON(http.StatusOK, models.AuthResponse{Token: token, User: user})
}

func (h *Handler) SendVerificationCode(c *gin.Context) {
	var req struct {
		Email string `json:"email"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}

	email := normalizeEmail(req.Email)
	if err := validateEmail(email); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid email"})
		return
	}

	if _, _, err := h.store.GetUserAuthByEmail(email); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "该邮箱已注册"})
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "检查邮箱状态失败"})
		return
	}

	ctx := c.Request.Context()
	cooldownKey := verificationCooldownKey(email)
	exists, err := h.rdb.Exists(ctx, cooldownKey).Result()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "验证码发送失败"})
		return
	}
	if exists > 0 {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "验证码发送过于频繁，请稍后再试"})
		return
	}

	code, err := generateVerificationCode()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "验证码生成失败"})
		return
	}

	if !h.mail.Enabled() {
		log.Printf("email disabled, verification code for %s: %s", email, code)
	} else {
		go func() {
			if sendErr := h.mail.SendVerificationCode(email, code); sendErr != nil {
				log.Printf("send verification email failed: %v", sendErr)
			}
		}()
	}

	if err := h.rdb.Set(ctx, verificationCodeKey(email), code, 5*time.Minute).Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "验证码存储失败"})
		return
	}
	if err := h.rdb.Set(ctx, cooldownKey, "1", 60*time.Second).Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "验证码发送失败"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":    "验证码已发送",
		"cooldown":   60,
		"expiresIn":  300,
		"emailDebug": !h.mail.Enabled(),
	})
}

func (h *Handler) Me(c *gin.Context) {
	user, err := h.currentUser(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, user)
}

func generateVerificationCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func normalizeEmail(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func validateEmail(value string) error {
	_, err := mail.ParseAddress(value)
	return err
}

func verificationCodeKey(email string) string {
	return fmt.Sprintf("verification_code:%s", email)
}

func verificationCooldownKey(email string) string {
	return fmt.Sprintf("verification_code_cooldown:%s", email)
}

func (h *Handler) readVerificationCode(ctx context.Context, email string) (string, error) {
	code, err := h.rdb.Get(ctx, verificationCodeKey(email)).Result()
	if errors.Is(err, redis.Nil) || strings.TrimSpace(code) == "" {
		return "", errors.New("验证码已过期或无效")
	}
	if err != nil {
		return "", err
	}
	return code, nil
}

func (h *Handler) clearVerificationCode(ctx context.Context, email string) {
	if h.rdb == nil {
		return
	}
	_ = h.rdb.Del(ctx, verificationCodeKey(email), verificationCooldownKey(email)).Err()
}

// Bootstrap 返回前端首屏所需聚合数据与 ICE 配置。
func (h *Handler) Bootstrap(c *gin.Context) {
	user, err := h.currentUser(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}

	userDomains, err := h.store.ListVisibleDomains(user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if len(userDomains) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "no domains available"})
		return
	}

	domainID, err := strconv.ParseInt(c.DefaultQuery("domainId", "0"), 10, 64)
	if err != nil || domainID == 0 {
		domainID = userDomains[0].ID
	}
	if err := h.store.EnsureDomainMembership(domainID, user.ID, "member"); err != nil {
		h.respondMembershipError(c, err)
		return
	}

	channelID, _ := strconv.ParseInt(c.DefaultQuery("channelId", "0"), 10, 64)

	_, channels, err := h.store.ListCategories(domainID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	channelIDs := make([]int64, 0, len(channels))
	for _, channel := range channels {
		if channel.Type == "voice" {
			channelIDs = append(channelIDs, channel.ID)
		}
	}

	data, err := h.store.BuildBootstrap(c.Request.Context(), user.ID, domainID, channelID, h.hub.OnlineCounts(channelIDs), h.iceServers)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *Handler) ListDomains(c *gin.Context) {
	user, err := h.currentUser(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	domains, err := h.store.ListVisibleDomains(user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, domains)
}

func (h *Handler) CreateDomain(c *gin.Context) {
	user, err := h.currentUser(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		AccentColor string `json:"accentColor"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	domain, err := h.store.CreateDomain(user.ID, req.Name, req.Description, req.AccentColor)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, domain)
}

func (h *Handler) ChannelMessages(c *gin.Context) {
	user, err := h.currentUser(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}

	domainID, err := strconv.ParseInt(c.Param("domainId"), 10, 64)
	if err != nil || domainID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid domainId"})
		return
	}
	if err := h.ensureDomainMember(domainID, user.ID); err != nil {
		h.respondMembershipError(c, err)
		return
	}

	channelID, err := strconv.ParseInt(c.Param("channelId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid channelId"})
		return
	}

	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "60"))
	var beforeID *int64
	if beforeRaw := strings.TrimSpace(c.Query("beforeId")); beforeRaw != "" {
		value, parseErr := strconv.ParseInt(beforeRaw, 10, 64)
		if parseErr != nil || value <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid beforeId"})
			return
		}
		beforeID = &value
	}

	messages, err := h.store.ListMessagesBefore(channelID, limit, beforeID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, messages)
}

func (h *Handler) GetDomain(c *gin.Context) {
	user, err := h.currentUser(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	domainID, err := strconv.ParseInt(c.Param("domainId"), 10, 64)
	if err != nil || domainID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid domainId"})
		return
	}
	if err := h.ensureDomainMember(domainID, user.ID); err != nil {
		h.respondMembershipError(c, err)
		return
	}
	domain, err := h.store.GetDomain(domainID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "domain not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, domain)
}

func (h *Handler) UpdateDomain(c *gin.Context) {
	user, err := h.currentUser(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	domainID, err := strconv.ParseInt(c.Param("domainId"), 10, 64)
	if err != nil || domainID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid domainId"})
		return
	}
	if err := h.ensureDomainMember(domainID, user.ID); err != nil {
		h.respondMembershipError(c, err)
		return
	}
	if err := h.ensureDomainOwner(domainID, user.ID); err != nil {
		h.respondMembershipError(c, err)
		return
	}

	var req struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		AccentColor *string `json:"accentColor"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	domain, err := h.store.UpdateDomain(domainID, req.Name, req.Description, req.AccentColor)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "domain not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, domain)
}

func (h *Handler) DomainMembers(c *gin.Context) {
	user, err := h.currentUser(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	domainID, err := strconv.ParseInt(c.Param("domainId"), 10, 64)
	if err != nil || domainID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid domainId"})
		return
	}
	if err := h.ensureDomainMember(domainID, user.ID); err != nil {
		h.respondMembershipError(c, err)
		return
	}
	members, err := h.store.ListDomainMembers(domainID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, members)
}

func (h *Handler) DomainChannels(c *gin.Context) {
	user, err := h.currentUser(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	domainID, err := strconv.ParseInt(c.Param("domainId"), 10, 64)
	if err != nil || domainID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid domainId"})
		return
	}
	if err := h.ensureDomainMember(domainID, user.ID); err != nil {
		h.respondMembershipError(c, err)
		return
	}
	categories, channels, err := h.store.ListCategories(domainID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	channelIDs := make([]int64, 0, len(channels))
	for _, channel := range channels {
		if channel.Type == "voice" {
			channelIDs = append(channelIDs, channel.ID)
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"categories":   categories,
		"channels":     channels,
		"onlineCounts": h.hub.OnlineCounts(channelIDs),
	})
}

func (h *Handler) DomainPresence(c *gin.Context) {
	user, err := h.currentUser(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	domainID, err := strconv.ParseInt(c.Param("domainId"), 10, 64)
	if err != nil || domainID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid domainId"})
		return
	}
	if err := h.ensureDomainMember(domainID, user.ID); err != nil {
		h.respondMembershipError(c, err)
		return
	}

	_, channels, err := h.store.ListCategories(domainID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	voiceChannelIDs := make([]int64, 0, len(channels))
	screeningChannelIDs := make([]int64, 0, len(channels))
	for _, channel := range channels {
		if channel.Type == "voice" {
			voiceChannelIDs = append(voiceChannelIDs, channel.ID)
			continue
		}
		if channel.Type == "screening" {
			screeningChannelIDs = append(screeningChannelIDs, channel.ID)
		}
	}

	c.JSON(http.StatusOK, h.hub.DomainPresence(domainID, voiceChannelIDs, screeningChannelIDs))
}

func (h *Handler) CreateCategory(c *gin.Context) {
	user, err := h.currentUser(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	domainID, err := strconv.ParseInt(c.Param("domainId"), 10, 64)
	if err != nil || domainID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid domainId"})
		return
	}
	if err := h.ensureDomainMember(domainID, user.ID); err != nil {
		h.respondMembershipError(c, err)
		return
	}
	if err := h.ensureDomainOwner(domainID, user.ID); err != nil {
		h.respondMembershipError(c, err)
		return
	}
	var req struct {
		Name     string `json:"name"`
		Position int    `json:"position"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	category, err := h.store.CreateCategory(domainID, req.Name, req.Position)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, category)
}

func (h *Handler) CreateChannel(c *gin.Context) {
	user, err := h.currentUser(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	domainID, err := strconv.ParseInt(c.Param("domainId"), 10, 64)
	if err != nil || domainID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid domainId"})
		return
	}
	if err := h.ensureDomainMember(domainID, user.ID); err != nil {
		h.respondMembershipError(c, err)
		return
	}
	if err := h.ensureDomainOwner(domainID, user.ID); err != nil {
		h.respondMembershipError(c, err)
		return
	}
	var req struct {
		CategoryID *int64 `json:"categoryId"`
		Name       string `json:"name"`
		Type       string `json:"type"`
		Topic      string `json:"topic"`
		Position   int    `json:"position"`
		MaxMembers int    `json:"maxMembers"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	channel, err := h.store.CreateChannel(domainID, req.CategoryID, req.Name, req.Type, req.Topic, req.Position, req.MaxMembers)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, channel)
}

func (h *Handler) UpdateChannel(c *gin.Context) {
	user, err := h.currentUser(c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	channelID, err := strconv.ParseInt(c.Param("channelId"), 10, 64)
	if err != nil || channelID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid channelId"})
		return
	}
	channel, err := h.store.GetChannel(channelID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if channel == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not found"})
		return
	}
	if err := h.ensureDomainMember(channel.DomainID, user.ID); err != nil {
		h.respondMembershipError(c, err)
		return
	}
	if err := h.ensureDomainOwner(channel.DomainID, user.ID); err != nil {
		h.respondMembershipError(c, err)
		return
	}
	var req struct {
		Name       *string `json:"name"`
		Topic      *string `json:"topic"`
		Position   *int    `json:"position"`
		MaxMembers *int    `json:"maxMembers"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	updated, err := h.store.UpdateChannel(channelID, req.Name, req.Topic, req.Position, req.MaxMembers)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "channel not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, updated)
}

func (h *Handler) ServeWS(c *gin.Context) {
	if upgrade := strings.ToLower(c.GetHeader("Upgrade")); upgrade != "websocket" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "websocket upgrade required"})
		return
	}
	if err := h.hub.ServeWS(c.Writer, c.Request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	}
}

func (h *Handler) currentUser(c *gin.Context) (models.User, error) {
	token := bearerToken(c.GetHeader("Authorization"))
	if token == "" {
		token = c.Query("token")
	}
	if token == "" {
		return models.User{}, errors.New("missing token")
	}

	userID, err := h.auth.Parse(token)
	if err != nil {
		return models.User{}, err
	}
	return h.store.GetUserByID(userID)
}

func bearerToken(header string) string {
	if header == "" {
		return ""
	}
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

func (h *Handler) ensureDomainMember(domainID, userID int64) error {
	return h.store.EnsureDomainMembership(domainID, userID, "member")
}

func (h *Handler) ensureDomainOwner(domainID, userID int64) error {
	role, err := h.store.GetUserDomainRole(domainID, userID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("forbidden")
		}
		return err
	}
	if role != "owner" {
		return errors.New("owner_only")
	}
	return nil
}

func (h *Handler) respondMembershipError(c *gin.Context, err error) {
	if err == nil {
		return
	}
	if err.Error() == "forbidden" {
		c.JSON(http.StatusForbidden, gin.H{"error": "user is not a member of this domain"})
		return
	}
	if err.Error() == "owner_only" {
		c.JSON(http.StatusForbidden, gin.H{"error": "only domain owner can perform this action"})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
}
