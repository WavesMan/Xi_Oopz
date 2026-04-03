package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"

	"oopz/internal/auth"
	"oopz/internal/models"
	"oopz/internal/store"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type Client struct {
	conn             *websocket.Conn
	hub              *Hub
	send             chan []byte
	user             models.User
	domainID         int64
	currentChannelID int64
	micEnabled       bool
	screenSharing    bool
}

type Hub struct {
	store          *store.Store
	rdb            *redis.Client
	auth           *auth.TokenManager
	mu             sync.RWMutex
	clients        map[*Client]struct{}
	userClients    map[int64]map[*Client]struct{}
	channelClients map[int64]map[*Client]struct{}
	channelUsers   map[int64]map[int64]*PresenceMember
	domainUsers    map[int64]map[int64]*OnlineUserPresence
}

func NewHub(s *store.Store, rdb *redis.Client, authManager *auth.TokenManager) *Hub {
	return &Hub{
		store:          s,
		rdb:            rdb,
		auth:           authManager,
		clients:        map[*Client]struct{}{},
		userClients:    map[int64]map[*Client]struct{}{},
		channelClients: map[int64]map[*Client]struct{}{},
		channelUsers:   map[int64]map[int64]*PresenceMember{},
		domainUsers:    map[int64]map[int64]*OnlineUserPresence{},
	}
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) error {
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		return fmt.Errorf("missing token")
	}
	userID, err := h.auth.Parse(token)
	if err != nil {
		return fmt.Errorf("invalid token")
	}
	domainID, err := strconv.ParseInt(r.URL.Query().Get("domainId"), 10, 64)
	if err != nil || domainID == 0 {
		return fmt.Errorf("invalid domainId")
	}

	user, err := h.store.GetUserByID(userID)
	if err != nil {
		return err
	}
	if err := h.store.EnsureDomainMembership(domainID, userID, "member"); err != nil {
		return err
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return err
	}

	client := &Client{
		conn:          conn,
		hub:           h,
		send:          make(chan []byte, 64),
		user:          user,
		domainID:      domainID,
		micEnabled:    true,
		screenSharing: false,
	}

	h.register(client)
	go client.writePump()
	go client.readPump()
	client.sendJSON("ready", map[string]any{
		"userId":   user.ID,
		"domainId": domainID,
	})
	return nil
}

func (h *Hub) register(client *Client) {
	h.mu.Lock()
	h.clients[client] = struct{}{}
	if _, ok := h.userClients[client.user.ID]; !ok {
		h.userClients[client.user.ID] = map[*Client]struct{}{}
	}
	h.userClients[client.user.ID][client] = struct{}{}
	state := h.refreshDomainUserLocked(client.domainID, client.user.ID)
	h.mu.Unlock()

	h.persistDomainUser(client.domainID, state)
}

func (h *Hub) unregister(client *Client) {
	h.leaveChannel(client, true)

	h.mu.Lock()
	delete(h.clients, client)
	if group, ok := h.userClients[client.user.ID]; ok {
		delete(group, client)
		if len(group) == 0 {
			delete(h.userClients, client.user.ID)
		}
	}
	state := h.refreshDomainUserLocked(client.domainID, client.user.ID)
	h.mu.Unlock()

	if state == nil {
		h.removeDomainUser(client.domainID, client.user.ID)
	} else {
		h.persistDomainUser(client.domainID, state)
	}
	close(client.send)
}

func (h *Hub) OnlineCounts(channelIDs []int64) map[string]int64 {
	result := make(map[string]int64, len(channelIDs))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	for _, id := range channelIDs {
		count, err := h.rdb.HLen(ctx, h.presenceKey(id)).Result()
		if err != nil {
			log.Printf("redis hlen error: %v", err)
			continue
		}
		result[strconv.FormatInt(id, 10)] = count
	}
	return result
}

func (h *Hub) DomainPresence(domainID int64, channelIDs []int64) DomainPresenceSnapshot {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	result := DomainPresenceSnapshot{
		OnlineUsers:  []OnlineUserPresence{},
		VoiceMembers: map[string][]PresenceMember{},
		OnlineCounts: map[string]int64{},
	}

	if onlineUsers, err := h.rdb.HGetAll(ctx, h.domainOnlineKey(domainID)).Result(); err == nil {
		for _, raw := range onlineUsers {
			var item OnlineUserPresence
			if json.Unmarshal([]byte(raw), &item) == nil {
				result.OnlineUsers = append(result.OnlineUsers, item)
			}
		}
	} else {
		log.Printf("redis hgetall online users error: %v", err)
	}

	for _, channelID := range channelIDs {
		key := h.presenceKey(channelID)
		presenceMap, err := h.rdb.HGetAll(ctx, key).Result()
		if err != nil {
			log.Printf("redis hgetall presence error: %v", err)
			continue
		}
		members := make([]PresenceMember, 0, len(presenceMap))
		for _, raw := range presenceMap {
			var member PresenceMember
			if json.Unmarshal([]byte(raw), &member) == nil {
				members = append(members, member)
			}
		}
		result.VoiceMembers[strconv.FormatInt(channelID, 10)] = members
		result.OnlineCounts[strconv.FormatInt(channelID, 10)] = int64(len(members))
	}

	return result
}

func (h *Hub) Handle(client *Client, raw []byte) {
	var envelope struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		client.sendJSON("error", map[string]string{"message": "invalid payload"})
		return
	}

	switch envelope.Type {
	case "channel.join":
		eventStartedAt := time.Now()
		var payload ChannelJoinPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid channel.join payload"})
			return
		}
		log.Printf("[voice-backend] channel.join received user=%d domain=%d channel=%d current=%d", client.user.ID, client.domainID, payload.ChannelID, client.currentChannelID)
		if err := h.joinChannel(client, payload.ChannelID); err != nil {
			client.sendJSON("error", map[string]string{"message": err.Error()})
			log.Printf("[voice-backend] channel.join failed user=%d channel=%d err=%v elapsed_ms=%d", client.user.ID, payload.ChannelID, err, time.Since(eventStartedAt).Milliseconds())
		} else {
			log.Printf("[voice-backend] channel.join completed user=%d channel=%d elapsed_ms=%d", client.user.ID, payload.ChannelID, time.Since(eventStartedAt).Milliseconds())
		}
	case "channel.leave":
		eventStartedAt := time.Now()
		log.Printf("[voice-backend] channel.leave received user=%d domain=%d channel=%d", client.user.ID, client.domainID, client.currentChannelID)
		h.leaveChannel(client, true)
		log.Printf("[voice-backend] channel.leave completed user=%d elapsed_ms=%d", client.user.ID, time.Since(eventStartedAt).Milliseconds())
	case "chat.send":
		var payload ChatSendPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid chat payload"})
			return
		}
		if strings.TrimSpace(payload.Body) == "" {
			return
		}
		h.handleChat(client, payload)
	case "voice.state":
		var payload VoiceStatePayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid voice payload"})
			return
		}
		h.handleVoiceState(client, payload)
	case "screen.state":
		var payload ScreenStatePayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid screen payload"})
			return
		}
		h.handleScreenState(client, payload)
	case "rtc.offer", "rtc.answer", "rtc.ice_candidate", "screen.sync_request":
		var payload RTCSignalPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			client.sendJSON("error", map[string]string{"message": "invalid rtc payload"})
			return
		}
		payload.SourceUserID = client.user.ID
		h.forwardToUser(payload.TargetUserID, envelope.Type, payload)
	case "heartbeat", "hello":
		client.sendJSON("ready", map[string]any{
			"userId":   client.user.ID,
			"domainId": client.domainID,
		})
	default:
		client.sendJSON("error", map[string]string{"message": "unknown event"})
	}
}

func (h *Hub) handleChat(client *Client, payload ChatSendPayload) {
	msg, err := h.store.InsertMessage(client.domainID, payload.ChannelID, &client.user.ID, "chat", strings.TrimSpace(payload.Body), nil)
	if err != nil {
		client.sendJSON("error", map[string]string{"message": "message persist failed"})
		return
	}
	h.broadcastToDomain(client.domainID, "chat.message", msg, nil)
}

func (h *Hub) handleVoiceState(client *Client, payload VoiceStatePayload) {
	client.micEnabled = payload.MicEnabled
	h.updatePresence(client)
	h.broadcastToChannel(payload.ChannelID, "voice.state", map[string]any{
		"channelId":  payload.ChannelID,
		"userId":     client.user.ID,
		"micEnabled": payload.MicEnabled,
	}, nil)
}

func (h *Hub) handleScreenState(client *Client, payload ScreenStatePayload) {
	client.screenSharing = payload.ScreenSharing
	h.updatePresence(client)
	h.broadcastToChannel(payload.ChannelID, "screen.state", map[string]any{
		"channelId":     payload.ChannelID,
		"userId":        client.user.ID,
		"screenSharing": payload.ScreenSharing,
	}, nil)
}

func (h *Hub) joinChannel(client *Client, channelID int64) error {
	channel, err := h.store.GetChannel(channelID)
	if err != nil {
		return err
	}
	if channel == nil {
		return fmt.Errorf("channel not found")
	}
	if channel.Type != "voice" {
		return fmt.Errorf("only voice channels can be joined")
	}

	if client.currentChannelID == channelID {
		return nil
	}
	if client.currentChannelID != 0 {
		h.leaveChannel(client, true)
	}

	member := &PresenceMember{
		User:          client.user,
		ChannelID:     channelID,
		MicEnabled:    client.micEnabled,
		ScreenSharing: client.screenSharing,
	}

	h.mu.Lock()
	client.currentChannelID = channelID
	if _, ok := h.channelClients[channelID]; !ok {
		h.channelClients[channelID] = map[*Client]struct{}{}
	}
	h.channelClients[channelID][client] = struct{}{}
	if _, ok := h.channelUsers[channelID]; !ok {
		h.channelUsers[channelID] = map[int64]*PresenceMember{}
	}
	h.channelUsers[channelID][client.user.ID] = member

	snapshot := make([]PresenceMember, 0, len(h.channelUsers[channelID]))
	for _, current := range h.channelUsers[channelID] {
		snapshot = append(snapshot, *current)
	}
	h.mu.Unlock()
	h.persistPresence(channelID, member)
	h.persistDomainUser(channelIDToDomainID(client.domainID), h.snapshotOnlineUser(client))
	client.sendJSON("presence.snapshot", map[string]any{
		"channelId": channelID,
		"members":   snapshot,
	})
	h.broadcastToChannel(channelID, "member.joined", member, client)
	h.broadcastTransientSystem(client, channelID, fmt.Sprintf("%s joined the room", client.user.DisplayName))
	return nil
}

func (h *Hub) leaveChannel(client *Client, persist bool) {
	h.mu.Lock()
	channelID := client.currentChannelID
	if channelID == 0 {
		h.mu.Unlock()
		return
	}

	delete(h.channelClients[channelID], client)
	if len(h.channelClients[channelID]) == 0 {
		delete(h.channelClients, channelID)
	}
	if users, ok := h.channelUsers[channelID]; ok {
		delete(users, client.user.ID)
		if len(users) == 0 {
			delete(h.channelUsers, channelID)
		}
	}
	client.currentChannelID = 0
	state := h.refreshDomainUserLocked(client.domainID, client.user.ID)
	h.mu.Unlock()
	h.removePresence(channelID, client.user.ID)
	if state == nil {
		h.removeDomainUser(client.domainID, client.user.ID)
	} else {
		h.persistDomainUser(client.domainID, state)
	}
	h.broadcastToChannel(channelID, "member.left", map[string]any{
		"channelId": channelID,
		"userId":    client.user.ID,
	}, nil)
	if persist {
		h.broadcastTransientSystem(client, channelID, fmt.Sprintf("%s left the room", client.user.DisplayName))
	}
}

func (h *Hub) updatePresence(client *Client) {
	if client.currentChannelID == 0 {
		return
	}

	h.mu.Lock()
	if users, ok := h.channelUsers[client.currentChannelID]; ok {
		if current, ok := users[client.user.ID]; ok {
			current.MicEnabled = client.micEnabled
			current.ScreenSharing = client.screenSharing
			h.persistPresence(client.currentChannelID, current)
		}
	}
	h.mu.Unlock()
}

func (h *Hub) persistPresence(channelID int64, member *PresenceMember) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	payload, _ := json.Marshal(member)
	if err := h.rdb.SAdd(ctx, "online:channels", channelID).Err(); err != nil {
		log.Printf("redis sadd error: %v", err)
	}
	if err := h.rdb.HSet(ctx, h.presenceKey(channelID), strconv.FormatInt(member.User.ID, 10), string(payload)).Err(); err != nil {
		log.Printf("redis hset error: %v", err)
	}
}

func (h *Hub) removePresence(channelID, userID int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := h.rdb.HDel(ctx, h.presenceKey(channelID), strconv.FormatInt(userID, 10)).Err(); err != nil {
		log.Printf("redis hdel error: %v", err)
	}
	count, err := h.rdb.HLen(ctx, h.presenceKey(channelID)).Result()
	if err != nil {
		log.Printf("redis hlen error: %v", err)
		return
	}
	if count == 0 {
		if err := h.rdb.SRem(ctx, "online:channels", channelID).Err(); err != nil {
			log.Printf("redis srem error: %v", err)
		}
	}
}

func (h *Hub) broadcastTransientSystem(client *Client, channelID int64, body string) {
	msg := models.Message{
		DomainID:        client.domainID,
		ChannelID:       channelID,
		UserDisplayName: "System",
		UserAvatarColor: "#8892b0",
		MessageType:     "system",
		Body:            body,
		CreatedAt:       time.Now().UTC(),
	}
	h.broadcastToChannel(channelID, "chat.message", msg, nil)
}

func (h *Hub) forwardToUser(userID int64, eventType string, payload any) {
	data, err := json.Marshal(Envelope{Type: eventType, Payload: payload})
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.userClients[userID] {
		select {
		case client.send <- data:
		default:
			log.Printf("dropping websocket message to user %d", userID)
		}
	}
}

func (h *Hub) broadcastToChannel(channelID int64, eventType string, payload any, except *Client) {
	data, err := json.Marshal(Envelope{Type: eventType, Payload: payload})
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.channelClients[channelID] {
		if client == except {
			continue
		}
		select {
		case client.send <- data:
		default:
			log.Printf("dropping websocket broadcast in channel %d", channelID)
		}
	}
}

func (h *Hub) broadcastToDomain(domainID int64, eventType string, payload any, except *Client) {
	data, err := json.Marshal(Envelope{Type: eventType, Payload: payload})
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.clients {
		if client.domainID != domainID || client == except {
			continue
		}
		select {
		case client.send <- data:
		default:
			log.Printf("dropping websocket broadcast in domain %d", domainID)
		}
	}
}

func (h *Hub) presenceKey(channelID int64) string {
	return fmt.Sprintf("channel:presence:%d", channelID)
}

func (h *Hub) domainOnlineKey(domainID int64) string {
	return fmt.Sprintf("domain:online:%d", domainID)
}

func (h *Hub) persistDomainUser(domainID int64, state *OnlineUserPresence) {
	if state == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	payload, _ := json.Marshal(state)
	if err := h.rdb.HSet(ctx, h.domainOnlineKey(domainID), strconv.FormatInt(state.User.ID, 10), string(payload)).Err(); err != nil {
		log.Printf("redis hset domain online error: %v", err)
	}
}

func (h *Hub) removeDomainUser(domainID, userID int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := h.rdb.HDel(ctx, h.domainOnlineKey(domainID), strconv.FormatInt(userID, 10)).Err(); err != nil {
		log.Printf("redis hdel domain online error: %v", err)
	}
}

func (h *Hub) refreshDomainUserLocked(domainID, userID int64) *OnlineUserPresence {
	var (
		found       bool
		current     int64
		currentUser models.User
	)

	for client := range h.clients {
		if client.domainID != domainID || client.user.ID != userID {
			continue
		}
		if !found {
			found = true
			currentUser = client.user
		}
		if client.currentChannelID != 0 {
			current = client.currentChannelID
		}
	}

	if !found {
		if users, ok := h.domainUsers[domainID]; ok {
			delete(users, userID)
			if len(users) == 0 {
				delete(h.domainUsers, domainID)
			}
		}
		return nil
	}

	if _, ok := h.domainUsers[domainID]; !ok {
		h.domainUsers[domainID] = map[int64]*OnlineUserPresence{}
	}
	state := &OnlineUserPresence{
		User:             currentUser,
		DomainID:         domainID,
		CurrentChannelID: current,
	}
	h.domainUsers[domainID][userID] = state
	return state
}

func (h *Hub) snapshotOnlineUser(client *Client) *OnlineUserPresence {
	return &OnlineUserPresence{
		User:             client.user,
		DomainID:         client.domainID,
		CurrentChannelID: client.currentChannelID,
	}
}

func channelIDToDomainID(domainID int64) int64 {
	return domainID
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister(c)
		_ = c.conn.Close()
	}()

	c.conn.SetReadLimit(1 << 20)
	_ = c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
		c.hub.Handle(c, message)
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(25 * time.Second)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) sendJSON(eventType string, payload any) {
	data, err := json.Marshal(Envelope{Type: eventType, Payload: payload})
	if err != nil {
		return
	}
	select {
	case c.send <- data:
	default:
	}
}
