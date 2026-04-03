package store

import "time"

type userRecord struct {
	ID          int64     `gorm:"primaryKey;autoIncrement"`
	Handle      string    `gorm:"size:64;uniqueIndex;not null"`
	DisplayName string    `gorm:"column:display_name;size:64;not null"`
	AvatarColor string    `gorm:"column:avatar_color;size:16;not null"`
	CreatedAt   time.Time `gorm:"column:created_at;autoCreateTime"`
}

func (userRecord) TableName() string {
	return "users"
}

type userCredentialRecord struct {
	UserID       int64     `gorm:"column:user_id;primaryKey"`
	Email        string    `gorm:"size:255;uniqueIndex;not null"`
	PasswordHash string    `gorm:"column:password_hash;size:255;not null"`
	CreatedAt    time.Time `gorm:"column:created_at;autoCreateTime"`
}

func (userCredentialRecord) TableName() string {
	return "user_credentials"
}

type domainRecord struct {
	ID          int64     `gorm:"primaryKey;autoIncrement"`
	Slug        string    `gorm:"size:80;uniqueIndex;not null"`
	Name        string    `gorm:"size:80;not null"`
	Description string    `gorm:"size:255;not null"`
	AccentColor string    `gorm:"column:accent_color;size:16;not null"`
	CreatedAt   time.Time `gorm:"column:created_at;autoCreateTime"`
}

func (domainRecord) TableName() string {
	return "domains"
}

type channelCategoryRecord struct {
	ID        int64     `gorm:"primaryKey;autoIncrement"`
	DomainID  int64     `gorm:"column:domain_id;index;not null"`
	Name      string    `gorm:"size:80;not null"`
	Position  int       `gorm:"not null;default:0"`
	CreatedAt time.Time `gorm:"column:created_at;autoCreateTime"`
}

func (channelCategoryRecord) TableName() string {
	return "channel_categories"
}

type channelRecord struct {
	ID          int64     `gorm:"primaryKey;autoIncrement"`
	DomainID    int64     `gorm:"column:domain_id;index;not null"`
	CategoryID  *int64    `gorm:"column:category_id;index"`
	Name        string    `gorm:"size:80;not null"`
	ChannelType string    `gorm:"column:channel_type;size:16;not null"`
	Topic       string    `gorm:"size:255;not null;default:''"`
	Position    int       `gorm:"not null;default:0"`
	MaxMembers  int       `gorm:"column:max_members;not null;default:0"`
	CreatedAt   time.Time `gorm:"column:created_at;autoCreateTime"`
}

func (channelRecord) TableName() string {
	return "channels"
}

type domainMemberRecord struct {
	DomainID int64     `gorm:"column:domain_id;primaryKey"`
	UserID   int64     `gorm:"column:user_id;primaryKey"`
	Role     string    `gorm:"size:16;not null;default:member"`
	JoinedAt time.Time `gorm:"column:joined_at;autoCreateTime"`
}

func (domainMemberRecord) TableName() string {
	return "domain_members"
}

type messageRecord struct {
	ID          int64     `gorm:"primaryKey;autoIncrement"`
	DomainID    int64     `gorm:"column:domain_id;index;not null"`
	ChannelID   int64     `gorm:"column:channel_id;index:idx_messages_channel_created_at;not null"`
	UserID      *int64    `gorm:"column:user_id"`
	MessageType string    `gorm:"column:message_type;size:16;not null;default:chat"`
	Body        string    `gorm:"type:text;not null"`
	Metadata    []byte    `gorm:"type:json"`
	CreatedAt   time.Time `gorm:"column:created_at;index:idx_messages_channel_created_at;autoCreateTime"`
}

func (messageRecord) TableName() string {
	return "messages"
}
