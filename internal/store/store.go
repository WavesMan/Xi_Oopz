// noinspection SqlNoDataSourceInspection
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"
	"time"

	"gorm.io/gorm"
	"oopz/internal/models"
)

type Store struct {
	orm *gorm.DB
	db  *sql.DB
}

func New(db *gorm.DB) *Store {
	sqlDB, _ := db.DB()
	return &Store{orm: db, db: sqlDB}
}

func (s *Store) Migrate() error {
	return s.orm.AutoMigrate(
		&userRecord{},
		&userCredentialRecord{},
		&domainRecord{},
		&channelCategoryRecord{},
		&channelRecord{},
		&domainMemberRecord{},
		&messageRecord{},
	)
}

func (s *Store) EnsureSeedData() error {
	var count int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM domains").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	now := time.Now().UTC()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.Exec(`
		INSERT INTO domains (slug, name, description, accent_color, created_at)
		VALUES (?, ?, ?, ?, ?)
	`, "oopz-lobby", "Oopz Lobby", "Discord-like social base for team calls, game rooms, and screen sharing.", "#6de2d2", now)
	if err != nil {
		return err
	}
	domainID, err := res.LastInsertId()
	if err != nil {
		return err
	}

	categories := []struct {
		name     string
		position int
		channels []struct {
			name        string
			channelType string
			topic       string
			position    int
			maxMembers  int
		}
	}{
		{
			name:     "HOME",
			position: 1,
			channels: []struct {
				name        string
				channelType string
				topic       string
				position    int
				maxMembers  int
			}{
				{name: "home", channelType: "text", topic: "Welcome channel and coordination notes.", position: 1, maxMembers: 0},
			},
		},
		{
			name:     "GAMING",
			position: 2,
			channels: []struct {
				name        string
				channelType string
				topic       string
				position    int
				maxMembers  int
			}{
				{name: "squad-voice", channelType: "voice", topic: "Small-room voice call for party coordination.", position: 1, maxMembers: 6},
				{name: "scrim-room", channelType: "voice", topic: "Competitive practice and screen share review.", position: 2, maxMembers: 6},
			},
		},
		{
			name:     "WATCH PARTY",
			position: 3,
			channels: []struct {
				name        string
				channelType string
				topic       string
				position    int
				maxMembers  int
			}{
				{name: "movie-room", channelType: "screening", topic: "Sync a direct video URL and watch together.", position: 1, maxMembers: 24},
			},
		},
		{
			name:     "CHATTING",
			position: 4,
			channels: []struct {
				name        string
				channelType string
				topic       string
				position    int
				maxMembers  int
			}{
				{name: "general-chat", channelType: "text", topic: "Casual chat, links, and text updates.", position: 1, maxMembers: 0},
			},
		},
	}

	for _, category := range categories {
		res, err := tx.Exec(`
			INSERT INTO channel_categories (domain_id, name, position, created_at)
			VALUES (?, ?, ?, ?)
		`, domainID, category.name, category.position, now)
		if err != nil {
			return err
		}
		categoryID, err := res.LastInsertId()
		if err != nil {
			return err
		}

		for _, channel := range category.channels {
			if _, err := tx.Exec(`
				INSERT INTO channels (domain_id, category_id, name, channel_type, topic, position, max_members, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`, domainID, categoryID, channel.name, channel.channelType, channel.topic, channel.position, channel.maxMembers, now); err != nil {
				return err
			}
		}
	}

	return tx.Commit()
}

func (s *Store) CreateGuestUser(displayName string) (models.User, error) {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		displayName = fmt.Sprintf("Guest-%d", time.Now().Unix()%10000)
	}

	base := strings.ToLower(displayName)
	base = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= '0' && r <= '9':
			return r
		default:
			return '-'
		}
	}, base)
	base = strings.Trim(base, "-")
	if base == "" {
		base = "guest"
	}

	palette := []string{"#7dd3fc", "#fb7185", "#fbbf24", "#34d399", "#c084fc", "#f97316"}
	rand.Seed(time.Now().UnixNano())
	handle := fmt.Sprintf("%s-%04d", base, rand.Intn(10000))
	color := palette[rand.Intn(len(palette))]
	now := time.Now().UTC()

	res, err := s.db.Exec(`
		INSERT INTO users (handle, display_name, avatar_color, created_at)
		VALUES (?, ?, ?, ?)
	`, handle, displayName, color, now)
	if err != nil {
		return models.User{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return models.User{}, err
	}
	return s.GetUserByID(id)
}

func (s *Store) CreateAccount(email, displayName, passwordHash string) (models.User, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	displayName = strings.TrimSpace(displayName)
	if email == "" || displayName == "" || passwordHash == "" {
		return models.User{}, fmt.Errorf("missing required fields")
	}

	base := strings.Split(email, "@")[0]
	base = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= '0' && r <= '9':
			return r
		default:
			return '-'
		}
	}, base)
	base = strings.Trim(base, "-")
	if base == "" {
		base = "user"
	}

	palette := []string{"#7dd3fc", "#fb7185", "#fbbf24", "#34d399", "#c084fc", "#f97316"}
	handle := fmt.Sprintf("%s-%04d", base, rand.Intn(10000))
	color := palette[rand.Intn(len(palette))]
	now := time.Now().UTC()

	tx, err := s.db.Begin()
	if err != nil {
		return models.User{}, err
	}
	defer tx.Rollback()

	res, err := tx.Exec(`
		INSERT INTO users (handle, display_name, avatar_color, created_at)
		VALUES (?, ?, ?, ?)
	`, handle, displayName, color, now)
	if err != nil {
		return models.User{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return models.User{}, err
	}
	if _, err := tx.Exec(`
		INSERT INTO user_credentials (user_id, email, password_hash, created_at)
		VALUES (?, ?, ?, ?)
	`, id, email, passwordHash, now); err != nil {
		return models.User{}, err
	}
	if err := tx.Commit(); err != nil {
		return models.User{}, err
	}
	return s.GetUserByID(id)
}

func (s *Store) GetUserByID(id int64) (models.User, error) {
	var user models.User
	err := s.db.QueryRow(`
		SELECT
			u.id,
			u.handle,
			u.display_name,
			COALESCE(uc.email, ''),
			u.avatar_color,
			CASE WHEN uc.user_id IS NULL THEN TRUE ELSE FALSE END,
			COALESCE(u.created_at, UTC_TIMESTAMP())
		FROM users u
		LEFT JOIN user_credentials uc ON uc.user_id = u.id
		WHERE id = ?
	`, id).Scan(&user.ID, &user.Handle, &user.DisplayName, &user.Email, &user.AvatarColor, &user.IsGuest, &user.CreatedAt)
	return user, err
}

func (s *Store) GetUserAuthByEmail(email string) (models.User, string, error) {
	email = strings.TrimSpace(strings.ToLower(email))

	var (
		user         models.User
		passwordHash string
	)
	err := s.db.QueryRow(`
		SELECT
			u.id,
			u.handle,
			u.display_name,
			uc.email,
			u.avatar_color,
			FALSE,
			COALESCE(u.created_at, UTC_TIMESTAMP()),
			uc.password_hash
		FROM user_credentials uc
		JOIN users u ON u.id = uc.user_id
		WHERE uc.email = ?
	`, email).Scan(&user.ID, &user.Handle, &user.DisplayName, &user.Email, &user.AvatarColor, &user.IsGuest, &user.CreatedAt, &passwordHash)
	return user, passwordHash, err
}

func (s *Store) GetDefaultDomainID() (int64, error) {
	var id int64
	err := s.db.QueryRow(`SELECT id FROM domains ORDER BY id ASC LIMIT 1`).Scan(&id)
	return id, err
}

func (s *Store) ListUserDomains(userID int64) ([]models.DomainSummary, error) {
	rows, err := s.db.Query(`
		SELECT
			d.id,
			d.slug,
			d.name,
			d.description,
			d.accent_color,
			COALESCE(d.created_at, UTC_TIMESTAMP()),
			dm.role
		FROM domain_members dm
		JOIN domains d ON d.id = dm.domain_id
		WHERE dm.user_id = ?
		ORDER BY dm.joined_at ASC, d.id ASC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	domains := make([]models.DomainSummary, 0)
	for rows.Next() {
		var item models.DomainSummary
		if err := rows.Scan(&item.ID, &item.Slug, &item.Name, &item.Description, &item.AccentColor, &item.CreatedAt, &item.Role); err != nil {
			return nil, err
		}
		domains = append(domains, item)
	}
	return domains, nil
}

func (s *Store) ListVisibleDomains(userID int64) ([]models.DomainSummary, error) {
	rows, err := s.db.Query(`
		SELECT
			d.id,
			d.slug,
			d.name,
			d.description,
			d.accent_color,
			COALESCE(d.created_at, UTC_TIMESTAMP()),
			COALESCE(dm.role, 'visitor')
		FROM domains d
		LEFT JOIN domain_members dm ON dm.domain_id = d.id AND dm.user_id = ?
		ORDER BY d.id ASC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	domains := make([]models.DomainSummary, 0)
	for rows.Next() {
		var item models.DomainSummary
		if err := rows.Scan(&item.ID, &item.Slug, &item.Name, &item.Description, &item.AccentColor, &item.CreatedAt, &item.Role); err != nil {
			return nil, err
		}
		domains = append(domains, item)
	}
	return domains, nil
}

func (s *Store) GetUserDomainRole(domainID, userID int64) (string, error) {
	var role string
	err := s.db.QueryRow(`
		SELECT role
		FROM domain_members
		WHERE domain_id = ? AND user_id = ?
	`, domainID, userID).Scan(&role)
	return role, err
}

func (s *Store) CreateDomain(ownerID int64, name, description, accentColor string) (models.Domain, error) {
	name = strings.TrimSpace(name)
	description = strings.TrimSpace(description)
	accentColor = strings.TrimSpace(accentColor)
	if name == "" {
		return models.Domain{}, fmt.Errorf("domain name is required")
	}
	if accentColor == "" {
		accentColor = "#6de2d2"
	}

	now := time.Now().UTC()
	baseSlug := strings.ToLower(name)
	baseSlug = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= '0' && r <= '9':
			return r
		case r >= 0x4e00 && r <= 0x9fff:
			return '-'
		default:
			return '-'
		}
	}, baseSlug)
	baseSlug = strings.Trim(baseSlug, "-")
	baseSlug = strings.Join(strings.FieldsFunc(baseSlug, func(r rune) bool { return r == '-' }), "-")
	if baseSlug == "" {
		baseSlug = "domain"
	}
	slug := fmt.Sprintf("%s-%d", baseSlug, now.Unix())

	tx, err := s.db.Begin()
	if err != nil {
		return models.Domain{}, err
	}
	defer tx.Rollback()

	res, err := tx.Exec(`
		INSERT INTO domains (slug, name, description, accent_color, created_at)
		VALUES (?, ?, ?, ?, ?)
	`, slug, name, description, accentColor, now)
	if err != nil {
		return models.Domain{}, err
	}
	domainID, err := res.LastInsertId()
	if err != nil {
		return models.Domain{}, err
	}
	if _, err := tx.Exec(`
		INSERT INTO domain_members (domain_id, user_id, role, joined_at)
		VALUES (?, ?, ?, ?)
	`, domainID, ownerID, "owner", now); err != nil {
		return models.Domain{}, err
	}

	textCategoryRes, err := tx.Exec(`
		INSERT INTO channel_categories (domain_id, name, position, created_at)
		VALUES (?, ?, ?, ?)
	`, domainID, "TEXT CHANNELS", 1, now)
	if err != nil {
		return models.Domain{}, err
	}
	textCategoryID, err := textCategoryRes.LastInsertId()
	if err != nil {
		return models.Domain{}, err
	}
	voiceCategoryRes, err := tx.Exec(`
		INSERT INTO channel_categories (domain_id, name, position, created_at)
		VALUES (?, ?, ?, ?)
	`, domainID, "VOICE CHANNELS", 2, now)
	if err != nil {
		return models.Domain{}, err
	}
	voiceCategoryID, err := voiceCategoryRes.LastInsertId()
	if err != nil {
		return models.Domain{}, err
	}
	screeningCategoryRes, err := tx.Exec(`
		INSERT INTO channel_categories (domain_id, name, position, created_at)
		VALUES (?, ?, ?, ?)
	`, domainID, "SCREENING ROOMS", 3, now)
	if err != nil {
		return models.Domain{}, err
	}
	screeningCategoryID, err := screeningCategoryRes.LastInsertId()
	if err != nil {
		return models.Domain{}, err
	}
	if _, err := tx.Exec(`
		INSERT INTO channels (domain_id, category_id, name, channel_type, topic, position, max_members, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, domainID, textCategoryID, "general", "text", "域内公共文字频道。", 1, 0, now); err != nil {
		return models.Domain{}, err
	}
	if _, err := tx.Exec(`
		INSERT INTO channels (domain_id, category_id, name, channel_type, topic, position, max_members, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, domainID, voiceCategoryID, "lobby", "voice", "域内默认语音频道。", 1, 16, now); err != nil {
		return models.Domain{}, err
	}
	if _, err := tx.Exec(`
		INSERT INTO channels (domain_id, category_id, name, channel_type, topic, position, max_members, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, domainID, screeningCategoryID, "movie-room", "screening", "域内默认放映室，可同步播放直链视频。", 1, 24, now); err != nil {
		return models.Domain{}, err
	}

	if err := tx.Commit(); err != nil {
		return models.Domain{}, err
	}
	return s.GetDomain(domainID)
}

func (s *Store) EnsureDomainMembership(domainID, userID int64, role string) error {
	if role == "" {
		role = "member"
	}
	_, err := s.db.Exec(`
		INSERT INTO domain_members (domain_id, user_id, role, joined_at)
		VALUES (?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE role = role, joined_at = joined_at
	`, domainID, userID, role, time.Now().UTC())
	return err
}

func (s *Store) GetDomain(domainID int64) (models.Domain, error) {
	var domain models.Domain
	err := s.db.QueryRow(`
		SELECT id, slug, name, description, accent_color, COALESCE(created_at, UTC_TIMESTAMP())
		FROM domains
		WHERE id = ?
	`, domainID).Scan(&domain.ID, &domain.Slug, &domain.Name, &domain.Description, &domain.AccentColor, &domain.CreatedAt)
	return domain, err
}

func (s *Store) UpdateDomain(domainID int64, name, description, accentColor *string) (models.Domain, error) {
	domain, err := s.GetDomain(domainID)
	if err != nil {
		return models.Domain{}, err
	}
	if name != nil {
		domain.Name = strings.TrimSpace(*name)
	}
	if description != nil {
		domain.Description = strings.TrimSpace(*description)
	}
	if accentColor != nil {
		domain.AccentColor = strings.TrimSpace(*accentColor)
	}
	if domain.Name == "" {
		return models.Domain{}, fmt.Errorf("domain name is required")
	}
	if domain.AccentColor == "" {
		return models.Domain{}, fmt.Errorf("accentColor is required")
	}
	_, err = s.db.Exec(`
		UPDATE domains
		SET name = ?, description = ?, accent_color = ?
		WHERE id = ?
	`, domain.Name, domain.Description, domain.AccentColor, domainID)
	if err != nil {
		return models.Domain{}, err
	}
	return s.GetDomain(domainID)
}

func (s *Store) IsDomainMember(domainID, userID int64) (bool, error) {
	var count int
	if err := s.db.QueryRow(`
		SELECT COUNT(*)
		FROM domain_members
		WHERE domain_id = ? AND user_id = ?
	`, domainID, userID).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

func (s *Store) ListCategories(domainID int64) ([]models.ChannelCategory, []models.Channel, error) {
	rows, err := s.db.Query(`
		SELECT id, domain_id, name, position
		FROM channel_categories
		WHERE domain_id = ?
		ORDER BY position ASC, id ASC
	`, domainID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	categories := make([]models.ChannelCategory, 0)
	index := map[int64]int{}
	for rows.Next() {
		var category models.ChannelCategory
		if err := rows.Scan(&category.ID, &category.DomainID, &category.Name, &category.Position); err != nil {
			return nil, nil, err
		}
		category.Channels = []models.Channel{}
		index[category.ID] = len(categories)
		categories = append(categories, category)
	}

	channelRows, err := s.db.Query(`
		SELECT id, domain_id, category_id, name, channel_type, topic, position, max_members
		FROM channels
		WHERE domain_id = ?
		ORDER BY position ASC, id ASC
	`, domainID)
	if err != nil {
		return nil, nil, err
	}
	defer channelRows.Close()

	allChannels := make([]models.Channel, 0)
	for channelRows.Next() {
		var (
			channel    models.Channel
			categoryID sql.NullInt64
		)
		if err := channelRows.Scan(&channel.ID, &channel.DomainID, &categoryID, &channel.Name, &channel.Type, &channel.Topic, &channel.Position, &channel.MaxMembers); err != nil {
			return nil, nil, err
		}
		if categoryID.Valid {
			value := categoryID.Int64
			channel.CategoryID = &value
		}
		allChannels = append(allChannels, channel)
		if channel.CategoryID != nil {
			if idx, ok := index[*channel.CategoryID]; ok {
				categories[idx].Channels = append(categories[idx].Channels, channel)
			}
		}
	}
	return categories, allChannels, nil
}

func (s *Store) GetChannel(channelID int64) (*models.Channel, error) {
	var (
		channel    models.Channel
		categoryID sql.NullInt64
	)
	err := s.db.QueryRow(`
		SELECT id, domain_id, category_id, name, channel_type, topic, position, max_members
		FROM channels
		WHERE id = ?
	`, channelID).Scan(&channel.ID, &channel.DomainID, &categoryID, &channel.Name, &channel.Type, &channel.Topic, &channel.Position, &channel.MaxMembers)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if categoryID.Valid {
		value := categoryID.Int64
		channel.CategoryID = &value
	}
	return &channel, nil
}

func (s *Store) CreateCategory(domainID int64, name string, position int) (models.ChannelCategory, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return models.ChannelCategory{}, fmt.Errorf("category name is required")
	}
	if position <= 0 {
		if err := s.db.QueryRow(`
			SELECT COALESCE(MAX(position), 0) + 1
			FROM channel_categories
			WHERE domain_id = ?
		`, domainID).Scan(&position); err != nil {
			return models.ChannelCategory{}, err
		}
	}

	res, err := s.db.Exec(`
		INSERT INTO channel_categories (domain_id, name, position, created_at)
		VALUES (?, ?, ?, ?)
	`, domainID, name, position, time.Now().UTC())
	if err != nil {
		return models.ChannelCategory{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return models.ChannelCategory{}, err
	}

	var category models.ChannelCategory
	err = s.db.QueryRow(`
		SELECT id, domain_id, name, position
		FROM channel_categories
		WHERE id = ?
	`, id).Scan(&category.ID, &category.DomainID, &category.Name, &category.Position)
	if err != nil {
		return models.ChannelCategory{}, err
	}
	category.Channels = []models.Channel{}
	return category, nil
}

func (s *Store) CreateChannel(domainID int64, categoryID *int64, name, channelType, topic string, position, maxMembers int) (models.Channel, error) {
	name = strings.TrimSpace(name)
	channelType = strings.TrimSpace(strings.ToLower(channelType))
	topic = strings.TrimSpace(topic)
	if name == "" {
		return models.Channel{}, fmt.Errorf("channel name is required")
	}
	if channelType != "text" && channelType != "voice" && channelType != "screening" {
		return models.Channel{}, fmt.Errorf("channel type must be text, voice, or screening")
	}
	if channelType == "text" {
		maxMembers = 0
	}
	if maxMembers < 0 {
		maxMembers = 0
	}
	if position <= 0 {
		if err := s.db.QueryRow(`
			SELECT COALESCE(MAX(position), 0) + 1
			FROM channels
			WHERE domain_id = ? AND ((category_id IS NULL AND ? IS NULL) OR category_id = ?)
		`, domainID, categoryID, categoryID).Scan(&position); err != nil {
			return models.Channel{}, err
		}
	}

	res, err := s.db.Exec(`
		INSERT INTO channels (domain_id, category_id, name, channel_type, topic, position, max_members, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, domainID, categoryID, name, channelType, topic, position, maxMembers, time.Now().UTC())
	if err != nil {
		return models.Channel{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return models.Channel{}, err
	}
	channel, err := s.GetChannel(id)
	if err != nil {
		return models.Channel{}, err
	}
	if channel == nil {
		return models.Channel{}, sql.ErrNoRows
	}
	return *channel, nil
}

func (s *Store) UpdateChannel(channelID int64, name, topic *string, position, maxMembers *int) (models.Channel, error) {
	channel, err := s.GetChannel(channelID)
	if err != nil {
		return models.Channel{}, err
	}
	if channel == nil {
		return models.Channel{}, sql.ErrNoRows
	}
	if name != nil {
		channel.Name = strings.TrimSpace(*name)
	}
	if topic != nil {
		channel.Topic = strings.TrimSpace(*topic)
	}
	if position != nil {
		channel.Position = *position
	}
	if maxMembers != nil {
		channel.MaxMembers = *maxMembers
	}
	if channel.Name == "" {
		return models.Channel{}, fmt.Errorf("channel name is required")
	}
	if channel.Type == "text" {
		channel.MaxMembers = 0
	}
	if channel.MaxMembers < 0 {
		channel.MaxMembers = 0
	}
	_, err = s.db.Exec(`
		UPDATE channels
		SET name = ?, topic = ?, position = ?, max_members = ?
		WHERE id = ?
	`, channel.Name, channel.Topic, channel.Position, channel.MaxMembers, channelID)
	if err != nil {
		return models.Channel{}, err
	}
	updated, err := s.GetChannel(channelID)
	if err != nil {
		return models.Channel{}, err
	}
	if updated == nil {
		return models.Channel{}, sql.ErrNoRows
	}
	return *updated, nil
}

func (s *Store) GetDefaultChannel(domainID int64) (*models.Channel, error) {
	row := s.db.QueryRow(`
		SELECT id
		FROM channels
		WHERE domain_id = ?
		ORDER BY CASE
			WHEN channel_type = 'text' THEN 0
			WHEN channel_type = 'screening' THEN 1
			ELSE 2
		END, position ASC, id ASC
		LIMIT 1
	`, domainID)

	var id int64
	if err := row.Scan(&id); err != nil {
		return nil, err
	}
	return s.GetChannel(id)
}

func (s *Store) ListDomainMembers(domainID int64) ([]models.DomainMember, error) {
	rows, err := s.db.Query(`
		SELECT
			u.id,
			u.handle,
			u.display_name,
			COALESCE(uc.email, ''),
			u.avatar_color,
			CASE WHEN uc.user_id IS NULL THEN TRUE ELSE FALSE END,
			COALESCE(u.created_at, UTC_TIMESTAMP()),
			dm.role
		FROM domain_members dm
		JOIN users u ON u.id = dm.user_id
		LEFT JOIN user_credentials uc ON uc.user_id = u.id
		WHERE dm.domain_id = ?
		ORDER BY u.display_name ASC
	`, domainID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	members := make([]models.DomainMember, 0)
	for rows.Next() {
		var member models.DomainMember
		if err := rows.Scan(&member.ID, &member.Handle, &member.DisplayName, &member.Email, &member.AvatarColor, &member.IsGuest, &member.CreatedAt, &member.Role); err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	return members, nil
}

func (s *Store) ListMessages(channelID int64, limit int) ([]models.Message, error) {
	return s.ListMessagesBefore(channelID, limit, nil)
}

func (s *Store) ListMessagesBefore(channelID int64, limit int, beforeID *int64) ([]models.Message, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	query := `
		SELECT
			m.id,
			m.domain_id,
			m.channel_id,
			m.user_id,
			COALESCE(u.display_name, 'System') AS user_display_name,
			COALESCE(u.avatar_color, '#8892b0') AS user_avatar_color,
			m.message_type,
			m.body,
			COALESCE(m.metadata, ''),
			COALESCE(m.created_at, UTC_TIMESTAMP())
		FROM messages m
		LEFT JOIN users u ON u.id = m.user_id
		WHERE m.channel_id = ?
	`
	args := []any{channelID}
	if beforeID != nil && *beforeID > 0 {
		query += ` AND m.id < ?`
		args = append(args, *beforeID)
	}
	query += `
		ORDER BY m.created_at DESC, m.id DESC
		LIMIT ?
	`
	args = append(args, limit)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	messages := make([]models.Message, 0)
	for rows.Next() {
		var (
			msg    models.Message
			userID sql.NullInt64
		)
		if err := rows.Scan(&msg.ID, &msg.DomainID, &msg.ChannelID, &userID, &msg.UserDisplayName, &msg.UserAvatarColor, &msg.MessageType, &msg.Body, &msg.Metadata, &msg.CreatedAt); err != nil {
			return nil, err
		}
		if userID.Valid {
			value := userID.Int64
			msg.UserID = &value
		}
		messages = append([]models.Message{msg}, messages...)
	}
	return messages, nil
}

func (s *Store) InsertMessage(domainID, channelID int64, userID *int64, messageType, body string, metadata map[string]any) (models.Message, error) {
	var rawMetadata sql.NullString
	if metadata != nil {
		bytes, err := json.Marshal(metadata)
		if err != nil {
			return models.Message{}, err
		}
		rawMetadata = sql.NullString{String: string(bytes), Valid: true}
	}

	res, err := s.db.Exec(`
		INSERT INTO messages (domain_id, channel_id, user_id, message_type, body, metadata, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, domainID, channelID, userID, messageType, body, rawMetadata, time.Now().UTC())
	if err != nil {
		return models.Message{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return models.Message{}, err
	}
	return s.GetMessage(id)
}

func (s *Store) GetMessage(messageID int64) (models.Message, error) {
	var (
		msg    models.Message
		userID sql.NullInt64
	)
	err := s.db.QueryRow(`
		SELECT
			m.id,
			m.domain_id,
			m.channel_id,
			m.user_id,
			COALESCE(u.display_name, 'System'),
			COALESCE(u.avatar_color, '#8892b0'),
			m.message_type,
			m.body,
			COALESCE(m.metadata, ''),
			COALESCE(m.created_at, UTC_TIMESTAMP())
		FROM messages m
		LEFT JOIN users u ON u.id = m.user_id
		WHERE m.id = ?
	`, messageID).Scan(&msg.ID, &msg.DomainID, &msg.ChannelID, &userID, &msg.UserDisplayName, &msg.UserAvatarColor, &msg.MessageType, &msg.Body, &msg.Metadata, &msg.CreatedAt)
	if err != nil {
		return models.Message{}, err
	}
	if userID.Valid {
		value := userID.Int64
		msg.UserID = &value
	}
	return msg, nil
}

// BuildBootstrap 聚合首屏所需数据，并附带由应用层注入的 ICE 配置。
func (s *Store) BuildBootstrap(ctx context.Context, userID, domainID, channelID int64, onlineCounts map[string]int64, stunServers []map[string]any) (models.BootstrapResponse, error) {
	user, err := s.GetUserByID(userID)
	if err != nil {
		return models.BootstrapResponse{}, err
	}

	domains, err := s.ListVisibleDomains(userID)
	if err != nil {
		return models.BootstrapResponse{}, err
	}

	domain, err := s.GetDomain(domainID)
	if err != nil {
		return models.BootstrapResponse{}, err
	}
	currentRole, err := s.GetUserDomainRole(domainID, userID)
	if err != nil {
		return models.BootstrapResponse{}, err
	}

	categories, _, err := s.ListCategories(domainID)
	if err != nil {
		return models.BootstrapResponse{}, err
	}

	var activeChannel *models.Channel
	if channelID > 0 {
		activeChannel, err = s.GetChannel(channelID)
		if err != nil {
			return models.BootstrapResponse{}, err
		}
	}
	if activeChannel == nil {
		activeChannel, err = s.GetDefaultChannel(domainID)
		if err != nil {
			return models.BootstrapResponse{}, err
		}
	}

	members, err := s.ListDomainMembers(domainID)
	if err != nil {
		return models.BootstrapResponse{}, err
	}

	messages, err := s.ListMessages(activeChannel.ID, 60)
	if err != nil {
		return models.BootstrapResponse{}, err
	}

	_ = ctx
	return models.BootstrapResponse{
		User:          user,
		Domain:        domain,
		Domains:       domains,
		CurrentRole:   currentRole,
		Categories:    categories,
		Members:       members,
		Messages:      messages,
		OnlineCounts:  onlineCounts,
		SelectedID:    activeChannel.ID,
		ActiveChannel: activeChannel,
		StunServers:   stunServers,
	}, nil
}
