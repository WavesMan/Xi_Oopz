package models

import "time"

type User struct {
	ID          int64     `json:"id"`
	Handle      string    `json:"handle"`
	DisplayName string    `json:"displayName"`
	Email       string    `json:"email,omitempty"`
	AvatarColor string    `json:"avatarColor"`
	IsGuest     bool      `json:"isGuest"`
	CreatedAt   time.Time `json:"createdAt"`
}

type Domain struct {
	ID          int64     `json:"id"`
	Slug        string    `json:"slug"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	AccentColor string    `json:"accentColor"`
	CreatedAt   time.Time `json:"createdAt"`
}

type DomainSummary struct {
	Domain
	Role string `json:"role"`
}

type Channel struct {
	ID         int64  `json:"id"`
	DomainID   int64  `json:"domainId"`
	CategoryID *int64 `json:"categoryId,omitempty"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Topic      string `json:"topic"`
	Position   int    `json:"position"`
	MaxMembers int    `json:"maxMembers"`
}

type ChannelCategory struct {
	ID       int64     `json:"id"`
	DomainID int64     `json:"domainId"`
	Name     string    `json:"name"`
	Position int       `json:"position"`
	Channels []Channel `json:"channels"`
}

type DomainMember struct {
	User
	Role string `json:"role"`
}

type Message struct {
	ID              int64     `json:"id"`
	DomainID        int64     `json:"domainId"`
	ChannelID       int64     `json:"channelId"`
	UserID          *int64    `json:"userId,omitempty"`
	UserDisplayName string    `json:"userDisplayName"`
	UserAvatarColor string    `json:"userAvatarColor"`
	MessageType     string    `json:"messageType"`
	Body            string    `json:"body"`
	Metadata        string    `json:"metadata,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
}

type BootstrapResponse struct {
	User          User                `json:"user"`
	Domain        Domain              `json:"domain"`
	Domains       []DomainSummary     `json:"domains"`
	CurrentRole   string              `json:"currentRole"`
	Categories    []ChannelCategory   `json:"categories"`
	Members       []DomainMember      `json:"members"`
	Messages      []Message           `json:"messages"`
	OnlineCounts  map[string]int64    `json:"onlineCounts"`
	SelectedID    int64               `json:"selectedChannelId"`
	ActiveChannel *Channel            `json:"activeChannel"`
	StunServers   []map[string]any    `json:"stunServers"`
}

type AuthResponse struct {
	Token string `json:"token"`
	User  User   `json:"user"`
}

type ScreeningViewer struct {
	User       User      `json:"user"`
	Ready      bool      `json:"ready"`
	JoinedAt   time.Time `json:"joinedAt"`
	LastPingAt time.Time `json:"lastPingAt"`
}

type ScreeningPlaylistItem struct {
	ItemID   string    `json:"itemId"`
	URL      string    `json:"url"`
	Title    string    `json:"title"`
	AddedBy  int64     `json:"addedBy"`
	AddedAt  time.Time `json:"addedAt"`
}

type ScreeningState struct {
	ChannelID         int64     `json:"channelId"`
	ControllerUserID  int64     `json:"controllerUserId"`
	CurrentItemID     string    `json:"currentItemId"`
	CurrentURL        string    `json:"currentUrl"`
	CurrentTitle      string    `json:"currentTitle"`
	PlaybackState     string    `json:"playbackState"`
	CurrentTime       float64   `json:"currentTime"`
	PlaybackRate      float64   `json:"playbackRate"`
	UpdatedAt         time.Time `json:"updatedAt"`
	StartedAt         time.Time `json:"startedAt"`
	AwaitingReady     bool      `json:"awaitingReady"`
	SyncToken         int64     `json:"syncToken"`
}

type ScreeningSnapshot struct {
	State    ScreeningState          `json:"state"`
	Viewers  []ScreeningViewer       `json:"viewers"`
	Playlist []ScreeningPlaylistItem `json:"playlist"`
}
