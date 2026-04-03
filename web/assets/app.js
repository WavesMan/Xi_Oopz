import { createGuestUser, fetchBootstrap, fetchChannelMessages } from "./api.js";
import {
  loadUser,
  saveUser,
  setBootstrap,
  setActiveChannel,
  pushMessage,
  setMessages,
  setVoiceMembers,
  upsertVoiceMember,
  removeVoiceMember,
  updateVoiceFlag,
  setRemoteMedia,
  resetVoiceState,
  state,
} from "./state.js";
import { render, renderShell } from "./ui.js";
import { SocketClient } from "./ws.js";
import { RTCController } from "./rtc.js";

let socket = null;
let rtc = null;
let micEnabled = true;
let screenSharing = false;

async function init() {
  bindIdentity();
  bindComposer();
  bindControls();

  const saved = loadUser();
  if (!saved) {
    showIdentityModal(true);
    return;
  }

  state.user = saved;
  await bootstrap();
}

async function bootstrap(channelId) {
  try {
    const data = await fetchBootstrap(state.user.id, channelId);
    setBootstrap(data);
    ensureSocket();
    ensureRTC();
    updateIdentityUI();
    render(state);
    showIdentityModal(false);
  } catch (error) {
    console.error(error);
    setStatus("初始化失败，请确认后端与数据库已启动");
  }
}

function ensureSocket() {
  if (socket) return;
  socket = new SocketClient({
    userId: state.user.id,
    domainId: state.domain.id,
    onEvent: handleSocketEvent,
    onStatus: (connected) => {
      state.wsConnected = connected;
      setStatus(connected ? "WS 已连接" : "WS 重连中");
    },
  });
  socket.connect();
}

function ensureRTC() {
  if (rtc) return;
  rtc = new RTCController({
    state,
    socket,
    onMediaChanged: (remoteMedia) => {
      setRemoteMedia(remoteMedia);
      render(state);
    },
    onError: (message) => setStatus(message),
  });
}

function bindIdentity() {
  const button = document.getElementById("createIdentityButton");
  const input = document.getElementById("displayNameInput");

  button.addEventListener("click", async () => {
    const displayName = input.value.trim();
    if (!displayName) {
      setStatus("请输入一个昵称");
      return;
    }
    button.disabled = true;
    try {
      const user = await createGuestUser(displayName);
      saveUser(user);
      await bootstrap();
    } catch (error) {
      console.error(error);
      setStatus("创建用户失败");
    } finally {
      button.disabled = false;
    }
  });
}

function bindComposer() {
  const sendButton = document.getElementById("sendButton");
  const input = document.getElementById("messageInput");

  sendButton.addEventListener("click", sendMessage);
  input.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      sendMessage();
    }
  });

  document.getElementById("channelTree").addEventListener("click", async (event) => {
    const target = event.target.closest("[data-channel-id]");
    if (!target) return;
    const channelId = Number(target.dataset.channelId);
    const channel = findChannel(channelId);
    if (!channel) return;

    try {
      const messages = await fetchChannelMessages(state.domain.id, channelId);
      setActiveChannel(channel, messages);
      render(state);
    } catch (error) {
      console.error(error);
      setStatus("切换频道失败");
    }
  });
}

function bindControls() {
  document.getElementById("joinVoiceButton").addEventListener("click", async () => {
    if (!state.activeChannel || state.activeChannel.type !== "voice") return;
    try {
      await rtc.joinVoice(state.activeChannel.id);
      state.currentVoiceChannelId = state.activeChannel.id;
      micEnabled = true;
      screenSharing = false;
      renderShell(state);
      setStatus("正在加入语音房");
    } catch (error) {
      console.error(error);
      setStatus("麦克风权限失败，请允许访问后重试");
    }
  });

  document.getElementById("leaveVoiceButton").addEventListener("click", async () => {
    if (!rtc || !state.currentVoiceChannelId) return;
    await rtc.leaveVoice();
    resetVoiceState();
    render(state);
    setStatus("已离开语音房");
  });

  document.getElementById("micButton").addEventListener("click", async () => {
    if (!state.currentVoiceChannelId) return;
    micEnabled = !micEnabled;
    await rtc.toggleMic(micEnabled);
    socket.send("voice.state", {
      channelId: state.currentVoiceChannelId,
      micEnabled,
    });
    setStatus(micEnabled ? "麦克风已开启" : "麦克风已静音");
  });

  document.getElementById("screenButton").addEventListener("click", async () => {
    if (!state.currentVoiceChannelId) return;
    try {
      if (!screenSharing) {
        await rtc.startScreenShare();
      } else {
        await rtc.stopScreenShare(true);
      }
      screenSharing = !screenSharing;
      socket.send("screen.state", {
        channelId: state.currentVoiceChannelId,
        screenSharing,
      });
      setStatus(screenSharing ? "屏幕共享已开启" : "屏幕共享已关闭");
    } catch (error) {
      console.error(error);
      setStatus("屏幕共享失败，请确认浏览器允许该操作");
    }
  });
}

function handleSocketEvent(type, payload) {
  switch (type) {
    case "ready":
      setStatus("实时连接就绪");
      break;
    case "presence.snapshot":
      state.currentVoiceChannelId = payload.channelId;
      setVoiceMembers(payload.members || []);
      rtc.handlePresenceSnapshot(payload.members || []);
      updateOnlineCount(payload.channelId, payload.members?.length || 0);
      render(state);
      break;
    case "member.joined":
      upsertVoiceMember(payload);
      updateOnlineCount(payload.channelId, state.voiceMembers.size);
      rtc.handleMemberJoined(payload);
      render(state);
      break;
    case "member.left":
      removeVoiceMember(payload.userId);
      rtc.handleMemberLeft(payload.userId);
      if (payload.channelId) {
        updateOnlineCount(payload.channelId, state.voiceMembers.size);
      }
      render(state);
      break;
    case "chat.message":
      if (payload.channelId === state.selectedChannelId) {
        pushMessage(payload);
      }
      render(state);
      break;
    case "voice.state":
      updateVoiceFlag(payload.userId, { micEnabled: payload.micEnabled });
      render(state);
      break;
    case "screen.state":
      updateVoiceFlag(payload.userId, { screenSharing: payload.screenSharing });
      render(state);
      break;
    case "rtc.offer":
    case "rtc.answer":
    case "rtc.ice_candidate":
      rtc.handleSignal(type, payload);
      break;
    case "error":
      setStatus(payload.message || "实时事件出错");
      break;
    default:
      break;
  }
}

function sendMessage() {
  const input = document.getElementById("messageInput");
  const body = input.value.trim();
  if (!body || !state.activeChannel || !socket) return;
  socket.send("chat.send", {
    channelId: state.activeChannel.id,
    body,
  });
  input.value = "";
}

function findChannel(channelId) {
  for (const category of state.categories) {
    const found = category.channels.find((channel) => channel.id === channelId);
    if (found) return found;
  }
  return null;
}

function updateIdentityUI() {
  document.getElementById("selfName").textContent = state.user.displayName;
  document.getElementById("selfAvatar").textContent = state.user.displayName.slice(0, 2).toUpperCase();
  document.getElementById("selfAvatar").style.background = state.user.avatarColor;
}

function updateOnlineCount(channelId, count) {
  state.onlineCounts[String(channelId)] = count;
}

function setStatus(text) {
  const badge = document.getElementById("connectionBadge");
  badge.textContent = text;
  badge.classList.toggle("connection-badge--online", state.wsConnected);
}

function showIdentityModal(visible) {
  document.getElementById("identityModal").classList.toggle("identity-modal--visible", visible);
}

init();
