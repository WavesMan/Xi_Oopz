package realtime

import "oopz/internal/models"

type Envelope struct {
	Type    string `json:"type"`
	Payload any    `json:"payload,omitempty"`
}

type IncomingEnvelope struct {
	Type    string          `json:"type"`
	Payload jsonRawEnvelope `json:"payload"`
}

type jsonRawEnvelope []byte

type PresenceMember struct {
	User          models.User `json:"user"`
	ChannelID     int64       `json:"channelId"`
	MicEnabled    bool        `json:"micEnabled"`
	ScreenSharing bool        `json:"screenSharing"`
}

type OnlineUserPresence struct {
	User             models.User `json:"user"`
	DomainID         int64       `json:"domainId"`
	CurrentChannelID int64       `json:"currentChannelId"`
}

type DomainPresenceSnapshot struct {
	OnlineUsers  []OnlineUserPresence      `json:"onlineUsers"`
	VoiceMembers map[string][]PresenceMember `json:"voiceMembers"`
	OnlineCounts map[string]int64          `json:"onlineCounts"`
}

type ChannelJoinPayload struct {
	ChannelID int64 `json:"channelId"`
}

type ChannelLeavePayload struct {
	ChannelID int64 `json:"channelId"`
}

type ChatSendPayload struct {
	ChannelID int64  `json:"channelId"`
	Body      string `json:"body"`
}

type VoiceStatePayload struct {
	ChannelID  int64 `json:"channelId"`
	MicEnabled bool  `json:"micEnabled"`
}

type ScreenStatePayload struct {
	ChannelID     int64 `json:"channelId"`
	ScreenSharing bool  `json:"screenSharing"`
}

type RTCSignalPayload struct {
	ChannelID    int64  `json:"channelId"`
	TargetUserID int64  `json:"targetUserId"`
	SourceUserID int64  `json:"sourceUserId"`
	SDP          string `json:"sdp,omitempty"`
	Candidate    string `json:"candidate,omitempty"`
}
