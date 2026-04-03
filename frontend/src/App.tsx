import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";

import { createCategory, createChannel, createDomain, fetchBootstrap, fetchChannelMessages, fetchDomainPresence, fetchMe, loginAccount, registerAccount, sendVerificationCode } from "./api";
import { RTCController } from "./rtc";
import { soundManager } from "./sound";
import { SocketClient } from "./socket";
import type {
  AuthResponse,
  BootstrapResponse,
  Channel,
  DomainMember,
  Message,
  OnlineUserPresence,
  PresenceMember,
  RemoteMedia,
  User,
} from "./types";

const STORAGE_KEY = "oopz.live.session";

type Session = AuthResponse;
type AuthMode = "login" | "register";
type ScreenPreview = {
  key: string;
  user: User;
  stream: MediaStream;
  isLocal: boolean;
};

type AudioInputOption = {
  deviceId: string;
  label: string;
};

const VOICE_UI_DEBUG_LABELS = new Set([
  "join:start",
  "join:audio-device-applied",
  "join:noise-suppression-applied",
  "join:rtc.joinVoice-returned",
  "join:presence.snapshot",
  "join:error",
  "leave:start",
  "leave:rtc.leaveVoice-returned",
  "leave:local-state-cleared",
]);

const EMOJI_GROUPS: Array<{ label: string; items: string[] }> = [
  { label: "常用", items: ["😀", "😂", "🤣", "😊", "😍", "🥰", "😭", "😅", "🤔", "😎"] },
  { label: "互动", items: ["👍", "👎", "👏", "🙏", "💪", "👌", "🤝", "👀", "🎉", "❤️"] },
  { label: "气氛", items: ["🔥", "✨", "💯", "🚀", "🎮", "🎵", "☕", "🍕", "🥳", "🌈"] },
];

function loadSession(): Session | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as Session;
}

function saveSession(session: Session) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function clearSession() {
  window.localStorage.removeItem(STORAGE_KEY);
}

function initials(name?: string) {
  return (name || "?").trim().slice(0, 2).toUpperCase();
}

function formatTime(value: string) {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function escapeHTML(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function pickPreferredAudioInputId(inputs: AudioInputOption[], currentId: string) {
  if (currentId && inputs.some((item) => item.deviceId === currentId)) {
    return currentId;
  }
  return (
    inputs.find((item) => item.deviceId && item.deviceId !== "default" && item.deviceId !== "communications")?.deviceId ||
    inputs.find((item) => item.deviceId)?.deviceId ||
    ""
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [user, setUser] = useState<User | null>(() => loadSession()?.user || null);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const deferredMessages = useDeferredValue(messages);
  const [voiceMembers, setVoiceMembers] = useState<Map<number, PresenceMember>>(new Map());
  const [remoteMedia, setRemoteMedia] = useState<Map<number, RemoteMedia>>(new Map());
  const [onlineCounts, setOnlineCounts] = useState<Record<string, number>>({});
  const [onlineUsers, setOnlineUsers] = useState<Map<number, OnlineUserPresence>>(new Map());
  const [voiceChannelMembers, setVoiceChannelMembers] = useState<Record<string, PresenceMember[]>>({});
  const [currentVoiceChannelId, setCurrentVoiceChannelId] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [status, setStatus] = useState("等待初始化");
  const [authMode, setAuthMode] = useState<AuthMode>("register");
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [verificationCodeInput, setVerificationCodeInput] = useState("");
  const [micEnabled, setMicEnabled] = useState(true);
  const [deafened, setDeafened] = useState(false);
  const [showAudioSettings, setShowAudioSettings] = useState(false);
  const [showHeadphoneSettings, setShowHeadphoneSettings] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [audioInputs, setAudioInputs] = useState<AudioInputOption[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState("");
  const [audioDevicesLoading, setAudioDevicesLoading] = useState(true);
  const [audioPrewarming, setAudioPrewarming] = useState(false);
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(true);
  const [remoteVolume, setRemoteVolume] = useState(72);
  const [screenSharing, setScreenSharing] = useState(false);
  const [messageDraft, setMessageDraft] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [localAudioStream, setLocalAudioStream] = useState<MediaStream | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [maximizedScreenKey, setMaximizedScreenKey] = useState<string | null>(null);
  const [submittingAuth, setSubmittingAuth] = useState(false);
  const [sendingVerificationCode, setSendingVerificationCode] = useState(false);
  const [verificationCooldown, setVerificationCooldown] = useState(0);
  const [creatingDomain, setCreatingDomain] = useState(false);
  const [domainNameInput, setDomainNameInput] = useState("");
  const [domainDescriptionInput, setDomainDescriptionInput] = useState("");
  const [channelComposerType, setChannelComposerType] = useState<"text" | "voice" | null>(null);
  const [channelNameInput, setChannelNameInput] = useState("");
  const [channelTopicInput, setChannelTopicInput] = useState("");
  const [submittingDomain, setSubmittingDomain] = useState(false);
  const [submittingChannel, setSubmittingChannel] = useState(false);
  const [voiceTargetChannelId, setVoiceTargetChannelId] = useState<number | null>(null);

  const socketRef = useRef<SocketClient | null>(null);
  const rtcRef = useRef<RTCController | null>(null);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const emojiPickerRef = useRef<HTMLDivElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const audioSettingsCloseTimerRef = useRef<number | null>(null);
  const headphoneSettingsCloseTimerRef = useRef<number | null>(null);
  const audioBootstrapStartedRef = useRef(false);
  const joinTraceRef = useRef<{ id: number; startedAt: number; channelId: number } | null>(null);
  const leaveTraceRef = useRef<{ id: number; startedAt: number; channelId: number | null } | null>(null);
  const voiceTraceCounterRef = useRef(0);
  const activeChannelIdRef = useRef<number | null>(null);
  const currentVoiceChannelIdRef = useRef<number | null>(null);
  const voiceMembersRef = useRef<Map<number, PresenceMember>>(new Map());
  const membersRef = useRef<DomainMember[]>([]);
  const currentUserRef = useRef<User | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const audioSetupPending = audioDevicesLoading || audioPrewarming;

  useEffect(() => {
    if (session) return;
    audioBootstrapStartedRef.current = false;
    setAudioPrewarming(false);
  }, [session]);

  useEffect(() => {
    activeChannelIdRef.current = activeChannel?.id || null;
  }, [activeChannel]);

  useEffect(() => {
    currentVoiceChannelIdRef.current = currentVoiceChannelId;
  }, [currentVoiceChannelId]);

  useEffect(() => {
    voiceMembersRef.current = voiceMembers;
  }, [voiceMembers]);

  useEffect(() => {
    currentUserRef.current = user;
    membersRef.current = bootstrap?.members || [];
    iceServersRef.current = bootstrap?.stunServers || [];
  }, [bootstrap, user]);

  useEffect(() => {
    if (verificationCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setVerificationCooldown((value) => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [verificationCooldown]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const container = messageListRef.current;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeChannel?.id, deferredMessages]);

  useEffect(() => {
    if (!session) return;
    void hydrateSession();
  }, [session?.token]);

  useEffect(() => {
    if (!session || !user) return;
    void bootstrapData();
  }, [session?.token, user?.id]);

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setAudioDevicesLoading(false);
      return;
    }

    let disposed = false;
    const syncDevices = async () => {
      setAudioDevicesLoading(true);
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (disposed) return;
        const nextInputs = devices
          .filter((device) => device.kind === "audioinput")
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `麦克风 ${index + 1}`,
          }));
        setAudioInputs(nextInputs);
        setSelectedAudioInputId((current) => {
          return pickPreferredAudioInputId(nextInputs, current);
        });
      } catch (error) {
        console.error(error);
      } finally {
        if (!disposed) {
          setAudioDevicesLoading(false);
        }
      }
    };

    void syncDevices();
    const handleDeviceChange = () => {
      void syncDevices();
    };
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      disposed = true;
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [localAudioStream]);

  useEffect(() => {
    if (!rtcRef.current || !session || !user || audioBootstrapStartedRef.current) return;
    audioBootstrapStartedRef.current = true;
    setAudioPrewarming(true);
    setStatus("正在预加载音频设备...");
    void rtcRef.current
      .prewarmAudio()
      .then(async () => {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        const nextInputs = devices
          .filter((device) => device.kind === "audioinput")
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `麦克风 ${index + 1}`,
          }));
        setAudioInputs(nextInputs);
        setSelectedAudioInputId((current) => pickPreferredAudioInputId(nextInputs, current));
      })
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        setAudioPrewarming(false);
        setStatus((current) => (current === "正在预加载音频设备..." ? "音频设备已就绪" : current));
      });
  }, [session, user, bootstrap?.domain.id]);

  useEffect(() => {
    if (!rtcRef.current) return;
    void rtcRef.current.setAudioInputDevice(selectedAudioInputId);
  }, [selectedAudioInputId]);

  useEffect(() => {
    if (!rtcRef.current) return;
    void rtcRef.current.setNoiseSuppression(noiseSuppressionEnabled);
  }, [noiseSuppressionEnabled]);

  useEffect(() => {
    if (!showProfileMenu) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!profileMenuRef.current) return;
      if (profileMenuRef.current.contains(event.target as Node)) return;
      setShowProfileMenu(false);
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [showProfileMenu]);

  useEffect(() => {
    if (!showEmojiPicker) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!emojiPickerRef.current) return;
      if (emojiPickerRef.current.contains(event.target as Node)) return;
      setShowEmojiPicker(false);
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [showEmojiPicker]);

  useEffect(() => {
    return () => {
      if (audioSettingsCloseTimerRef.current) {
        window.clearTimeout(audioSettingsCloseTimerRef.current);
      }
    };
  }, []);

  function voiceLog(label: string, extra?: Record<string, unknown>) {
    if (!VOICE_UI_DEBUG_LABELS.has(label)) {
      return;
    }
    const stamp = new Date().toISOString();
    if (extra) {
      console.info(`[voice-ui][${stamp}] ${label}`, extra);
      return;
    }
    console.info(`[voice-ui][${stamp}] ${label}`);
  }

  useEffect(() => {
    if (!session || !user || !bootstrap?.domain.id) return;

    const socket = new SocketClient(session.token, bootstrap.domain.id, handleSocketEvent, (connected) => {
      voiceLog("socket:status", { connected, domainId: bootstrap.domain.id });
      setWsConnected(connected);
      setStatus(connected ? "WS 已连接" : "WS 重连中");
    });

    socketRef.current = socket;
    socket.connect();

    rtcRef.current = new RTCController(
      socket,
      () => currentVoiceChannelIdRef.current,
      () => currentUserRef.current,
      () => membersRef.current,
      () => voiceMembersRef.current,
      () => iceServersRef.current,
      (media) => setRemoteMedia(new Map(media)),
      (stream) => setLocalAudioStream(stream),
      (stream) => setLocalScreenStream(stream),
      (message) => setStatus(message),
    );
    void rtcRef.current.setAudioInputDevice(selectedAudioInputId);
    void rtcRef.current.setNoiseSuppression(noiseSuppressionEnabled);

    return () => {
      socket.close();
      socketRef.current = null;
      rtcRef.current = null;
    };
  }, [session?.token, user?.id, bootstrap?.domain.id]);

  async function hydrateSession() {
    if (!session) return;
    try {
      const currentUser = await fetchMe(session.token);
      setUser(currentUser);
    } catch (error) {
      console.error(error);
      logout();
      setStatus("登录状态已失效，请重新登录");
    }
  }

  async function bootstrapData(channelId?: number, domainId?: number) {
    if (!session) return;
    try {
      const data = await fetchBootstrap(session.token, channelId, domainId);
      const channels = (data.categories || []).flatMap((category) => category.channels);
      const firstTextChannel = channels.find((channel) => channel.type === "text") || null;
      const firstVoiceChannel = channels.find((channel) => channel.type === "voice") || null;
      const preferredTextChannel = data.activeChannel?.type === "text" ? data.activeChannel : firstTextChannel || data.activeChannel;
      setBootstrap(data);
      setUser(data.user);
      setActiveChannel(preferredTextChannel);
      setMessages(data.messages);
      setVoiceTargetChannelId(firstVoiceChannel?.id || null);
      setOnlineCounts(data.onlineCounts || {});
      setStatus("页面已就绪");
    } catch (error) {
      console.error(error);
      setStatus("初始化失败，请检查服务与数据库");
    }
  }

  useEffect(() => {
    if (!session || !bootstrap?.domain.id) return;

    let cancelled = false;
    let timer = 0;

    const tick = async () => {
      try {
        const snapshot = await fetchDomainPresence(bootstrap.domain.id, session.token);
        if (cancelled) return;
        setOnlineCounts(snapshot.onlineCounts || {});
        setVoiceChannelMembers(snapshot.voiceMembers || {});
        setOnlineUsers(new Map((snapshot.onlineUsers || []).map((item) => [item.user.id, item])));
      } catch (error) {
        if (!cancelled) {
          console.error(error);
        }
      }
    };

    void tick();
    timer = window.setInterval(() => {
      void tick();
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [session?.token, bootstrap?.domain.id]);

  async function submitAuth() {
    if (!emailInput.trim() || !passwordInput.trim()) {
      setStatus("请输入邮箱和密码");
      return;
    }
    if (authMode === "register" && !displayNameInput.trim()) {
      setStatus("请输入昵称");
      return;
    }
    if (authMode === "register" && !verificationCodeInput.trim()) {
      setStatus("请输入邮箱验证码");
      return;
    }

    setSubmittingAuth(true);
    try {
      const result =
        authMode === "register"
          ? await registerAccount({
              displayName: displayNameInput.trim(),
              email: emailInput.trim(),
              password: passwordInput,
              code: verificationCodeInput.trim(),
            })
          : await loginAccount({
              email: emailInput.trim(),
              password: passwordInput,
            });

      saveSession(result);
      setSession(result);
      setUser(result.user);
      setDisplayNameInput("");
      setEmailInput("");
      setPasswordInput("");
      setVerificationCodeInput("");
      setVerificationCooldown(0);
      setStatus(authMode === "register" ? "注册成功，正在进入频道" : "登录成功");
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : "认证失败");
    } finally {
      setSubmittingAuth(false);
    }
  }

  async function requestVerificationCode() {
    if (!emailInput.trim()) {
      setStatus("请先输入邮箱");
      return;
    }

    setSendingVerificationCode(true);
    try {
      const result = await sendVerificationCode({ email: emailInput.trim() });
      setVerificationCooldown(result.cooldown || 60);
      setStatus(result.emailDebug ? "验证码已生成，当前环境未启用邮件发送，请查看服务端日志" : result.message || "验证码已发送");
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : "验证码发送失败");
    } finally {
      setSendingVerificationCode(false);
    }
  }

  async function switchDomain(domainId: number) {
    if (!bootstrap || bootstrap.domain.id === domainId) return;
    await rtcRef.current?.leaveVoice();
    setCurrentVoiceChannelId(null);
    setVoiceMembers(new Map());
    setRemoteMedia(new Map());
    setVoiceChannelMembers({});
    setOnlineCounts({});
    setMessages([]);
    setScreenSharing(false);
    setLocalAudioStream(null);
    setLocalScreenStream(null);
    setMaximizedScreenKey(null);
    setMessageDraft("");
    setShowEmojiPicker(false);
    setShowAudioSettings(false);
    setShowProfileMenu(false);
    setVoiceTargetChannelId(null);
    setStatus("正在切换域...");
    await bootstrapData(undefined, domainId);
  }

  async function submitCreateDomain() {
    if (!session) return;
    if (!domainNameInput.trim()) {
      setStatus("请输入域名称");
      return;
    }
    setSubmittingDomain(true);
    try {
      const domain = await createDomain(session.token, {
        name: domainNameInput.trim(),
        description: domainDescriptionInput.trim() || "新的团队域。",
      });
      setCreatingDomain(false);
      setDomainNameInput("");
      setDomainDescriptionInput("");
      await switchDomain(domain.id);
      setStatus("域创建成功");
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : "创建域失败");
    } finally {
      setSubmittingDomain(false);
    }
  }

  function resolveCategoryForType(type: "text" | "voice") {
    const categories = bootstrap?.categories || [];
    const matchByChannel = categories.find((category) => category.channels.some((channel) => channel.type === type));
    if (matchByChannel) return matchByChannel;
    const matchByName = categories.find((category) =>
      type === "text" ? /text/i.test(category.name) || /文字/.test(category.name) : /voice/i.test(category.name) || /语音/.test(category.name),
    );
    return matchByName || null;
  }

  async function submitCreateChannel() {
    if (!session || !bootstrap || !channelComposerType) return;
    if (!channelNameInput.trim()) {
      setStatus("请输入频道名称");
      return;
    }
    setSubmittingChannel(true);
    try {
      let category = resolveCategoryForType(channelComposerType);
      if (!category) {
        category = await createCategory(bootstrap.domain.id, session.token, {
          name: channelComposerType === "text" ? "TEXT CHANNELS" : "VOICE CHANNELS",
        });
      }
      const channel = await createChannel(bootstrap.domain.id, session.token, {
        categoryId: category.id,
        name: channelNameInput.trim(),
        type: channelComposerType,
        topic: channelTopicInput.trim() || (channelComposerType === "text" ? "新的文字频道。" : "新的语音频道。"),
        maxMembers: channelComposerType === "voice" ? 16 : 0,
      });
      setChannelComposerType(null);
      setChannelNameInput("");
      setChannelTopicInput("");
      await bootstrapData(channel.id, bootstrap.domain.id);
      setStatus(`${channelComposerType === "text" ? "文字" : "语音"}频道创建成功`);
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : "创建频道失败");
    } finally {
      setSubmittingChannel(false);
    }
  }

  function logout() {
    socketRef.current?.close();
    clearSession();
    setSession(null);
    setUser(null);
    setBootstrap(null);
    setActiveChannel(null);
    setMessages([]);
    setVoiceMembers(new Map());
    setRemoteMedia(new Map());
    setOnlineCounts({});
    setOnlineUsers(new Map());
    setVoiceChannelMembers({});
    setCurrentVoiceChannelId(null);
    setDeafened(false);
    setMicEnabled(true);
    setScreenSharing(false);
    setLocalAudioStream(null);
    setLocalScreenStream(null);
    setMaximizedScreenKey(null);
    setMessageDraft("");
    setShowEmojiPicker(false);
    setWsConnected(false);
    setCreatingDomain(false);
    setDomainNameInput("");
    setDomainDescriptionInput("");
    setChannelComposerType(null);
    setChannelNameInput("");
    setChannelTopicInput("");
    setSubmittingDomain(false);
    setSubmittingChannel(false);
    setVoiceTargetChannelId(null);
  }

  async function selectChannel(channel: Channel) {
    if (!bootstrap || !session) return;
    if (channel.type === "voice") {
      setVoiceTargetChannelId(channel.id);
      setStatus(`已选中语音频道 ${channel.name}，双击进入`);
      return;
    }
    try {
      const nextMessages = await fetchChannelMessages(bootstrap.domain.id, channel.id, session.token);
      startTransition(() => {
        setActiveChannel(channel);
        setMessages(nextMessages);
      });
    } catch (error) {
      console.error(error);
      setStatus("切换频道失败");
    }
  }

  async function joinVoice(channelId?: number) {
    const targetId = channelId || voiceTargetChannelId;
    if (!targetId) return;
    const effectiveAudioInputId = pickPreferredAudioInputId(audioInputs, selectedAudioInputId);
    const traceId = voiceTraceCounterRef.current + 1;
    voiceTraceCounterRef.current = traceId;
    joinTraceRef.current = {
      id: traceId,
      startedAt: performance.now(),
      channelId: targetId,
    };
    try {
      if (effectiveAudioInputId !== selectedAudioInputId) {
        setSelectedAudioInputId(effectiveAudioInputId);
      }
      voiceLog("join:start", {
        traceId,
        channelId: targetId,
        selectedAudioInputId: effectiveAudioInputId,
        noiseSuppressionEnabled,
      });
      setStatus("正在打开麦克风并进入语音房...");
      await rtcRef.current?.setAudioInputDevice(effectiveAudioInputId);
      if (joinTraceRef.current) {
        voiceLog("join:audio-device-applied", {
          traceId,
          elapsedMs: Math.round(performance.now() - joinTraceRef.current.startedAt),
        });
      }
      await rtcRef.current?.setNoiseSuppression(noiseSuppressionEnabled);
      if (joinTraceRef.current) {
        voiceLog("join:noise-suppression-applied", {
          traceId,
          elapsedMs: Math.round(performance.now() - joinTraceRef.current.startedAt),
        });
      }
      await rtcRef.current?.joinVoice(targetId);
      if (joinTraceRef.current) {
        voiceLog("join:rtc.joinVoice-returned", {
          traceId,
          elapsedMs: Math.round(performance.now() - joinTraceRef.current.startedAt),
        });
      }
      setCurrentVoiceChannelId(targetId);
      setVoiceTargetChannelId(targetId);
      setMicEnabled(true);
      setDeafened(false);
      setScreenSharing(false);
      setStatus("正在加入语音房");
    } catch (error) {
      console.error(error);
      voiceLog("join:error", { traceId, error: error instanceof Error ? error.message : String(error) });
      setStatus("麦克风权限失败");
    }
  }

  async function enterVoiceChannel(channel: Channel) {
    if (channel.type !== "voice") return;
    setVoiceTargetChannelId(channel.id);
    if (currentVoiceChannelId === channel.id) {
      setStatus(`已在 ${channel.name} 中`);
      return;
    }
    await joinVoice(channel.id);
  }

  async function leaveVoice() {
    const traceId = voiceTraceCounterRef.current + 1;
    voiceTraceCounterRef.current = traceId;
    leaveTraceRef.current = {
      id: traceId,
      startedAt: performance.now(),
      channelId: currentVoiceChannelId,
    };
    voiceLog("leave:start", { traceId, channelId: currentVoiceChannelId });
    await rtcRef.current?.leaveVoice();
    if (leaveTraceRef.current) {
      voiceLog("leave:rtc.leaveVoice-returned", {
        traceId,
        elapsedMs: Math.round(performance.now() - leaveTraceRef.current.startedAt),
      });
    }
    setCurrentVoiceChannelId(null);
    setVoiceMembers(new Map());
    setRemoteMedia(new Map());
    setMicEnabled(true);
    setDeafened(false);
    setScreenSharing(false);
    setLocalAudioStream(null);
    setLocalScreenStream(null);
    setMaximizedScreenKey(null);
    if (leaveTraceRef.current) {
      voiceLog("leave:local-state-cleared", {
        traceId,
        elapsedMs: Math.round(performance.now() - leaveTraceRef.current.startedAt),
      });
    }
    setStatus("已离开语音房");
  }

  async function toggleMic() {
    const next = !micEnabled;
    if (next && deafened) {
      setDeafened(false);
    }
    setMicEnabled(next);
    await rtcRef.current?.toggleMic(next);
    if (currentVoiceChannelId) {
      socketRef.current?.send("voice.state", {
        channelId: currentVoiceChannelId,
        micEnabled: next,
      });
    }
  }

  async function toggleDeafen() {
    const next = !deafened;
    setDeafened(next);
    if (next && micEnabled) {
      setMicEnabled(false);
      await rtcRef.current?.toggleMic(false);
      if (currentVoiceChannelId) {
        socketRef.current?.send("voice.state", {
          channelId: currentVoiceChannelId,
          micEnabled: false,
        });
      }
    }
    setStatus(next ? "已开启耳机静听，并自动关闭麦克风" : "已关闭耳机静听");
  }

  async function handleAudioInputChange(deviceId: string) {
    setSelectedAudioInputId(deviceId);
    try {
      await rtcRef.current?.setAudioInputDevice(deviceId);
      await rtcRef.current?.prewarmAudio();
      setStatus("麦克风设备已更新");
    } catch (error) {
      console.error(error);
      setStatus("切换麦克风失败");
    }
  }

  async function handleNoiseSuppressionChange(enabled: boolean) {
    setNoiseSuppressionEnabled(enabled);
    try {
      await rtcRef.current?.setNoiseSuppression(enabled);
      await rtcRef.current?.prewarmAudio();
      setStatus(enabled ? "已开启降噪" : "已关闭降噪");
    } catch (error) {
      console.error(error);
      setStatus("更新降噪配置失败");
    }
  }

  function openAudioSettings() {
    if (audioSettingsCloseTimerRef.current) {
      window.clearTimeout(audioSettingsCloseTimerRef.current);
      audioSettingsCloseTimerRef.current = null;
    }
    setShowAudioSettings(true);
    voiceLog("audio-settings:hover-open", {
      selectedAudioInputId: selectedAudioInputId || "auto",
      noiseSuppressionEnabled,
    });
    setAudioPrewarming(true);
    void rtcRef.current
      ?.prewarmAudio()
      .then(async () => {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        const nextInputs = devices
          .filter((device) => device.kind === "audioinput")
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `麦克风 ${index + 1}`,
          }));
        setAudioInputs(nextInputs);
        setSelectedAudioInputId((current) => pickPreferredAudioInputId(nextInputs, current));
      })
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        setAudioPrewarming(false);
      });
  }

  function scheduleCloseAudioSettings() {
    if (audioSettingsCloseTimerRef.current) {
      window.clearTimeout(audioSettingsCloseTimerRef.current);
    }
    audioSettingsCloseTimerRef.current = window.setTimeout(() => {
      setShowAudioSettings(false);
      audioSettingsCloseTimerRef.current = null;
    }, 180);
  }

  function openHeadphoneSettings() {
    if (headphoneSettingsCloseTimerRef.current) {
      window.clearTimeout(headphoneSettingsCloseTimerRef.current);
      headphoneSettingsCloseTimerRef.current = null;
    }
    setShowHeadphoneSettings(true);
  }

  function scheduleCloseHeadphoneSettings() {
    if (headphoneSettingsCloseTimerRef.current) {
      window.clearTimeout(headphoneSettingsCloseTimerRef.current);
    }
    headphoneSettingsCloseTimerRef.current = window.setTimeout(() => {
      setShowHeadphoneSettings(false);
      headphoneSettingsCloseTimerRef.current = null;
    }, 180);
  }

  async function toggleScreenShare() {
    try {
      const next = !screenSharing;
      if (next) {
        await rtcRef.current?.startScreenShare();
      } else {
        await rtcRef.current?.stopScreenShare(false);
      }
      setScreenSharing(next);
      socketRef.current?.send("screen.state", {
        channelId: currentVoiceChannelId,
        screenSharing: next,
      });
    } catch (error) {
      console.error(error);
      setStatus("屏幕共享失败");
    }
  }

  async function sendMessage(body: string) {
    if (!activeChannel || !bootstrap || !session) return;
    const nextBody = body.trim();
    if (!nextBody) return;
    socketRef.current?.send("chat.send", {
      channelId: activeChannel.id,
      body: nextBody,
    });
    setMessageDraft("");
    setShowEmojiPicker(false);
    window.setTimeout(() => {
      if (!bootstrap || !session || activeChannelIdRef.current !== activeChannel.id) return;
      void fetchChannelMessages(bootstrap.domain.id, activeChannel.id, session.token)
        .then((nextMessages) => {
          if (activeChannelIdRef.current === activeChannel.id) {
            setMessages(nextMessages);
          }
        })
        .catch((error) => {
          console.error(error);
        });
    }, 240);
  }

  function appendEmoji(emoji: string) {
    setMessageDraft((value) => `${value}${emoji}`);
    window.requestAnimationFrame(() => {
      messageInputRef.current?.focus();
    });
  }

  function handleSocketEvent(type: string, payload: any) {
    switch (type) {
      case "ready":
        voiceLog("socket:ready", { domainId: payload.domainId, userId: payload.userId });
        setStatus("实时连接就绪");
        if (currentVoiceChannelIdRef.current) {
          socketRef.current?.send("channel.join", {
            channelId: currentVoiceChannelIdRef.current,
          });
        }
        break;
      case "presence.snapshot": {
        if (joinTraceRef.current) {
          voiceLog("join:presence.snapshot", {
            traceId: joinTraceRef.current.id,
            channelId: payload.channelId,
            members: (payload.members || []).length,
            elapsedMs: Math.round(performance.now() - joinTraceRef.current.startedAt),
          });
        }
        const nextMembers = new Map<number, PresenceMember>();
        (payload.members || []).forEach((member: PresenceMember) => {
          nextMembers.set(member.user.id, member);
        });
        setCurrentVoiceChannelId(payload.channelId);
        setVoiceMembers(nextMembers);
        setOnlineCounts((prev) => ({ ...prev, [String(payload.channelId)]: nextMembers.size }));
        void rtcRef.current?.handlePresenceSnapshot(payload.members || []);
        break;
      }
      case "member.joined":
        if (joinTraceRef.current && payload.user?.id === currentUserRef.current?.id) {
          voiceLog("join:member.joined-self", {
            traceId: joinTraceRef.current.id,
            elapsedMs: Math.round(performance.now() - joinTraceRef.current.startedAt),
          });
        }
        if (payload.user?.id) {
          void soundManager.play("join");
        }
        setVoiceMembers((prev) => {
          const next = new Map(prev);
          next.set(payload.user.id, payload as PresenceMember);
          setOnlineCounts((counts) => ({ ...counts, [String(payload.channelId)]: next.size }));
          return next;
        });
        void rtcRef.current?.handleMemberJoined(payload as PresenceMember);
        break;
      case "member.left":
        if (leaveTraceRef.current && payload.userId === currentUserRef.current?.id) {
          voiceLog("leave:member.left-self", {
            traceId: leaveTraceRef.current.id,
            elapsedMs: Math.round(performance.now() - leaveTraceRef.current.startedAt),
          });
        }
        if (payload.userId) {
          void soundManager.play("leave");
        }
        setVoiceMembers((prev) => {
          const next = new Map(prev);
          next.delete(payload.userId as number);
          setOnlineCounts((counts) => ({ ...counts, [String(payload.channelId)]: next.size }));
          return next;
        });
        rtcRef.current?.handleMemberLeft(payload.userId as number);
        break;
      case "chat.message":
        if (payload.messageType === "chat" && payload.channelId === activeChannelIdRef.current) {
          void soundManager.play("chat");
        }
        if (payload.channelId === activeChannelIdRef.current) {
          setMessages((prev) => [...prev, payload as Message]);
        }
        break;
      case "voice.state":
        if (payload.userId === currentUserRef.current?.id) {
          setMicEnabled(Boolean(payload.micEnabled));
        }
        setVoiceMembers((prev) => {
          const next = new Map(prev);
          const current = next.get(payload.userId as number);
          if (current) {
            next.set(payload.userId as number, { ...current, micEnabled: payload.micEnabled as boolean });
          }
          return next;
        });
        if (payload.userId) {
          rtcRef.current?.handleVoiceState(payload.userId as number, Boolean(payload.micEnabled));
        }
        break;
      case "screen.state":
        if (payload.userId === currentUserRef.current?.id) {
          setScreenSharing(Boolean(payload.screenSharing));
        }
        setVoiceMembers((prev) => {
          const next = new Map(prev);
          const current = next.get(payload.userId as number);
          if (current) {
            next.set(payload.userId as number, { ...current, screenSharing: payload.screenSharing as boolean });
          }
          return next;
        });
        if (payload.userId) {
          rtcRef.current?.handleScreenState(payload.userId as number, Boolean(payload.screenSharing));
        }
        break;
      case "screen.sync_request":
      case "media.sync_request":
      case "rtc.offer":
      case "rtc.answer":
      case "rtc.ice_candidate":
        void rtcRef.current?.handleSignal(type, payload);
        break;
      case "error":
        setStatus(String(payload.message || "实时事件出错"));
        break;
      default:
        break;
    }
  }

  const selectedVoiceCount = currentVoiceChannelId
    ? (voiceChannelMembers[String(currentVoiceChannelId)] || []).length || voiceMembers.size
    : 0;
  const canManageDomain = bootstrap?.currentRole === "owner";
  const categories = bootstrap?.categories || [];
  const allChannels = categories.flatMap((category) => category.channels);
  const firstTextChannel = allChannels.find((channel) => channel.type === "text") || null;
  const currentVoiceChannel = allChannels.find((channel) => channel.id === currentVoiceChannelId) || null;
  const chatChannel = activeChannel?.type === "text" ? activeChannel : firstTextChannel;
  const screenPreviews: ScreenPreview[] = [];
  if (user && localScreenStream) {
    screenPreviews.push({
      key: `local-${user.id}`,
      user,
      stream: localScreenStream,
      isLocal: true,
    });
  }
  [...remoteMedia.values()].forEach((entry) => {
    if (!entry.screenStream) return;
    screenPreviews.push({
      key: `remote-${entry.user.id}`,
      user: entry.user,
      stream: entry.screenStream,
      isLocal: false,
    });
  });
  const maximizedScreen = screenPreviews.find((item) => item.key === maximizedScreenKey) || null;

  useEffect(() => {
    if (!maximizedScreenKey) return;
    if (!screenPreviews.some((item) => item.key === maximizedScreenKey)) {
      setMaximizedScreenKey(null);
    }
  }, [maximizedScreenKey, screenPreviews]);

  const voiceMembersList = [...voiceMembers.values()].sort((left, right) => {
    if (left.user.id === user?.id) return -1;
    if (right.user.id === user?.id) return 1;
    if (left.screenSharing !== right.screenSharing) {
      return Number(right.screenSharing) - Number(left.screenSharing);
    }
    return left.user.displayName.localeCompare(right.user.displayName, "zh-CN");
  });
  const onlineMemberIds = new Set(onlineUsers.keys());
  const channelNameById = new Map<number, string>();
  categories.forEach((category) => {
    category.channels.forEach((channel) => {
      channelNameById.set(channel.id, channel.name);
    });
  });

  useEffect(() => {
    if (!session || !bootstrap || !chatChannel) return;
    if (activeChannel?.type !== "voice" || currentVoiceChannelId) return;

    void fetchChannelMessages(bootstrap.domain.id, chatChannel.id, session.token)
      .then((nextMessages) => {
        setMessages(nextMessages);
      })
      .catch((error) => {
        console.error(error);
      });
  }, [session, bootstrap, chatChannel, activeChannel?.type, currentVoiceChannelId]);

  return (
    <div className="app-shell">
      <aside className="server-rail">
        <div className="brand">
          Oopz<span>.</span>
        </div>
        <div className="server-icons">
          {(bootstrap?.domains || []).map((domain) => (
            <button
              key={domain.id}
              className={`server-icon ${bootstrap?.domain.id === domain.id ? "server-icon--active" : ""}`}
              title={`${domain.name} · ${domain.role === "owner" ? "域主" : domain.role === "member" ? "成员" : "可见未加入"}`}
              onClick={() => void switchDomain(domain.id)}
            >
              {initials(domain.name)}
            </button>
          ))}
          <button className="server-icon server-icon--plus" title="创建域" onClick={() => setCreatingDomain(true)}>
            +
          </button>
        </div>
      </aside>

      <aside className="channel-sidebar">
        <div className="sidebar-topbar">
          <div className="sidebar-topbar__controls">
            <div className="sidebar-control-pill">
              <div
                className="mic-settings-anchor"
                onMouseEnter={openAudioSettings}
                onMouseLeave={scheduleCloseAudioSettings}
              >
                <button
                  className={`sidebar-icon-button ${micEnabled ? "" : "sidebar-icon-button--danger"} ${audioSetupPending ? "sidebar-icon-button--loading" : ""}`}
                  title={micEnabled ? "关闭麦克风" : "打开麦克风"}
                  aria-label={micEnabled ? "关闭麦克风" : "打开麦克风"}
                  onClick={() => void toggleMic()}
                >
                  {micEnabled ? <MicIcon /> : <MicOffIcon />}
                  {audioSetupPending ? <span className="sidebar-icon-button__spinner" aria-hidden="true" /> : null}
                </button>
                {showAudioSettings ? (
                  <div className="audio-settings-panel" onMouseEnter={openAudioSettings} onMouseLeave={scheduleCloseAudioSettings}>
                    <div className="audio-settings-panel__status">
                      <span className={`audio-settings-panel__status-dot ${audioSetupPending ? "audio-settings-panel__status-dot--loading" : ""}`} />
                      <strong>
                        {audioDevicesLoading ? "正在加载音频设备..." : audioPrewarming ? "正在预热麦克风..." : "音频设备已就绪"}
                      </strong>
                    </div>
                    <div className="audio-settings-panel__slider">
                      <input type="range" min="0" max="100" defaultValue="52" aria-label="麦克风灵敏度" />
                    </div>
                    <div className="audio-settings-panel__line" />
                    <label className="audio-settings-field">
                      <span>输入设备</span>
                      <select value={selectedAudioInputId} onChange={(event) => void handleAudioInputChange(event.target.value)}>
                        {audioInputs.length ? (
                          audioInputs.map((input) => (
                            <option key={input.deviceId} value={input.deviceId}>
                              {input.label}
                            </option>
                          ))
                        ) : (
                          <option value="">未检测到麦克风</option>
                        )}
                      </select>
                    </label>
                    <label className="audio-switch-row">
                      <div>
                        <strong>AI 智能降噪</strong>
                        <span>启用浏览器噪音抑制</span>
                      </div>
                      <button
                        type="button"
                        className={`switch-button ${noiseSuppressionEnabled ? "switch-button--active" : ""}`}
                        onClick={() => void handleNoiseSuppressionChange(!noiseSuppressionEnabled)}
                      >
                        <span />
                      </button>
                    </label>
                    <label className="audio-switch-row">
                      <div>
                        <strong>麦克风增强</strong>
                        <span>自动增益与回声消除</span>
                      </div>
                      <button type="button" className="switch-button switch-button--active" disabled>
                        <span />
                      </button>
                    </label>
                  </div>
                ) : null}
              </div>
              <div
                className="mic-settings-anchor"
                onMouseEnter={openHeadphoneSettings}
                onMouseLeave={scheduleCloseHeadphoneSettings}
              >
                <button
                  className={`sidebar-icon-button ${deafened ? "sidebar-icon-button--active" : ""}`}
                  title={deafened ? "关闭耳机静听" : "开启耳机静听"}
                  aria-label={deafened ? "关闭耳机静听" : "开启耳机静听"}
                  onClick={() => void toggleDeafen()}
                >
                  <HeadphoneIcon />
                </button>
                {showHeadphoneSettings ? (
                  <div className="audio-settings-panel" onMouseEnter={openHeadphoneSettings} onMouseLeave={scheduleCloseHeadphoneSettings}>
                    <div className="audio-settings-panel__status">
                      <span className={`audio-settings-panel__status-dot ${deafened ? "" : "audio-settings-panel__status-dot--loading"}`} />
                      <strong>{deafened ? "耳机静听已开启" : "远端声音输出中"}</strong>
                    </div>
                    <div className="audio-settings-panel__slider">
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={remoteVolume}
                        aria-label="远端音量"
                        onChange={(event) => setRemoteVolume(Number(event.target.value))}
                      />
                    </div>
                    <div className="audio-settings-panel__line" />
                    <label className="audio-switch-row">
                      <div>
                        <strong>耳机静听</strong>
                        <span>开启后听不到任何人，并自动关闭麦克风</span>
                      </div>
                      <button
                        type="button"
                        className={`switch-button ${deafened ? "switch-button--active" : ""}`}
                        onClick={() => void toggleDeafen()}
                      >
                        <span />
                      </button>
                    </label>
                  </div>
                ) : null}
              </div>
              <button
                className="sidebar-icon-button sidebar-icon-button--danger"
                title="挂断通话"
                aria-label="挂断通话"
                disabled={!currentVoiceChannelId}
                onClick={() => void leaveVoice()}
              >
                <HangupIcon />
              </button>
            </div>
          </div>
          <div className="profile-menu-wrap" ref={profileMenuRef}>
            <button
              className="profile-chip"
              onClick={() => setShowProfileMenu((value) => !value)}
              title="账号菜单"
              aria-label="账号菜单"
            >
              <div className="profile-chip__avatar" style={{ background: user?.avatarColor || "#556" }}>
                {initials(user?.displayName)}
              </div>
              <span className="profile-chip__dot" />
            </button>
            {showProfileMenu ? (
              <div className="profile-menu">
                <div className="profile-menu__identity">
                  <strong>{user?.displayName || "Guest"}</strong>
                  <span>{user?.email || user?.handle || "当前账号"}</span>
                </div>
                <button
                  className="profile-menu__item profile-menu__item--danger"
                  onClick={() => {
                    setShowProfileMenu(false);
                    logout();
                  }}
                >
                  退出登录
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="domain-card">
          <div className="domain-card__header">
            <div>
              <h1>{bootstrap?.domain.name || "Oopz Live"}</h1>
              <div className="domain-id-row">
                <span>ID: {bootstrap?.domain.id || "--"}</span>
                <button className="tiny-icon-button" title="复制域 ID" aria-label="复制域 ID">
                  <CopyIcon />
                </button>
              </div>
            </div>
            <button className="tiny-icon-button" title="更多选项" aria-label="更多选项">
              <MoreIcon />
            </button>
          </div>
          <div className="domain-banner">
            <div className="domain-banner__badge">{bootstrap?.domain.name || "Oopz"}</div>
          </div>
          <button
            className={`home-button ${activeChannel?.id === firstTextChannel?.id ? "home-button--active" : ""}`}
            onClick={() => (firstTextChannel ? void selectChannel(firstTextChannel) : undefined)}
          >
            <HomeIcon />
            <span>主页</span>
          </button>
          {canManageDomain ? (
            <div className="domain-owner-actions">
              <button className="action-pill" onClick={() => setChannelComposerType("text")}>
                + 文字频道
              </button>
              <button className="action-pill" onClick={() => setChannelComposerType("voice")}>
                + 语音频道
              </button>
            </div>
          ) : null}
        </div>

        <section className="channel-list-section">
          <div className="channel-tree">
            {categories.map((category) => (
                <div key={category.id} className="channel-group">
                  <div className="channel-group__title">{category.name}</div>
                  {category.channels.map((channel) => (
                    <div key={channel.id} className="channel-item-wrap">
                      <button
                        className={`channel-item ${
                          channel.type === "text"
                            ? activeChannel?.id === channel.id
                              ? "channel-item--active"
                              : ""
                            : currentVoiceChannelId === channel.id || voiceTargetChannelId === channel.id
                              ? "channel-item--active"
                              : ""
                        }`}
                        onClick={() => void selectChannel(channel)}
                        onDoubleClick={() => void enterVoiceChannel(channel)}
                      >
                        <span>{channel.type === "voice" ? <VoiceChannelIcon /> : <HashIcon />}</span>
                        <span className="channel-item__name">{channel.name}</span>
                        {channel.type === "voice" ? (
                          <span className="channel-item__meta">
                            {onlineCounts[String(channel.id)] || 0}/{channel.maxMembers}
                          </span>
                        ) : null}
                      </button>
                      {channel.type === "voice" && (voiceChannelMembers[String(channel.id)] || []).length ? (
                        <div className="channel-presence-list">
                          {(voiceChannelMembers[String(channel.id)] || []).slice(0, 4).map((member) => (
                            <div key={member.user.id} className="channel-presence-pill">
                              <div className="channel-presence-pill__avatar" style={{ background: member.user.avatarColor }}>
                                {initials(member.user.displayName)}
                              </div>
                              <span>{member.user.displayName}</span>
                            </div>
                          ))}
                          {(voiceChannelMembers[String(channel.id)] || []).length > 4 ? (
                            <div className="channel-presence-more">+{(voiceChannelMembers[String(channel.id)] || []).length - 4}</div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
            ))}
          </div>
        </section>
      </aside>

      <main className="main-panel">
        <RemoteAudioLayer remoteMedia={remoteMedia} selfUserId={user?.id || 0} deafened={deafened} remoteVolume={remoteVolume} />
        <div className="top-utility-bar">
          <div className="top-utility-bar__left">
            <button className="utility-circle">
              <PhoneIcon />
            </button>
            <button className="utility-circle">
              <ChatIcon />
            </button>
            <label className="search-box">
              <SearchIcon />
              <input type="text" placeholder="搜索你感兴趣的域" />
            </label>
          </div>
          <div className="top-utility-bar__right">
            <button className="membership-pill">开通会员</button>
            <button className="utility-ghost">
              <DownloadIcon />
            </button>
            <button className="utility-ghost">
              <MenuIcon />
            </button>
          </div>
        </div>

        {currentVoiceChannel ? (
          <section className="voice-presence-dock">
            <div className="voice-presence-dock__title">
              <div>
                <div className="voice-presence-dock__heading">
                  <VoiceChannelIcon />
                  <strong>{currentVoiceChannel.name}</strong>
                  <span>{selectedVoiceCount.toString().padStart(2, "0")}/{currentVoiceChannel.maxMembers || 50}</span>
                </div>
                <p>点击共享预览可放大，讲话时头像边框会高亮。</p>
              </div>
              <div className="voice-presence-dock__actions">
                <span className={`connection-badge ${wsConnected ? "connection-badge--online" : ""}`}>{status}</span>
                <button className="action-pill">邀请/分享</button>
                <button
                  className={`round-action ${screenSharing ? "round-action--active" : ""}`}
                  title={screenSharing ? "停止屏幕共享" : "开始屏幕共享"}
                  aria-label={screenSharing ? "停止屏幕共享" : "开始屏幕共享"}
                  disabled={!currentVoiceChannelId}
                  onClick={() => void toggleScreenShare()}
                >
                  {screenSharing ? <ScreenOffIcon /> : <ScreenShareIcon />}
                </button>
              </div>
            </div>
            <div className="voice-presence-dock__avatars">
              {voiceMembersList.length ? (
                voiceMembersList.map((member) => (
                  <VoiceAvatarOrb
                    key={member.user.id}
                    user={member.user}
                    stream={member.user.id === user?.id ? localAudioStream : remoteMedia.get(member.user.id)?.audioStream || null}
                    screenStream={member.user.id === user?.id ? localScreenStream : remoteMedia.get(member.user.id)?.screenStream || null}
                    onMaximizeScreen={
                      member.user.id === user?.id
                        ? localScreenStream
                          ? () => setMaximizedScreenKey(`local-${member.user.id}`)
                          : undefined
                        : remoteMedia.get(member.user.id)?.screenStream
                          ? () => setMaximizedScreenKey(`remote-${member.user.id}`)
                          : undefined
                    }
                    micEnabled={member.user.id === user?.id ? micEnabled : member.micEnabled}
                    screenSharing={member.screenSharing}
                    isCurrentUser={member.user.id === user?.id}
                  />
                ))
              ) : (
                <div className="empty-state empty-state--small">暂无在线语音成员</div>
              )}
            </div>
          </section>
        ) : null}

        <section className="chat-panel">
          <div className="chat-panel__toolbar">
            <div className="chat-panel__title">
              <div className="chat-panel__title-icon">
                {chatChannel?.type === "text" ? <HomeIcon /> : <HashIcon />}
              </div>
              <div>
                <h3>{chatChannel?.name || "主页"}</h3>
                <span>{chatChannel?.topic || bootstrap?.domain.description || "域内消息会显示在这里。"}</span>
              </div>
            </div>
            <div className="chat-panel__icons">
              <button className="plain-icon-button">
                <SendIcon />
              </button>
              <button className="plain-icon-button">
                <TagIcon />
              </button>
              <button className="plain-icon-button">
                <ListIcon />
              </button>
            </div>
          </div>
          <div className="message-list" ref={messageListRef}>
            {!deferredMessages.length ? (
              <div className="empty-state">这里还没有消息。可以先发一句，或者直接进入语音房。</div>
            ) : (
              deferredMessages.map((message) => (
                <article key={message.id} className={`message-row ${message.messageType === "system" ? "message-row--system" : ""}`}>
                  <div className="avatar" style={{ background: message.userAvatarColor }}>
                    {initials(message.userDisplayName)}
                  </div>
                  <div className="message-body">
                    <div className="message-meta">
                      <strong>{message.userDisplayName}</strong>
                      <span>{formatTime(message.createdAt)}</span>
                    </div>
                    <p dangerouslySetInnerHTML={{ __html: escapeHTML(message.body) }} />
                  </div>
                </article>
              ))
            )}
          </div>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage(messageDraft);
            }}
          >
            <div className="composer__box">
              <div className="composer__input-wrap">
                <textarea
                  ref={messageInputRef}
                  name="message"
                  placeholder={`发送至频道 ${chatChannel?.name || "主页"}`}
                  rows={1}
                  value={messageDraft}
                  onChange={(event) => setMessageDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage(messageDraft);
                    }
                  }}
                />
                {showEmojiPicker ? (
                  <div className="emoji-picker" ref={emojiPickerRef}>
                    {EMOJI_GROUPS.map((group) => (
                      <div key={group.label} className="emoji-picker__group">
                        <div className="emoji-picker__label">{group.label}</div>
                        <div className="emoji-picker__grid">
                          {group.items.map((emoji) => (
                            <button key={emoji} type="button" className="emoji-picker__item" onClick={() => appendEmoji(emoji)}>
                              {emoji}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="composer__actions">
                <button className="plain-icon-button" type="button">
                  <ReturnIcon />
                </button>
                <button className={`plain-icon-button ${showEmojiPicker ? "plain-icon-button--active" : ""}`} type="button" onClick={() => setShowEmojiPicker((value) => !value)}>
                  <SmileIcon />
                </button>
                <button className="plain-icon-button" type="button">
                  <PlusIcon />
                </button>
                <button className="plain-icon-button" type="button">
                  <ExpandIcon />
                </button>
                <button className="composer__send-button" type="submit" disabled={!messageDraft.trim()}>
                  发送
                </button>
              </div>
            </div>
          </form>
        </section>
      </main>

      <aside className="member-sidebar">
        <div className="member-sidebar__header">
          <div className="eyebrow">MEMBERS</div>
          <div className="member-sidebar__title-row">
            <div className="member-sidebar__channel-tools">
              <button className="plain-icon-button">
                <SendIcon />
              </button>
              <button className="plain-icon-button">
                <TagIcon />
              </button>
              <button className="plain-icon-button">
                <ListIcon />
              </button>
            </div>
            <div className="member-sidebar__summary">
              <span>{bootstrap?.domain.name}</span>
              <span> - {(bootstrap?.members || []).filter((member) => onlineMemberIds.has(member.id)).length}</span>
            </div>
            <button className="plain-icon-button">
              <SearchIcon />
            </button>
          </div>
        </div>

        <div className="member-list">
          <MemberSection
            title="在线"
            members={(bootstrap?.members || []).filter((member) => onlineMemberIds.has(member.id))}
            voiceMembers={voiceMembers}
            onlineUsers={onlineUsers}
            channelNameById={channelNameById}
          />
          <MemberSection
            title="离线"
            members={(bootstrap?.members || []).filter((member) => !onlineMemberIds.has(member.id))}
            voiceMembers={voiceMembers}
            onlineUsers={onlineUsers}
            channelNameById={channelNameById}
          />
        </div>
      </aside>

      {!session ? (
        <div className="identity-modal identity-modal--visible">
          <div className="identity-modal__card">
            <div className="eyebrow">ACCOUNT ACCESS</div>
            <h2>先注册或登录账号，再测试不同用户之间的通信。</h2>
            <p>你可以开两个浏览器窗口，用两个账号同时进入同一个频道做消息与 WebRTC 联调。</p>

            <div className="toggle-row">
              <button className="action-pill" onClick={() => setAuthMode("register")}>
                注册
              </button>
              <button className="action-pill" onClick={() => setAuthMode("login")}>
                登录
              </button>
            </div>

            {authMode === "register" ? (
              <input maxLength={32} placeholder="昵称" value={displayNameInput} onChange={(event) => setDisplayNameInput(event.target.value)} />
            ) : null}
            <input type="email" placeholder="邮箱" value={emailInput} onChange={(event) => setEmailInput(event.target.value)} />
            {authMode === "register" ? (
              <div className="identity-modal__code-row">
                <input
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6 位邮箱验证码"
                  value={verificationCodeInput}
                  onChange={(event) => setVerificationCodeInput(event.target.value.replace(/\D+/g, "").slice(0, 6))}
                />
                <button
                  className="action-pill"
                  disabled={sendingVerificationCode || verificationCooldown > 0}
                  onClick={() => void requestVerificationCode()}
                >
                  {sendingVerificationCode ? "发送中..." : verificationCooldown > 0 ? `${verificationCooldown}s` : "发送验证码"}
                </button>
              </div>
            ) : null}
            <input type="password" placeholder="密码（至少 6 位）" value={passwordInput} onChange={(event) => setPasswordInput(event.target.value)} />

            <button className="action-pill action-pill--primary action-pill--full" disabled={submittingAuth} onClick={() => void submitAuth()}>
              {submittingAuth ? "处理中..." : authMode === "register" ? "注册并进入" : "登录并进入"}
            </button>
          </div>
        </div>
      ) : null}

      {session && creatingDomain ? (
        <div className="identity-modal identity-modal--visible">
          <div className="identity-modal__card">
            <div className="eyebrow">NEW DOMAIN</div>
            <h2>创建一个新的域</h2>
            <p>创建后你会自动成为这个域的域主，并拥有创建频道的权限。</p>
            <input maxLength={48} placeholder="域名称" value={domainNameInput} onChange={(event) => setDomainNameInput(event.target.value)} />
            <input
              maxLength={120}
              placeholder="域描述"
              value={domainDescriptionInput}
              onChange={(event) => setDomainDescriptionInput(event.target.value)}
            />
            <div className="toggle-row">
              <button className="action-pill action-pill--primary" disabled={submittingDomain} onClick={() => void submitCreateDomain()}>
                {submittingDomain ? "创建中..." : "创建域"}
              </button>
              <button className="action-pill" onClick={() => setCreatingDomain(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {session && channelComposerType ? (
        <div className="identity-modal identity-modal--visible">
          <div className="identity-modal__card">
            <div className="eyebrow">{channelComposerType === "text" ? "TEXT CHANNEL" : "VOICE CHANNEL"}</div>
            <h2>创建{channelComposerType === "text" ? "文字" : "语音"}频道</h2>
            <p>只有域主可以创建频道，创建后会自动出现在左侧频道列表。</p>
            <input maxLength={48} placeholder="频道名称" value={channelNameInput} onChange={(event) => setChannelNameInput(event.target.value)} />
            <input maxLength={120} placeholder="频道描述 / Topic" value={channelTopicInput} onChange={(event) => setChannelTopicInput(event.target.value)} />
            <div className="toggle-row">
              <button className="action-pill action-pill--primary" disabled={submittingChannel} onClick={() => void submitCreateChannel()}>
                {submittingChannel ? "创建中..." : "创建频道"}
              </button>
              <button className="action-pill" onClick={() => setChannelComposerType(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {maximizedScreen ? <ScreenPreviewModal screen={maximizedScreen} onClose={() => setMaximizedScreenKey(null)} /> : null}
    </div>
  );
}

function MemberSection({
  title,
  members,
  voiceMembers,
  onlineUsers,
  channelNameById,
}: {
  title: string;
  members: DomainMember[];
  voiceMembers: Map<number, PresenceMember>;
  onlineUsers: Map<number, OnlineUserPresence>;
  channelNameById: Map<number, string>;
}) {
  const sortedMembers = [...members].sort((left, right) => {
    if (left.role !== right.role) {
      if (left.role === "owner") return -1;
      if (right.role === "owner") return 1;
    }
    return left.displayName.localeCompare(right.displayName, "zh-CN");
  });

  return (
    <section className="member-section">
      <h4>
        {title} · {members.length}
      </h4>
      {members.length ? (
        sortedMembers.map((member) => {
          const presence = voiceMembers.get(member.id);
          const online = onlineUsers.get(member.id);
          return (
            <div key={member.id} className="member-row">
              <div className="avatar" style={{ background: member.avatarColor }}>
                {initials(member.displayName)}
              </div>
              <div className="member-row__content">
                <strong>{member.displayName}</strong>
                <span>
                  {presence
                    ? `${presence.micEnabled ? "Mic On" : "Muted"} · ${presence.screenSharing ? "Sharing" : "No Share"}`
                    : online
                      ? online.currentChannelId
                        ? `在线 · 正在 ${channelNameById.get(online.currentChannelId) || "语音频道"}`
                        : "在线"
                      : member.email || member.role}
                </span>
              </div>
            </div>
          );
        })
      ) : (
        <div className="empty-state empty-state--small">暂无成员</div>
      )}
    </section>
  );
}

function VoiceAvatarOrb({
  user,
  stream,
  screenStream,
  onMaximizeScreen,
  micEnabled,
  screenSharing,
  isCurrentUser,
}: {
  user: User;
  stream: MediaStream | null;
  screenStream: MediaStream | null;
  onMaximizeScreen?: () => void;
  micEnabled: boolean;
  screenSharing: boolean;
  isCurrentUser: boolean;
}) {
  const speaking = useSpeakingState(stream, micEnabled);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!videoRef.current || !screenStream) return;
    videoRef.current.srcObject = screenStream;
    void videoRef.current.play().catch(() => undefined);
  }, [screenStream]);

  async function openSystemFullscreen() {
    if (!screenStream || !previewRef.current) return;
    try {
      await previewRef.current.requestFullscreen();
    } catch (error) {
      console.error(error);
    }
  }

  return (
    <div className={`voice-orb ${screenSharing && screenStream ? "voice-orb--sharing" : ""}`}>
      <div
        ref={previewRef}
        className={`voice-orb__button ${screenStream ? "voice-orb__button--preview" : ""}`}
        onClick={screenStream && onMaximizeScreen ? onMaximizeScreen : undefined}
        role={screenStream ? "button" : undefined}
        tabIndex={screenStream ? 0 : undefined}
        onKeyDown={
          screenStream && onMaximizeScreen
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onMaximizeScreen();
                }
              }
            : undefined
        }
      >
        <div
          className={`voice-orb__avatar ${speaking ? "voice-orb__avatar--speaking" : ""} ${screenSharing ? "voice-orb__avatar--sharing" : ""}`}
          style={{ background: user.avatarColor }}
        >
          {screenSharing && screenStream ? (
            <>
              <video ref={videoRef} autoPlay playsInline muted className="voice-orb__screen" />
              <div className="voice-orb__preview-actions">
                <button
                  className="voice-orb__preview-tag"
                  onClick={(event) => {
                    event.stopPropagation();
                    onMaximizeScreen?.();
                  }}
                >
                  放大
                </button>
                <button
                  className="voice-orb__preview-tag"
                  onClick={(event) => {
                    event.stopPropagation();
                    void openSystemFullscreen();
                  }}
                >
                  全屏
                </button>
              </div>
            </>
          ) : (
            initials(user.displayName)
          )}
        </div>
      </div>
      <strong>{user.displayName}</strong>
      <span>
        {screenSharing && screenStream
          ? isCurrentUser
            ? "你 · 正在共享，可放大或全屏"
            : "正在共享，可放大或全屏"
          : isCurrentUser
            ? micEnabled
              ? "你 · 麦克风开启"
              : "你 · 已静音"
            : micEnabled
              ? "麦克风开启"
              : "已静音"}
      </span>
    </div>
  );
}

function RemoteAudioLayer({
  remoteMedia,
  selfUserId,
  deafened,
  remoteVolume,
}: {
  remoteMedia: Map<number, RemoteMedia>;
  selfUserId: number;
  deafened: boolean;
  remoteVolume: number;
}) {
  const audioRefs = useRef(new Map<number, HTMLAudioElement>());

  useEffect(() => {
    const activeIds = new Set<number>();

    remoteMedia.forEach((entry, userId) => {
      if (!entry.audioStream || userId === selfUserId) return;
      activeIds.add(userId);
      const element = audioRefs.current.get(userId);
      if (!element) return;
      if (element.srcObject !== entry.audioStream) {
        element.srcObject = entry.audioStream;
      }
      element.muted = deafened;
      element.volume = Math.max(0, Math.min(1, remoteVolume / 100));
      void element.play().catch((error) => {
        console.error("remote audio play failed", error);
      });
    });

    audioRefs.current.forEach((element, userId) => {
      if (activeIds.has(userId)) return;
      element.pause();
      element.srcObject = null;
    });
  }, [deafened, remoteMedia, remoteVolume, selfUserId]);

  return (
    <div className="remote-audio-layer" aria-hidden="true">
      {[...remoteMedia.entries()].map(([userId]) => (
        <audio
          key={userId}
          ref={(node) => {
            if (node) {
              audioRefs.current.set(userId, node);
            } else {
              audioRefs.current.delete(userId);
            }
          }}
          autoPlay
          playsInline
        />
      ))}
    </div>
  );
}

function useSpeakingState(stream: MediaStream | null, enabled: boolean) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (!stream || !enabled) {
      setSpeaking(false);
      return;
    }

    const [audioTrack] = stream.getAudioTracks();
    if (!audioTrack) {
      setSpeaking(false);
      return;
    }

    let frame = 0;
    let cancelled = false;
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.35;
    const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
    const buffer = new Uint8Array(analyser.frequencyBinCount);

    source.connect(analyser);

    const readLevel = () => {
      if (cancelled) return;
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const centered = (buffer[index] - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / buffer.length);
      setSpeaking(rms > 0.045);
      frame = window.requestAnimationFrame(readLevel);
    };

    void audioContext.resume().catch(() => undefined);
    frame = window.requestAnimationFrame(readLevel);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      void audioContext.close().catch(() => undefined);
    };
  }, [stream, enabled]);

  return speaking;
}

function ScreenPreviewModal({
  screen,
  onClose,
}: {
  screen: ScreenPreview;
  onClose: () => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.srcObject = screen.stream;
    void videoRef.current.play().catch(() => undefined);
  }, [screen.stream]);

  async function openSystemFullscreen() {
    if (!frameRef.current) return;
    try {
      await frameRef.current.requestFullscreen();
    } catch (error) {
      console.error(error);
    }
  }

  return (
    <div className="screen-modal">
      <div className="screen-modal__panel" ref={frameRef}>
        <div className="screen-modal__toolbar">
          <div>
            <div className="eyebrow">SCREEN PREVIEW</div>
            <strong>{screen.user.displayName}{screen.isLocal ? " · 你的共享屏幕" : " · 正在共享屏幕"}</strong>
          </div>
          <div className="screen-modal__actions">
            <button className="action-pill" onClick={() => void openSystemFullscreen()}>
              系统全屏
            </button>
            <button className="action-pill" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        <video ref={videoRef} autoPlay playsInline muted className="screen-modal__video" />
      </div>
    </div>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4M9 21h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4l16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M9.2 9.2V7a2.8 2.8 0 1 1 5.6 0v5a2.7 2.7 0 0 1-.3 1.3M6.6 11.5a5.5 5.5 0 0 0 8.6 4.5M12 17v4M9 21h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ScreenShareIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="11.5" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 20h7M12 16.8V20M12 9l3 3m-3-3-3 3m3-3v6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ScreenOffIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="11.5" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4 4l16 16M8.5 20h7M12 16.8V20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HangupIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.2 15.5c3.9-3.6 9.7-3.6 13.6 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M7.2 14.8 5 17.5M16.8 14.8l2.2 2.7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HeadphoneIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 13a7.5 7.5 0 1 1 15 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="4" y="12" width="4.2" height="7" rx="2.1" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="15.8" y="12" width="4.2" height="7" rx="2.1" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="8" width="10" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="5" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="19" r="1.7" fill="currentColor" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.2" y="4.5" width="15.6" height="15" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 12h7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function VoiceChannelIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function HashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.7 4.8a1.8 1.8 0 0 1 2.4-.2l2.2 1.8a1.8 1.8 0 0 1 .4 2.3l-.9 1.6a14 14 0 0 0 3.2 3.2l1.6-.9a1.8 1.8 0 0 1 2.3.4l1.8 2.2a1.8 1.8 0 0 1-.2 2.4l-1.1 1a3 3 0 0 1-3.2.6c-2.8-1.1-5.3-3-7.5-5.2s-4-4.7-5.2-7.5a3 3 0 0 1 .6-3.2l1-1.1Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H10l-4.5 4v-4A2.5 2.5 0 0 1 3 12.5v-6Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M8 8.7h8M8 11.8h5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v10m0 0 3-3m-3 3-3-3M5 18.5h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7.5h14M5 12h14M5 16.5h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m20 4-7.4 16-2.4-6.2L4 11.4 20 4Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4h5l3 3v5l-9 9-7-7 8-10Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <circle cx="14.5" cy="8.5" r="1.2" fill="currentColor" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 7h11M8 12h11M8 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ReturnIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 6v8a3 3 0 0 1-3 3H7m0 0 3.5-3.5M7 17l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SmileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 10h.01M15 10h.01" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M8.5 14c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 4H4v5M15 20h5v-5M20 9V4h-5M4 15v5h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 9 9 4M15 20l5-5M20 9l-5-5M4 15l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
