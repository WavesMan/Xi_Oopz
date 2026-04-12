import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";

import { NoticeViewport } from "../components/live/NoticeViewport";
import { ScreenShareSheet } from "../components/live/ScreenShareSheet";
import { MemberSection, RemoteAudioLayer, ScreenPreviewModal, VoiceAvatarOrb } from "../components/live/voiceAndMember";
import { ScreeningPlaylistSection, ScreeningRoomPanel } from "../components/live/screening";
import {
  ChatIcon,
  CopyIcon,
  DownloadIcon,
  ExpandIcon,
  HangupIcon,
  HashIcon,
  HomeIcon,
  HeadphoneIcon,
  ListIcon,
  MenuIcon,
  MicIcon,
  MicOffIcon,
  MoreIcon,
  PhoneIcon,
  PlayIcon,
  PlusIcon,
  ReturnIcon,
  ScreenOffIcon,
  ScreenShareIcon,
  SearchIcon,
  SendIcon,
  SmileIcon,
  TagIcon,
  VoiceChannelIcon,
} from "../components/live/icons";
import { useNoticeDomain } from "../hooks/useNoticeDomain";
import { useSessionDomain } from "../hooks/useSessionDomain";
import { RTCController, type ScreenShareOptions } from "../rtc";
import { liveFacade } from "../services/liveFacade";
import { loadSession } from "../services/session";
import { soundManager } from "../sound";
import { SocketClient } from "../socket";
import type {
  BootstrapResponse,
  Channel,
  DomainMember,
  Message,
  OnlineUserPresence,
  PeerConnectionDiagnostics,
  PresenceMember,
  RemoteMedia,
  ScreeningPlaylistItem,
  ScreeningSnapshot,
  ScreeningState,
  User,
} from "../types";
import type { AudioInputOption, ScreenPreview, ScreenSharePreset, Session } from "../types/live";
import { escapeHTML, formatTime, initials, pickPreferredAudioInputId } from "../utils/live";

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

const SCREENING_DEBUG_LABELS = new Set([
  "screening:join:send",
  "screening:snapshot:received",
  "screening:controller:changed",
  "screening:player:src-assigned",
]);

const EMOJI_GROUPS: Array<{ label: string; items: string[] }> = [
  { label: "常用", items: ["😀", "😂", "🤣", "😊", "😍", "🥰", "😭", "😅", "🤔", "😎"] },
  { label: "互动", items: ["👍", "👎", "👏", "🙏", "💪", "👌", "🤝", "👀", "🎉", "❤️"] },
  { label: "气氛", items: ["🔥", "✨", "💯", "🚀", "🎮", "🎵", "☕", "🍕", "🥳", "🌈"] },
];

export function LivePage() {
  const [session, setSession] = useState<Session | null>(() => loadSession<Session>());
  const [user, setUser] = useState<User | null>(() => loadSession<Session>()?.user || null);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const deferredMessages = useDeferredValue(messages);
  const [voiceMembers, setVoiceMembers] = useState<Map<number, PresenceMember>>(new Map());
  const [remoteMedia, setRemoteMedia] = useState<Map<number, RemoteMedia>>(new Map());
  const [peerDiagnostics, setPeerDiagnostics] = useState<Map<number, PeerConnectionDiagnostics>>(new Map());
  const [onlineCounts, setOnlineCounts] = useState<Record<string, number>>({});
  const [onlineUsers, setOnlineUsers] = useState<Map<number, OnlineUserPresence>>(new Map());
  const [voiceChannelMembers, setVoiceChannelMembers] = useState<Record<string, PresenceMember[]>>({});
  const [currentVoiceChannelId, setCurrentVoiceChannelId] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [status, setStatus] = useState("等待初始化");
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
  const [showScreenShareSheet, setShowScreenShareSheet] = useState(false);
  const [screenSharePreset, setScreenSharePreset] = useState<ScreenSharePreset>({
    surface: "tab",
    audioMode: "share",
  });
  const [messageDraft, setMessageDraft] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [localAudioStream, setLocalAudioStream] = useState<MediaStream | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [maximizedScreenKey, setMaximizedScreenKey] = useState<string | null>(null);
  const [voiceTargetChannelId, setVoiceTargetChannelId] = useState<number | null>(null);
  const [screeningSnapshot, setScreeningSnapshot] = useState<ScreeningSnapshot | null>(null);
  const [screeningChannelMembers, setScreeningChannelMembers] = useState<Record<string, User[]>>({});
  const [screeningUrlInput, setScreeningUrlInput] = useState("");
  const [screeningTitleInput, setScreeningTitleInput] = useState("");
  const [screeningJoinEpoch, setScreeningJoinEpoch] = useState(0);

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
  const activeChannelRef = useRef<Channel | null>(null);
  const currentVoiceChannelIdRef = useRef<number | null>(null);
  const voiceMembersRef = useRef<Map<number, PresenceMember>>(new Map());
  const membersRef = useRef<DomainMember[]>([]);
  const currentUserRef = useRef<User | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const startupAudioStreamRef = useRef<MediaStream | null>(null);
  const voiceJoinInFlightRef = useRef<number | null>(null);
  const voiceLeaveInFlightRef = useRef(false);
  const screeningJoinDedupRef = useRef<{ channelId: number | null; until: number }>({ channelId: null, until: 0 });
  const audioSetupPending = audioDevicesLoading || audioPrewarming;
  const { notices, pushNotice, dismissNotice, resolveErrorMessage, showError, showInfo, clearAllNoticeTimers } = useNoticeDomain();
  const {
    authMode,
    setAuthMode,
    displayNameInput,
    setDisplayNameInput,
    emailInput,
    setEmailInput,
    passwordInput,
    setPasswordInput,
    verificationCodeInput,
    setVerificationCodeInput,
    submittingAuth,
    sendingVerificationCode,
    verificationCooldown,
    setVerificationCooldown,
    creatingDomain,
    setCreatingDomain,
    domainNameInput,
    setDomainNameInput,
    domainDescriptionInput,
    setDomainDescriptionInput,
    channelComposerType,
    setChannelComposerType,
    channelNameInput,
    setChannelNameInput,
    channelTopicInput,
    setChannelTopicInput,
    submittingDomain,
    submittingChannel,
    hydrateSession,
    bootstrapData,
    submitAuth,
    requestVerificationCode,
    switchDomain,
    submitCreateDomain,
    submitCreateChannel,
    logout,
  } = useSessionDomain({
    session,
    bootstrap,
    setSession,
    setUser,
    setBootstrap,
    setActiveChannel,
    setMessages,
    setVoiceTargetChannelId,
    setOnlineCounts,
    setScreeningSnapshot: () => setScreeningSnapshot(null),
    setStatus,
    setCurrentVoiceChannelId,
    setVoiceMembers,
    setRemoteMedia,
    setPeerDiagnostics,
    setOnlineUsers,
    setVoiceChannelMembers,
    setScreeningChannelMembers,
    setDeafened,
    setMicEnabled,
    setScreenSharing,
    setLocalAudioStream,
    setLocalScreenStream,
    setMaximizedScreenKey,
    setMessageDraft,
    setShowEmojiPicker,
    setShowAudioSettings,
    setShowProfileMenu,
    socketRef,
    rtcRef,
    pushNotice,
    showError,
    showInfo,
    resolveErrorMessage,
  });

  useEffect(() => {
    if (session) return;
    setAudioPrewarming(false);
  }, [session]);

  useEffect(() => {
    activeChannelIdRef.current = activeChannel?.id || null;
    activeChannelRef.current = activeChannel;
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
    return () => {
      clearAllNoticeTimers();
      startupAudioStreamRef.current?.getTracks().forEach((track) => track.stop());
      startupAudioStreamRef.current = null;
    };
  }, [clearAllNoticeTimers]);

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
    if (!rtcRef.current) return;
    if (startupAudioStreamRef.current) {
      rtcRef.current.primePrewarmedAudio(startupAudioStreamRef.current);
    }
  }, [session?.token, user?.id, bootstrap?.domain.id]);

  useEffect(() => {
    if (audioBootstrapStartedRef.current) return;
    audioBootstrapStartedRef.current = true;
    setAudioPrewarming(true);
    setStatus("正在请求麦克风权限...");
    const bootstrapAudio = async () => {
      if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) {
        setAudioDevicesLoading(false);
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        },
        video: false,
      });
      startupAudioStreamRef.current?.getTracks().forEach((track) => track.stop());
      startupAudioStreamRef.current = stream;
      rtcRef.current?.primePrewarmedAudio(stream);
      const devices = await navigator.mediaDevices.enumerateDevices();
      const nextInputs = devices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `麦克风 ${index + 1}`,
        }));
      setAudioInputs(nextInputs);
      setSelectedAudioInputId((current) => pickPreferredAudioInputId(nextInputs, current));
      setStatus("麦克风与音频设备已就绪");
    };
    void bootstrapAudio()
      .catch((error) => {
        console.error(error);
        showError(error, "麦克风初始化失败", "无法获取麦克风权限或音频设备信息");
        setStatus("麦克风未授权");
      })
      .finally(() => {
        setAudioDevicesLoading(false);
        setAudioPrewarming(false);
      });
  }, []);

  useEffect(() => {
    if (!rtcRef.current || !session || !user || !startupAudioStreamRef.current) return;
    rtcRef.current.primePrewarmedAudio(startupAudioStreamRef.current);
  }, [session, user]);

  useEffect(() => {
    if (!rtcRef.current || !session || !user || !bootstrap?.domain.id) return;
    if (localAudioStream) {
      startupAudioStreamRef.current = null;
    }
  }, [bootstrap?.domain.id, localAudioStream, session, user]);

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

  function screeningLog(label: string, extra?: Record<string, unknown>) {
    if (!SCREENING_DEBUG_LABELS.has(label)) {
      return;
    }
    const stamp = new Date().toISOString();
    if (extra) {
      console.info(`[screening-ui][${stamp}] ${label}`, extra);
      return;
    }
    console.info(`[screening-ui][${stamp}] ${label}`);
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
      (diagnostics) => setPeerDiagnostics(new Map(diagnostics)),
      (stream) => setLocalAudioStream(stream),
      (stream) => setLocalScreenStream(stream),
      (kind, title, message) => {
        setStatus(message);
        pushNotice(kind, title, message);
      },
    );
    void rtcRef.current.setAudioInputDevice(selectedAudioInputId);
    void rtcRef.current.setNoiseSuppression(noiseSuppressionEnabled);

    return () => {
      socket.close();
      socketRef.current = null;
      rtcRef.current = null;
      setPeerDiagnostics(new Map());
    };
  }, [session?.token, user?.id, bootstrap?.domain.id]);

  async function selectChannel(channel: Channel) {
    if (!bootstrap || !session) return;
    if (activeChannel?.type === "screening" && activeChannel.id !== channel.id) {
      await leaveScreeningChannel(channel.type === "voice" ? firstTextChannel : null);
    }
    if (channel.type === "voice") {
      setVoiceTargetChannelId(channel.id);
      if (activeChannel?.type === "screening" && firstTextChannel) {
        setActiveChannel(firstTextChannel);
      }
      if (currentVoiceChannelId && currentVoiceChannelId !== channel.id) {
        await leaveVoice();
      }
      setStatus(`已选中语音频道 ${channel.name}，双击进入`);
      return;
    }
    try {
      if (channel.type === "screening" && currentVoiceChannelId && currentVoiceChannelId !== channel.id) {
        await leaveVoice();
      }
      const nextMessages = await liveFacade.fetchChannelMessages(bootstrap.domain.id, channel.id, session.token);
      startTransition(() => {
        setActiveChannel(channel);
        setMessages(nextMessages);
      });
      if (channel.type === "screening") {
        const now = Date.now();
        if (screeningJoinDedupRef.current.channelId === channel.id && screeningJoinDedupRef.current.until > now) {
          return;
        }
        screeningJoinDedupRef.current = { channelId: channel.id, until: now + 900 };
        if (screenSharing) {
          await rtcRef.current?.stopScreenShare(false);
          setScreenSharing(false);
        }
        screeningLog("screening:join:send", { channelId: channel.id, reason: "select-channel" });
        setScreeningJoinEpoch((value) => value + 1);
        socketRef.current?.send("screening.join", { channelId: channel.id });
        if (currentVoiceChannelId !== channel.id) {
          await joinVoice(channel.id);
        } else {
          setVoiceTargetChannelId(channel.id);
        }
        setStatus(`已进入放映室 ${channel.name}`);
      } else {
        setScreeningSnapshot(null);
      }
    } catch (error) {
      console.error(error);
      setStatus("切换频道失败");
      showError(error, "切换频道失败", "请稍后重试");
    }
  }

  async function joinVoice(channelId?: number) {
    const targetId = channelId || voiceTargetChannelId;
    if (!targetId) return;
    if (voiceJoinInFlightRef.current === targetId) {
      return;
    }
    voiceJoinInFlightRef.current = targetId;
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
      setStatus(resolveErrorMessage(error, "麦克风权限失败"));
      showError(error, "加入语音房失败", "无法获取麦克风权限或建立实时连接");
    } finally {
      if (voiceJoinInFlightRef.current === targetId) {
        voiceJoinInFlightRef.current = null;
      }
    }
  }

  async function enterVoiceChannel(channel: Channel) {
    if (channel.type !== "voice") return;
    if (activeChannel?.type === "screening") {
      await leaveScreeningChannel(firstTextChannel);
    }
    setVoiceTargetChannelId(channel.id);
    if (currentVoiceChannelId === channel.id) {
      setStatus(`已在 ${channel.name} 中`);
      return;
    }
    await joinVoice(channel.id);
  }

  async function leaveVoice() {
    if (voiceLeaveInFlightRef.current) {
      return;
    }
    voiceLeaveInFlightRef.current = true;
    const traceId = voiceTraceCounterRef.current + 1;
    voiceTraceCounterRef.current = traceId;
    leaveTraceRef.current = {
      id: traceId,
      startedAt: performance.now(),
      channelId: currentVoiceChannelId,
    };
    try {
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
    } finally {
      voiceLeaveInFlightRef.current = false;
    }
  }

  async function leaveScreeningChannel(nextActive: Channel | null) {
    const leavingChannel = activeChannelRef.current?.type === "screening" ? activeChannelRef.current : null;
    if (!leavingChannel) {
      if (nextActive) {
        setActiveChannel(nextActive);
      }
      return;
    }
    socketRef.current?.send("screening.leave", { channelId: leavingChannel.id });
    screeningJoinDedupRef.current = { channelId: null, until: 0 };
    setScreeningSnapshot(null);
    setScreeningJoinEpoch((value) => value + 1);
    setActiveChannel(nextActive);
    await Promise.resolve();
    if (currentVoiceChannelIdRef.current) {
      await leaveVoice();
    }
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
      showError(error, "切换麦克风失败", "请检查设备权限或重新选择设备");
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
      showError(error, "更新降噪配置失败", "请稍后重试");
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
        showError(error, "预热麦克风失败", "无法预热当前麦克风设备");
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
    if (currentVoiceChannel?.type === "screening") {
      setStatus("放映室连麦不支持屏幕共享");
      pushNotice("error", "无法共享屏幕", "放映室与语音频道互斥，且放映室连麦暂不支持屏幕共享。");
      return;
    }
    try {
      const next = !screenSharing;
      if (next) {
        setShowScreenShareSheet(true);
        return;
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
      showError(error, "屏幕共享失败", "请检查浏览器权限或重新选择共享窗口");
    }
  }

  async function confirmScreenShare() {
    try {
      const options: ScreenShareOptions = {
        surface: screenSharePreset.surface,
        audioMode: screenSharePreset.audioMode,
      };
      await rtcRef.current?.startScreenShare(options);
      setScreenSharing(true);
      setShowScreenShareSheet(false);
      if (options.surface === "screen" && options.audioMode === "share") {
        pushNotice(
          "info",
          "正在共享系统音频",
          "系统音频可能把远端通话声、通知声一起带出去，建议佩戴耳机；浏览器支持时会尝试启用 restrictOwnAudio 和 suppressLocalAudioPlayback 兜底。",
        );
      }
      socketRef.current?.send("screen.state", {
        channelId: currentVoiceChannelId,
        screenSharing: true,
      });
    } catch (error) {
      console.error(error);
      setStatus("屏幕共享失败");
      showError(error, "屏幕共享失败", "请检查浏览器权限或重新选择共享窗口");
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
      void liveFacade
        .fetchChannelMessages(bootstrap.domain.id, activeChannel.id, session.token)
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
        if (currentVoiceChannelIdRef.current && voiceJoinInFlightRef.current !== currentVoiceChannelIdRef.current) {
          socketRef.current?.send("channel.join", {
            channelId: currentVoiceChannelIdRef.current,
          });
        }
        if (activeChannelIdRef.current && activeChannelRef.current?.type === "screening") {
          screeningLog("screening:join:send", { channelId: activeChannelIdRef.current, reason: "socket-ready" });
          socketRef.current?.send("screening.join", {
            channelId: activeChannelIdRef.current,
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
      case "screening.snapshot":
        screeningLog("screening:snapshot:received", {
          channelId: (payload as ScreeningSnapshot).state.channelId,
          itemId: (payload as ScreeningSnapshot).state.currentItemId,
          currentUrl: (payload as ScreeningSnapshot).state.currentUrl,
          controllerUserId: (payload as ScreeningSnapshot).state.controllerUserId,
        });
        setScreeningSnapshot(payload as ScreeningSnapshot);
        setScreeningChannelMembers((prev) => ({
          ...prev,
          [String((payload as ScreeningSnapshot).state.channelId)]: ((payload as ScreeningSnapshot).viewers || []).map(
            (viewer) => viewer.user,
          ),
        }));
        break;
      case "screening.playlist.updated":
        setScreeningSnapshot((prev) =>
          prev
            ? {
                ...prev,
                playlist: (payload.playlist || []) as ScreeningPlaylistItem[],
              }
            : prev,
        );
        break;
      case "screening.controller.changed": {
        const nextName = String(payload.controllerName || "新的控制者");
        const isSelf = Number(payload.controllerUserId) === currentUserRef.current?.id;
        screeningLog("screening:controller:changed", {
          controllerUserId: payload.controllerUserId,
          controllerName: nextName,
          isSelf,
        });
        setStatus(isSelf ? "你已接管放映室控制权" : `控制者已转让给 ${nextName}`);
        pushNotice("info", "放映室控制权已转让", isSelf ? "你已成为新的控制者，将继续向房间同步播放状态。" : `新的控制者是 ${nextName}。`);
        break;
      }
      case "screening.play":
      case "screening.pause":
      case "screening.seek":
      case "screening.tick":
      case "screening.rate":
        setScreeningSnapshot((prev) =>
          prev
            ? {
                ...prev,
                state: payload as ScreeningState,
              }
            : prev,
        );
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
        pushNotice("error", "实时事件出错", String(payload.message || "实时事件出错"));
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
  const chatChannel = activeChannel && activeChannel.type !== "voice" ? activeChannel : firstTextChannel;
  const activeScreeningChannel = activeChannel?.type === "screening" ? activeChannel : null;
  const onlineMemberIds = new Set(onlineUsers.keys());
  const screeningViewerIds = new Set((screeningSnapshot?.viewers || []).map((viewer) => viewer.user.id));
  const screeningViewerMembers = activeScreeningChannel
    ? (bootstrap?.members || []).filter((member) => screeningViewerIds.has(member.id))
    : [];
  const onlineMembers = (bootstrap?.members || []).filter((member) => onlineMemberIds.has(member.id) && !screeningViewerIds.has(member.id));
  const offlineMembers = (bootstrap?.members || []).filter((member) => !onlineMemberIds.has(member.id));
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
  const channelNameById = new Map<number, string>();
  categories.forEach((category) => {
    category.channels.forEach((channel) => {
      channelNameById.set(channel.id, channel.name);
    });
  });

  useEffect(() => {
    if (!session || !bootstrap || !chatChannel) return;
    if (activeChannel?.type !== "voice" || currentVoiceChannelId) return;

    void liveFacade
      .fetchChannelMessages(bootstrap.domain.id, chatChannel.id, session.token)
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
              <div className="mic-settings-anchor" onMouseEnter={openAudioSettings} onMouseLeave={scheduleCloseAudioSettings}>
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
                      <span
                        className={`audio-settings-panel__status-dot ${audioSetupPending ? "audio-settings-panel__status-dot--loading" : ""}`}
                      />
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
              <div className="mic-settings-anchor" onMouseEnter={openHeadphoneSettings} onMouseLeave={scheduleCloseHeadphoneSettings}>
                <button
                  className={`sidebar-icon-button ${deafened ? "sidebar-icon-button--danger" : ""}`}
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
            <button className="profile-chip" onClick={() => setShowProfileMenu((value) => !value)} title="账号菜单" aria-label="账号菜单">
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
              <button className="action-pill" onClick={() => setChannelComposerType("screening")}>
                + 放映室
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
                      <span>
                        {channel.type === "voice" ? <VoiceChannelIcon /> : channel.type === "screening" ? <PlayIcon /> : <HashIcon />}
                      </span>
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
                    ) : channel.type === "screening" && (screeningChannelMembers[String(channel.id)] || []).length ? (
                      <div className="channel-presence-list">
                        {(screeningChannelMembers[String(channel.id)] || []).slice(0, 4).map((member) => (
                          <div key={member.id} className="channel-presence-pill">
                            <div className="channel-presence-pill__avatar" style={{ background: member.avatarColor }}>
                              {initials(member.displayName)}
                            </div>
                            <span>{member.displayName}</span>
                          </div>
                        ))}
                        {(screeningChannelMembers[String(channel.id)] || []).length > 4 ? (
                          <div className="channel-presence-more">+{(screeningChannelMembers[String(channel.id)] || []).length - 4}</div>
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

      <main className={`main-panel ${activeScreeningChannel ? "main-panel--screening" : ""}`}>
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

        {currentVoiceChannel && !activeScreeningChannel ? (
          <section className="voice-presence-dock">
            <div className="voice-presence-dock__title">
              <div>
                <div className="voice-presence-dock__heading">
                  <VoiceChannelIcon />
                  <strong>{currentVoiceChannel.name}</strong>
                  <span>
                    {selectedVoiceCount.toString().padStart(2, "0")}/{currentVoiceChannel.maxMembers || 50}
                  </span>
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
                    diagnostics={peerDiagnostics.get(member.user.id)}
                  />
                ))
              ) : (
                <div className="empty-state empty-state--small">暂无在线语音成员</div>
              )}
            </div>
          </section>
        ) : null}

        {activeScreeningChannel ? (
          <ScreeningRoomPanel
            key={`${activeScreeningChannel.id}-${screeningJoinEpoch}`}
            channel={activeScreeningChannel}
            snapshot={screeningSnapshot}
            currentUser={user}
            joinEpoch={screeningJoinEpoch}
            urlInput={screeningUrlInput}
            titleInput={screeningTitleInput}
            onUrlInputChange={setScreeningUrlInput}
            onTitleInputChange={setScreeningTitleInput}
            onReplace={({ url, title }) =>
              (() => {
                socketRef.current?.send("screening.url.replace", {
                  channelId: activeScreeningChannel.id,
                  url,
                  title,
                });
                setScreeningUrlInput("");
                setScreeningTitleInput("");
              })()
            }
            onAppend={({ url, title }) =>
              (() => {
                socketRef.current?.send("screening.url.add", {
                  channelId: activeScreeningChannel.id,
                  url,
                  title,
                });
                setScreeningUrlInput("");
                setScreeningTitleInput("");
              })()
            }
            onPlaybackEvent={(type, payload) =>
              socketRef.current?.send(type, {
                channelId: activeScreeningChannel.id,
                ...payload,
              })
            }
            onError={(title, message) => pushNotice("error", title, message)}
          />
        ) : null}

        <section className={`chat-panel ${activeScreeningChannel ? "chat-panel--screening" : ""}`}>
          {chatChannel?.type === "screening" ? null : (
            <div className="chat-panel__toolbar">
              <div className="chat-panel__title">
                <div className="chat-panel__title-icon">{chatChannel?.type === "text" ? <HomeIcon /> : <HashIcon />}</div>
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
          )}
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
                <button
                  className={`plain-icon-button ${showEmojiPicker ? "plain-icon-button--active" : ""}`}
                  type="button"
                  onClick={() => setShowEmojiPicker((value) => !value)}
                >
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
          {activeScreeningChannel ? <ScreeningPlaylistSection playlist={screeningSnapshot?.playlist || []} /> : null}
          {activeScreeningChannel ? (
            <MemberSection
              title={`${screeningViewerMembers.length} 人正在观看 ${activeScreeningChannel.name}`}
              members={screeningViewerMembers}
              voiceMembers={voiceMembers}
              onlineUsers={onlineUsers}
              channelNameById={channelNameById}
              showCount={false}
              localAudioStream={localAudioStream}
              remoteMedia={remoteMedia}
              currentUserId={user?.id || 0}
              currentUserMicEnabled={micEnabled}
              showVoiceState
              peerDiagnostics={peerDiagnostics}
            />
          ) : null}
          <MemberSection
            title="在线"
            members={onlineMembers}
            voiceMembers={voiceMembers}
            onlineUsers={onlineUsers}
            channelNameById={channelNameById}
            peerDiagnostics={peerDiagnostics}
          />
          <MemberSection
            title="离线"
            members={offlineMembers}
            voiceMembers={voiceMembers}
            onlineUsers={onlineUsers}
            channelNameById={channelNameById}
            peerDiagnostics={peerDiagnostics}
          />
        </div>
      </aside>

      {!session ? (
        <div className="identity-modal identity-modal--visible">
          <div className="identity-modal__card">
            <div className="eyebrow">ACCOUNT ACCESS</div>
            <h2>开源版 Oopz</h2>
            <p>by.玺朽</p>

            <div className="toggle-row">
              <button className="action-pill" onClick={() => setAuthMode("register")}>
                注册
              </button>
              <button className="action-pill" onClick={() => setAuthMode("login")}>
                登录
              </button>
            </div>

            {authMode === "register" ? (
              <input
                maxLength={32}
                placeholder="昵称"
                value={displayNameInput}
                onChange={(event) => setDisplayNameInput(event.target.value)}
              />
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
            <input
              type="password"
              placeholder="密码（至少 6 位）"
              value={passwordInput}
              onChange={(event) => setPasswordInput(event.target.value)}
            />

            <button
              className="action-pill action-pill--primary action-pill--full"
              disabled={submittingAuth}
              onClick={() => void submitAuth()}
            >
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
            <input
              maxLength={48}
              placeholder="域名称"
              value={domainNameInput}
              onChange={(event) => setDomainNameInput(event.target.value)}
            />
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
            <input
              maxLength={48}
              placeholder="频道名称"
              value={channelNameInput}
              onChange={(event) => setChannelNameInput(event.target.value)}
            />
            <input
              maxLength={120}
              placeholder="频道描述 / Topic"
              value={channelTopicInput}
              onChange={(event) => setChannelTopicInput(event.target.value)}
            />
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
      {showScreenShareSheet ? (
        <ScreenShareSheet
          preset={screenSharePreset}
          onChange={setScreenSharePreset}
          onCancel={() => setShowScreenShareSheet(false)}
          onConfirm={() => void confirmScreenShare()}
        />
      ) : null}
      <NoticeViewport notices={notices} onDismiss={dismissNotice} />
    </div>
  );
}
