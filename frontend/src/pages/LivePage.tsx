import { useDeferredValue, useEffect, useRef, useState } from "react";

import { ChannelSidebar } from "../components/live/ChannelSidebar";
import { LiveMainPanel } from "../components/live/LiveMainPanel";
import { LiveOverlays } from "../components/live/LiveOverlays";
import { useChannelDomain } from "../hooks/useChannelDomain";
import { useNoticeDomain } from "../hooks/useNoticeDomain";
import { useScreeningDomain } from "../hooks/useScreeningDomain";
import { useSessionDomain } from "../hooks/useSessionDomain";
import { useVoiceDomain } from "../hooks/useVoiceDomain";
import { RTCController } from "../rtc";
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
  ScreeningSnapshot,
  ScreeningState,
  User,
} from "../types";
import type { SocketEventMap } from "../types/socket";
import type { AudioInputOption, ScreenPreview, ScreenSharePreset, Session } from "../types/live";
import { pickPreferredAudioInputId } from "../utils/live";

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
  const categories = bootstrap?.categories || [];
  const allChannels = categories.flatMap((category) => category.channels);
  const firstTextChannel = allChannels.find((channel) => channel.type === "text") || null;
  const currentVoiceChannel = allChannels.find((channel) => channel.id === currentVoiceChannelId) || null;

  /**
   * 语音日志：按白名单输出语音链路关键节点。
   */
  function voiceLog(label: string, extra?: Record<string, unknown>) {
    if (!VOICE_UI_DEBUG_LABELS.has(label)) return;
    const stamp = new Date().toISOString();
    if (extra) {
      console.info(`[voice-ui][${stamp}] ${label}`, extra);
      return;
    }
    console.info(`[voice-ui][${stamp}] ${label}`);
  }

  /**
   * 放映日志：按白名单输出放映链路关键节点。
   */
  function screeningLog(label: string, extra?: Record<string, unknown>) {
    if (!SCREENING_DEBUG_LABELS.has(label)) return;
    const stamp = new Date().toISOString();
    if (extra) {
      console.info(`[screening-ui][${stamp}] ${label}`, extra);
      return;
    }
    console.info(`[screening-ui][${stamp}] ${label}`);
  }

  const {
    joinVoice,
    leaveVoice,
    toggleMic,
    toggleDeafen,
    handleAudioInputChange,
    handleNoiseSuppressionChange,
    openAudioSettings,
    scheduleCloseAudioSettings: scheduleCloseAudioSettingsInternal,
    openHeadphoneSettings: openHeadphoneSettingsInternal,
    scheduleCloseHeadphoneSettings: scheduleCloseHeadphoneSettingsInternal,
  } = useVoiceDomain({
    currentVoiceChannelId,
    voiceTargetChannelId,
    selectedAudioInputId,
    noiseSuppressionEnabled,
    deafened,
    micEnabled,
    audioInputs,
    setSelectedAudioInputId,
    setNoiseSuppressionEnabled,
    setShowAudioSettings,
    setStatus,
    setCurrentVoiceChannelId,
    setVoiceTargetChannelId,
    setMicEnabled,
    setDeafened,
    setScreenSharing,
    setVoiceMembers,
    setRemoteMedia,
    setLocalAudioStream,
    setLocalScreenStream,
    setMaximizedScreenKey,
    setAudioInputs,
    setAudioPrewarming,
    socketRef,
    rtcRef,
    joinTraceRef,
    leaveTraceRef,
    voiceTraceCounterRef,
    voiceJoinInFlightRef,
    voiceLeaveInFlightRef,
    audioSettingsCloseTimerRef,
    headphoneSettingsCloseTimerRef,
    showError,
    resolveErrorMessage,
    voiceLog,
  });

  const { leaveScreeningChannel, toggleScreenShare, confirmScreenShare } = useScreeningDomain({
    activeChannelRef,
    currentVoiceChannelIdRef,
    currentVoiceChannel,
    currentVoiceChannelId,
    firstTextChannel,
    screenSharing,
    screenSharePreset,
    rtcRef,
    socketRef,
    screeningJoinDedupRef,
    setScreenSharing,
    setShowScreenShareSheet,
    setScreeningSnapshot,
    setScreeningJoinEpoch,
    setActiveChannel,
    setStatus,
    pushNotice,
    showError,
    screeningLog,
    leaveVoice,
  });

  const { selectChannel, sendMessage, appendEmoji, enterVoiceChannel } = useChannelDomain({
    session,
    bootstrap,
    activeChannel,
    firstTextChannel,
    currentVoiceChannelId,
    screenSharing,
    setActiveChannel,
    setMessages,
    setStatus,
    setMessageDraft,
    setShowEmojiPicker,
    setVoiceTargetChannelId,
    setScreenSharing,
    setScreeningSnapshot,
    setScreeningJoinEpoch,
    screeningJoinDedupRef,
    activeChannelIdRef,
    messageInputRef,
    rtcRef,
    socketRef,
    showError,
    screeningLog,
    leaveVoice,
    joinVoice,
    leaveScreeningChannel,
  });

  /**
   * 打开耳机设置面板（对外包装，保持页面调用签名稳定）。
   */
  function openHeadphoneSettings() {
    openHeadphoneSettingsInternal(setShowHeadphoneSettings);
  }

  /**
   * 延迟关闭耳机设置面板（对外包装，保持页面调用签名稳定）。
   */
  function scheduleCloseHeadphoneSettings() {
    scheduleCloseHeadphoneSettingsInternal(setShowHeadphoneSettings);
  }

  /**
   * 延迟关闭音频设置面板（对外包装，保持页面调用签名稳定）。
   */
  function scheduleCloseAudioSettings() {
    scheduleCloseAudioSettingsInternal(setShowAudioSettings);
  }

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
  }, [verificationCooldown, setVerificationCooldown]);

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
        setSelectedAudioInputId((current) => pickPreferredAudioInputId(nextInputs, current));
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

  /**
   * 处理实时事件并分发到本地状态与 RTC 控制器。
   */
  function handleSocketEvent(type: string, payload: unknown) {
    switch (type) {
      case "ready": {
        const readyPayload = payload as SocketEventMap["ready"];
        voiceLog("socket:ready", { domainId: readyPayload.domainId, userId: readyPayload.userId });
        setStatus("实时连接就绪");
        if (currentVoiceChannelIdRef.current && voiceJoinInFlightRef.current !== currentVoiceChannelIdRef.current) {
          socketRef.current?.send("channel.join", { channelId: currentVoiceChannelIdRef.current });
        }
        if (activeChannelIdRef.current && activeChannelRef.current?.type === "screening") {
          screeningLog("screening:join:send", { channelId: activeChannelIdRef.current, reason: "socket-ready" });
          socketRef.current?.send("screening.join", { channelId: activeChannelIdRef.current });
        }
        break;
      }
      case "presence.snapshot": {
        const snapshotPayload = payload as SocketEventMap["presence.snapshot"];
        const nextMembers = new Map<number, PresenceMember>();
        snapshotPayload.members.forEach((member) => {
          nextMembers.set(member.user.id, member);
        });
        setCurrentVoiceChannelId(snapshotPayload.channelId);
        setVoiceMembers(nextMembers);
        setOnlineCounts((prev) => ({ ...prev, [String(snapshotPayload.channelId)]: nextMembers.size }));
        void rtcRef.current?.handlePresenceSnapshot(snapshotPayload.members);
        break;
      }
      case "member.joined": {
        const joinedPayload = payload as SocketEventMap["member.joined"];
        if (joinedPayload.user?.id) {
          void soundManager.play("join");
        }
        setVoiceMembers((prev) => {
          const next = new Map(prev);
          next.set(joinedPayload.user.id, joinedPayload as PresenceMember);
          setOnlineCounts((counts) => ({ ...counts, [String(joinedPayload.channelId)]: next.size }));
          return next;
        });
        void rtcRef.current?.handleMemberJoined(joinedPayload as PresenceMember);
        break;
      }
      case "member.left": {
        const leftPayload = payload as SocketEventMap["member.left"];
        if (leftPayload.userId) {
          void soundManager.play("leave");
        }
        setVoiceMembers((prev) => {
          const next = new Map(prev);
          next.delete(leftPayload.userId);
          setOnlineCounts((counts) => ({ ...counts, [String(leftPayload.channelId)]: next.size }));
          return next;
        });
        rtcRef.current?.handleMemberLeft(leftPayload.userId);
        break;
      }
      case "chat.message": {
        const chatPayload = payload as SocketEventMap["chat.message"];
        if (chatPayload.messageType === "chat" && chatPayload.channelId === activeChannelIdRef.current) {
          void soundManager.play("chat");
        }
        if (chatPayload.channelId === activeChannelIdRef.current) {
          setMessages((prev) => [...prev, chatPayload as Message]);
        }
        break;
      }
      case "voice.state": {
        const voiceStatePayload = payload as SocketEventMap["voice.state"];
        if (voiceStatePayload.userId === currentUserRef.current?.id) {
          setMicEnabled(Boolean(voiceStatePayload.micEnabled));
        }
        setVoiceMembers((prev) => {
          const next = new Map(prev);
          const current = next.get(voiceStatePayload.userId);
          if (current) {
            next.set(voiceStatePayload.userId, { ...current, micEnabled: voiceStatePayload.micEnabled });
          }
          return next;
        });
        if (voiceStatePayload.userId) {
          rtcRef.current?.handleVoiceState(voiceStatePayload.userId, Boolean(voiceStatePayload.micEnabled));
        }
        break;
      }
      case "screen.state": {
        const screenStatePayload = payload as SocketEventMap["screen.state"];
        if (screenStatePayload.userId === currentUserRef.current?.id) {
          setScreenSharing(Boolean(screenStatePayload.screenSharing));
        }
        setVoiceMembers((prev) => {
          const next = new Map(prev);
          const current = next.get(screenStatePayload.userId);
          if (current) {
            next.set(screenStatePayload.userId, { ...current, screenSharing: screenStatePayload.screenSharing });
          }
          return next;
        });
        if (screenStatePayload.userId) {
          rtcRef.current?.handleScreenState(screenStatePayload.userId, Boolean(screenStatePayload.screenSharing));
        }
        break;
      }
      case "screening.snapshot": {
        const screeningSnapshotPayload = payload as SocketEventMap["screening.snapshot"];
        setScreeningSnapshot(screeningSnapshotPayload as ScreeningSnapshot);
        setScreeningChannelMembers((prev) => ({
          ...prev,
          [String(screeningSnapshotPayload.state.channelId)]: (screeningSnapshotPayload.viewers || []).map((viewer) => viewer.user),
        }));
        break;
      }
      case "screening.play":
      case "screening.pause":
      case "screening.seek":
      case "screening.tick":
      case "screening.rate": {
        const screeningStatePayload = payload as ScreeningState;
        setScreeningSnapshot((prev) => (prev ? { ...prev, state: screeningStatePayload } : prev));
        break;
      }
      case "screen.sync_request":
      case "media.sync_request":
      case "rtc.offer":
      case "rtc.answer":
      case "rtc.ice_candidate":
        void rtcRef.current?.handleSignal(
          type as Parameters<RTCController["handleSignal"]>[0],
          payload as Parameters<RTCController["handleSignal"]>[1],
        );
        break;
      case "error": {
        const errorPayload = payload as SocketEventMap["error"];
        setStatus(String(errorPayload.message || "实时事件出错"));
        pushNotice("error", "实时事件出错", String(errorPayload.message || "实时事件出错"));
        break;
      }
      default:
        break;
    }
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

  const selectedVoiceCount = currentVoiceChannelId ? (voiceChannelMembers[String(currentVoiceChannelId)] || []).length || voiceMembers.size : 0;
  const canManageDomain = bootstrap?.currentRole === "owner";
  const chatChannel = activeChannel && activeChannel.type !== "voice" ? activeChannel : firstTextChannel;
  const activeScreeningChannel = activeChannel?.type === "screening" ? activeChannel : null;
  const onlineMemberIds = new Set(onlineUsers.keys());
  const screeningViewerIds = new Set((screeningSnapshot?.viewers || []).map((viewer) => viewer.user.id));
  const screeningViewerMembers = activeScreeningChannel ? (bootstrap?.members || []).filter((member) => screeningViewerIds.has(member.id)) : [];
  const onlineMembers = (bootstrap?.members || []).filter((member) => onlineMemberIds.has(member.id) && !screeningViewerIds.has(member.id));
  const offlineMembers = (bootstrap?.members || []).filter((member) => !onlineMemberIds.has(member.id));
  const screenPreviews: ScreenPreview[] = [];
  if (user && localScreenStream) {
    screenPreviews.push({ key: `local-${user.id}`, user, stream: localScreenStream, isLocal: true });
  }
  [...remoteMedia.values()].forEach((entry) => {
    if (!entry.screenStream) return;
    screenPreviews.push({ key: `remote-${entry.user.id}`, user: entry.user, stream: entry.screenStream, isLocal: false });
  });
  const maximizedScreen = screenPreviews.find((item) => item.key === maximizedScreenKey) || null;

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
    if (!maximizedScreenKey) return;
    if (!screenPreviews.some((item) => item.key === maximizedScreenKey)) {
      setMaximizedScreenKey(null);
    }
  }, [maximizedScreenKey, screenPreviews]);

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
      <ChannelSidebar
        bootstrap={bootstrap}
        user={user}
        activeChannel={activeChannel}
        firstTextChannel={firstTextChannel}
        canManageDomain={canManageDomain}
        categories={categories}
        currentVoiceChannelId={currentVoiceChannelId}
        voiceTargetChannelId={voiceTargetChannelId}
        onlineCounts={onlineCounts}
        voiceChannelMembers={voiceChannelMembers}
        screeningChannelMembers={screeningChannelMembers}
        micEnabled={micEnabled}
        deafened={deafened}
        audioSetupPending={audioSetupPending}
        audioDevicesLoading={audioDevicesLoading}
        audioPrewarming={audioPrewarming}
        selectedAudioInputId={selectedAudioInputId}
        audioInputs={audioInputs}
        noiseSuppressionEnabled={noiseSuppressionEnabled}
        remoteVolume={remoteVolume}
        showAudioSettings={showAudioSettings}
        showHeadphoneSettings={showHeadphoneSettings}
        showProfileMenu={showProfileMenu}
        currentVoiceChannelAvailable={Boolean(currentVoiceChannelId)}
        setCreatingDomain={setCreatingDomain}
        setShowProfileMenu={setShowProfileMenu}
        setChannelComposerType={setChannelComposerType}
        setRemoteVolume={setRemoteVolume}
        switchDomain={switchDomain}
        selectChannel={selectChannel}
        enterVoiceChannel={enterVoiceChannel}
        toggleMic={toggleMic}
        toggleDeafen={toggleDeafen}
        leaveVoice={leaveVoice}
        handleAudioInputChange={handleAudioInputChange}
        handleNoiseSuppressionChange={handleNoiseSuppressionChange}
        openAudioSettings={openAudioSettings}
        scheduleCloseAudioSettings={scheduleCloseAudioSettings}
        openHeadphoneSettings={openHeadphoneSettings}
        scheduleCloseHeadphoneSettings={scheduleCloseHeadphoneSettings}
        logout={logout}
        profileMenuRef={profileMenuRef}
      />
      <LiveMainPanel
        bootstrap={bootstrap}
        user={user}
        activeScreeningChannel={activeScreeningChannel}
        currentVoiceChannel={currentVoiceChannel}
        currentVoiceChannelId={currentVoiceChannelId}
        selectedVoiceCount={selectedVoiceCount}
        wsConnected={wsConnected}
        status={status}
        screenSharing={screenSharing}
        voiceMembersList={voiceMembersList}
        voiceMembers={voiceMembers}
        remoteMedia={remoteMedia}
        localAudioStream={localAudioStream}
        localScreenStream={localScreenStream}
        peerDiagnostics={peerDiagnostics}
        screeningJoinEpoch={screeningJoinEpoch}
        screeningSnapshot={screeningSnapshot}
        screeningUrlInput={screeningUrlInput}
        screeningTitleInput={screeningTitleInput}
        chatChannel={chatChannel}
        deferredMessages={deferredMessages}
        messageDraft={messageDraft}
        showEmojiPicker={showEmojiPicker}
        emojiGroups={EMOJI_GROUPS}
        screeningViewerMembers={screeningViewerMembers}
        onlineMembers={onlineMembers}
        offlineMembers={offlineMembers}
        onlineUsers={onlineUsers}
        channelNameById={channelNameById}
        deafened={deafened}
        micEnabled={micEnabled}
        remoteVolume={remoteVolume}
        messageListRef={messageListRef}
        messageInputRef={messageInputRef}
        emojiPickerRef={emojiPickerRef}
        setMessageDraft={setMessageDraft}
        setShowEmojiPicker={setShowEmojiPicker}
        setScreeningUrlInput={setScreeningUrlInput}
        setScreeningTitleInput={setScreeningTitleInput}
        setMaximizedScreenKey={setMaximizedScreenKey}
        toggleScreenShare={toggleScreenShare}
        appendEmoji={appendEmoji}
        sendMessage={sendMessage}
        onScreeningReplace={(url, title) => {
          if (!activeScreeningChannel) return;
          socketRef.current?.send("screening.url.replace", { channelId: activeScreeningChannel.id, url, title });
          setScreeningUrlInput("");
          setScreeningTitleInput("");
        }}
        onScreeningAppend={(url, title) => {
          if (!activeScreeningChannel) return;
          socketRef.current?.send("screening.url.add", { channelId: activeScreeningChannel.id, url, title });
          setScreeningUrlInput("");
          setScreeningTitleInput("");
        }}
        onScreeningPlaybackEvent={(type, payload) => {
          if (!activeScreeningChannel) return;
          socketRef.current?.send(type, { channelId: activeScreeningChannel.id, ...payload });
        }}
        onScreeningError={(title, message) => pushNotice("error", title, message)}
      />
      <LiveOverlays
        session={session}
        creatingDomain={creatingDomain}
        channelComposerType={channelComposerType}
        maximizdScreen={maximizedScreen}
        showScreenShareSheet={showScreenShareSheet}
        screenSharePreset={screenSharePreset}
        notices={notices}
        authMode={authMode}
        displayNameInput={displayNameInput}
        emailInput={emailInput}
        verificationCodeInput={verificationCodeInput}
        passwordInput={passwordInput}
        submittingAuth={submittingAuth}
        sendingVerificationCode={sendingVerificationCode}
        verificationCooldown={verificationCooldown}
        domainNameInput={domainNameInput}
        domainDescriptionInput={domainDescriptionInput}
        submittingDomain={submittingDomain}
        channelNameInput={channelNameInput}
        channelTopicInput={channelTopicInput}
        submittingChannel={submittingChannel}
        setAuthMode={setAuthMode}
        setDisplayNameInput={setDisplayNameInput}
        setEmailInput={setEmailInput}
        setVerificationCodeInput={setVerificationCodeInput}
        setPasswordInput={setPasswordInput}
        setCreatingDomain={setCreatingDomain}
        setDomainNameInput={setDomainNameInput}
        setDomainDescriptionInput={setDomainDescriptionInput}
        setChannelComposerType={setChannelComposerType}
        setChannelNameInput={setChannelNameInput}
        setChannelTopicInput={setChannelTopicInput}
        setMaximizedScreenKey={setMaximizedScreenKey}
        setShowScreenShareSheet={setShowScreenShareSheet}
        setScreenSharePreset={setScreenSharePreset}
        submitAuth={submitAuth}
        requestVerificationCode={requestVerificationCode}
        submitCreateDomain={submitCreateDomain}
        submitCreateChannel={submitCreateChannel}
        confirmScreenShare={confirmScreenShare}
        dismissNotice={dismissNotice}
      />
    </div>
  );
}
