const STORAGE_KEY = "oopz.live.user";

export const state = {
  user: null,
  domain: null,
  categories: [],
  members: [],
  messages: [],
  activeChannel: null,
  selectedChannelId: null,
  onlineCounts: {},
  wsConnected: false,
  currentVoiceChannelId: null,
  voiceMembers: new Map(),
  stunServers: [],
  remoteMedia: new Map(),
};

export function loadUser() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveUser(user) {
  state.user = user;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
}

export function setBootstrap(data) {
  state.user = data.user;
  state.domain = data.domain;
  state.categories = data.categories;
  state.members = data.members;
  state.messages = data.messages;
  state.activeChannel = data.activeChannel;
  state.selectedChannelId = data.selectedChannelId;
  state.onlineCounts = data.onlineCounts || {};
  state.stunServers = data.stunServers || [];
}

export function setActiveChannel(channel, messages) {
  state.activeChannel = channel;
  state.selectedChannelId = channel.id;
  state.messages = messages;
}

export function setMessages(messages) {
  state.messages = messages;
}

export function pushMessage(message) {
  state.messages = [...state.messages, message];
}

export function setVoiceMembers(members) {
  const map = new Map();
  members.forEach((member) => {
    map.set(member.user.id, member);
  });
  state.voiceMembers = map;
}

export function upsertVoiceMember(member) {
  state.voiceMembers.set(member.user.id, member);
}

export function removeVoiceMember(userId) {
  state.voiceMembers.delete(userId);
}

export function updateVoiceFlag(userId, patch) {
  const current = state.voiceMembers.get(userId);
  if (!current) return;
  state.voiceMembers.set(userId, { ...current, ...patch });
}

export function setRemoteMedia(entries) {
  state.remoteMedia = entries;
}

export function resetVoiceState() {
  state.currentVoiceChannelId = null;
  state.voiceMembers = new Map();
  state.remoteMedia = new Map();
}
