import type { DomainMember, PresenceMember, RemoteMedia, User } from "./types";
import { SocketClient } from "./socket";

type PeerWrapper = {
  user: User;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  initialOfferOwner: boolean;
  hasBoundLocalTracks: boolean;
  pendingIceCandidates: RTCIceCandidateInit[];
  audioTransceiver: RTCRtpTransceiver;
  displayAudioTransceiver: RTCRtpTransceiver;
  screenTransceiver: RTCRtpTransceiver;
};

type SignalPayload = {
  sourceUserId: number;
  targetUserId: number;
  sdp?: string;
  candidate?: string;
  kind?: "audio" | "screen";
};

type MediaSyncKind = "audio" | "screen";

export type ScreenShareSurface = "tab" | "screen";
export type ScreenAudioMode = "off" | "share";
export type ScreenShareOptions = {
  surface: ScreenShareSurface;
  audioMode: ScreenAudioMode;
};
const RTC_DEBUG_LABELS = new Set([
  "joinVoice:start",
  "joinVoice:audio-ready",
  "joinVoice:channel.join-sent",
  "leaveVoice:start",
  "leaveVoice:completed",
  "ensureAudio:getUserMedia:start",
  "ensureAudio:reused-prewarmed-stream",
  "ensureAudio:getUserMedia:completed",
  "refreshAudioInput:start",
  "refreshAudioInput:completed",
  "acquireAudioStream:advanced:start",
  "acquireAudioStream:advanced:completed",
  "acquireAudioStream:advanced:failed",
  "acquireAudioStream:fallback:start",
  "acquireAudioStream:fallback:completed",
  "acquireAudioStream:fallback:failed",
  "peer:created",
  "track:received",
  "negotiate:start",
  "negotiate:offer-sent",
  "signal:offer:ignored",
  "signal:answer:ignored",
  "signal:error",
]);

export class RTCController {
  private static readonly MEDIA_RECONNECT_DELAY_MS = 1500;
  private static readonly MEDIA_RECONNECT_MAX_ATTEMPTS = 5;
  private static readonly PEER_DISCONNECT_GRACE_MS = 5000;

  private localAudioStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;
  private prewarmedAudioStream: MediaStream | null = null;
  private audioAcquirePromise: Promise<MediaStream> | null = null;
  private prewarmReleaseTimer: number | null = null;
  private peers = new Map<number, PeerWrapper>();
  private remoteMedia = new Map<number, RemoteMedia>();
  private mediaReconnectAttempts = new Map<string, number>();
  private mediaReconnectTimers = new Map<string, number>();
  private peerDisconnectTimers = new Map<number, number>();
  private audioInputDeviceId = "";
  private noiseSuppressionEnabled = true;
  private micEnabled = true;

  private log(label: string, extra?: Record<string, unknown>) {
    if (!RTC_DEBUG_LABELS.has(label)) {
      return;
    }
    const stamp = new Date().toISOString();
    if (extra) {
      console.info(`[rtc][${stamp}] ${label}`, extra);
      return;
    }
    console.info(`[rtc][${stamp}] ${label}`);
  }

  constructor(
    private readonly socket: SocketClient,
    private readonly getCurrentVoiceChannelId: () => number | null,
    private readonly getCurrentUser: () => User | null,
    private readonly getMembers: () => DomainMember[],
    private readonly getVoiceMembers: () => Map<number, PresenceMember>,
    private readonly getIceServers: () => RTCIceServer[],
    private readonly onMediaChanged: (media: Map<number, RemoteMedia>) => void,
    private readonly onLocalAudioChanged: (stream: MediaStream | null) => void,
    private readonly onLocalScreenChanged: (stream: MediaStream | null) => void,
    private readonly onError: (message: string) => void,
  ) {}

  async joinVoice(channelId: number) {
    const startedAt = performance.now();
    this.log("joinVoice:start", { channelId });
    await this.ensureAudio();
    this.log("joinVoice:audio-ready", { channelId, elapsedMs: Math.round(performance.now() - startedAt) });
    this.socket.send("channel.join", { channelId });
    this.log("joinVoice:channel.join-sent", { channelId, elapsedMs: Math.round(performance.now() - startedAt) });
  }

  async leaveVoice() {
    const startedAt = performance.now();
    this.log("leaveVoice:start", { channelId: this.getCurrentVoiceChannelId() });
    this.socket.send("channel.leave", { channelId: this.getCurrentVoiceChannelId() });
    this.closeAllPeers();
    this.stopTrackGroup(this.localAudioStream);
    this.stopTrackGroup(this.prewarmedAudioStream);
    this.stopTrackGroup(this.localScreenStream);
    this.localAudioStream = null;
    this.prewarmedAudioStream = null;
    this.localScreenStream = null;
    this.clearPrewarmReleaseTimer();
    this.onLocalAudioChanged(null);
    this.onLocalScreenChanged(null);
    this.log("leaveVoice:completed", { elapsedMs: Math.round(performance.now() - startedAt) });
  }

  async toggleMic(enabled: boolean) {
    this.micEnabled = enabled;
    if (!this.localAudioStream) return;
    this.localAudioStream.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  async setAudioInputDevice(deviceId: string) {
    if (this.audioInputDeviceId === deviceId) {
      return;
    }
    this.audioInputDeviceId = deviceId;
    this.discardPrewarmedAudio("device-changed");
    if (!this.localAudioStream) return;
    await this.refreshAudioInput();
  }

  async setNoiseSuppression(enabled: boolean) {
    if (this.noiseSuppressionEnabled === enabled) {
      return;
    }
    this.noiseSuppressionEnabled = enabled;
    this.discardPrewarmedAudio("noise-suppression-changed");
    if (!this.localAudioStream) return;
    await this.refreshAudioInput();
  }

  async prewarmAudio() {
    try {
      const stream = await this.getOrAcquireAudioStream();
      if (this.localAudioStream) {
        return this.localAudioStream;
      }
      if (this.prewarmedAudioStream && this.prewarmedAudioStream !== stream) {
        this.stopTrackGroup(stream);
        this.schedulePrewarmRelease();
        return this.prewarmedAudioStream;
      }
      this.prewarmedAudioStream = stream;
      this.schedulePrewarmRelease();
      return stream;
    } catch (error) {
      throw error;
    }
  }

  primePrewarmedAudio(stream: MediaStream) {
    if (this.localAudioStream === stream || this.prewarmedAudioStream === stream) {
      this.clearPrewarmReleaseTimer();
      return;
    }
    if (this.prewarmedAudioStream && this.prewarmedAudioStream !== stream) {
      this.stopTrackGroup(this.prewarmedAudioStream);
    }
    this.prewarmedAudioStream = stream;
    this.clearPrewarmReleaseTimer();
    this.schedulePrewarmRelease();
  }

  async startScreenShare(options: ScreenShareOptions) {
    if (this.localScreenStream) return;
    const supported = navigator.mediaDevices.getSupportedConstraints() as MediaTrackSupportedConstraints & {
      restrictOwnAudio?: boolean;
    };
    const shareAudio = options.audioMode === "share";
    const displayOptions: Record<string, unknown> = {
      video: true,
      audio: false,
    };

    if (options.surface === "tab") {
      displayOptions.preferCurrentTab = true;
      displayOptions.selfBrowserSurface = "include";
      displayOptions.systemAudio = "exclude";
      if (shareAudio) {
        const audioConstraints: Record<string, unknown> = {
          suppressLocalAudioPlayback: true,
        };
        if (supported.restrictOwnAudio) {
          audioConstraints.restrictOwnAudio = true;
        }
        displayOptions.audio = audioConstraints;
      }
    } else {
      displayOptions.selfBrowserSurface = "exclude";
      displayOptions.systemAudio = shareAudio ? "include" : "exclude";
      if (shareAudio) {
        const audioConstraints: Record<string, unknown> = {
          suppressLocalAudioPlayback: true,
        };
        if (supported.restrictOwnAudio) {
          audioConstraints.restrictOwnAudio = true;
        }
        displayOptions.audio = audioConstraints;
      }
    }

    this.localScreenStream = await navigator.mediaDevices.getDisplayMedia(displayOptions as DisplayMediaStreamOptions);
    this.onLocalScreenChanged(this.localScreenStream);

    const [screenTrack] = this.localScreenStream.getVideoTracks();
    screenTrack?.addEventListener("ended", () => {
      void this.stopScreenShare(true);
    });

    this.localScreenStream.getAudioTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        void this.applyLocalTracksToAllPeers();
      });
    });

    await this.applyLocalTracksToAllPeers();
  }

  async stopScreenShare(notifyServer: boolean) {
    if (!this.localScreenStream) return;
    this.stopTrackGroup(this.localScreenStream);
    this.localScreenStream = null;
    this.onLocalScreenChanged(null);
    await this.applyLocalTracksToAllPeers();

    if (notifyServer && this.getCurrentVoiceChannelId()) {
      this.socket.send("screen.state", {
        channelId: this.getCurrentVoiceChannelId(),
        screenSharing: false,
      });
    }
  }

  async handlePresenceSnapshot(members: PresenceMember[]) {
    const startedAt = performance.now();
    const selfId = this.getCurrentUser()?.id;
    const seen = new Set<number>();

    for (const member of members) {
      if (member.user.id === selfId) continue;
      seen.add(member.user.id);
      await this.ensurePeer(member.user, true);
      this.ensureMediaFlow(member.user.id, "audio", "presence.snapshot");
      this.ensureMediaFlow(member.user.id, "screen", "presence.snapshot");
    }

    for (const [userId] of this.peers) {
      if (!seen.has(userId)) {
        this.handleMemberLeft(userId);
      }
    }

    this.log("joinVoice:audio-ready", { channelId: this.getCurrentVoiceChannelId(), elapsedMs: Math.round(performance.now() - startedAt) });
  }

  async handleMemberJoined(member: PresenceMember) {
    if (member.user.id === this.getCurrentUser()?.id) return;
    await this.ensurePeer(member.user, false);
    this.ensureMediaFlow(member.user.id, "audio", "member.joined");
    this.ensureMediaFlow(member.user.id, "screen", "member.joined");
  }

  handleMemberLeft(userId: number) {
    this.clearMediaReconnect(userId, "audio");
    this.clearMediaReconnect(userId, "screen");
    this.clearPeerDisconnectTimer(userId);
    const wrapper = this.peers.get(userId);
    if (!wrapper) return;
    wrapper.pc.close();
    this.peers.delete(userId);
    this.remoteMedia.delete(userId);
    this.onMediaChanged(new Map(this.remoteMedia));
  }

  async handleSignal(type: string, payload: SignalPayload) {
    try {
      const peerUser = this.lookupUser(payload.sourceUserId);
      if (!peerUser) return;

      const wrapper = await this.ensurePeer(peerUser, false);

      if ((type === "screen.sync_request" && this.localScreenStream) || type === "media.sync_request") {
        const requestedKind: MediaSyncKind =
          type === "screen.sync_request" ? "screen" : payload.kind === "audio" ? "audio" : "screen";
        if (requestedKind === "screen" && !this.localScreenStream) {
          return;
        }
        await this.bindLocalTracks(wrapper, true);
        await this.sendOffer(wrapper);
        return;
      }

      if (type === "rtc.offer" && payload.sdp) {
        const readyForOffer =
          !wrapper.makingOffer &&
          (wrapper.pc.signalingState === "stable" || wrapper.isSettingRemoteAnswerPending);
        const offerCollision = !readyForOffer;

        wrapper.ignoreOffer = !wrapper.polite && offerCollision;
        if (wrapper.ignoreOffer) {
          this.log("signal:offer:ignored", { userId: wrapper.user.id });
          return;
        }

        wrapper.isSettingRemoteAnswerPending = false;
        await wrapper.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        await this.bindLocalTracks(wrapper, true);
        await this.flushPendingIceCandidates(wrapper);
        await wrapper.pc.setLocalDescription();
        this.socket.send("rtc.answer", {
          channelId: this.getCurrentVoiceChannelId(),
          targetUserId: payload.sourceUserId,
          sdp: wrapper.pc.localDescription?.sdp,
        });
        return;
      }

      if (type === "rtc.answer" && payload.sdp) {
        if (wrapper.pc.signalingState !== "have-local-offer") {
          this.log("signal:answer:ignored", {
            userId: wrapper.user.id,
            signalingState: wrapper.pc.signalingState,
          });
          return;
        }
        wrapper.isSettingRemoteAnswerPending = true;
        await wrapper.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        wrapper.isSettingRemoteAnswerPending = false;
        await this.flushPendingIceCandidates(wrapper);
        return;
      }

      if (type === "rtc.ice_candidate" && payload.candidate) {
        const candidate = JSON.parse(payload.candidate) as RTCIceCandidateInit;
        if (!wrapper.pc.remoteDescription) {
          wrapper.pendingIceCandidates.push(candidate);
          return;
        }
        await wrapper.pc.addIceCandidate(candidate);
      }
    } catch (error) {
      console.error(error);
      this.log("signal:error", {
        type,
        sourceUserId: payload.sourceUserId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureAudio() {
    if (this.localAudioStream) return this.localAudioStream;
    const startedAt = performance.now();
    this.log("ensureAudio:getUserMedia:start", {
      deviceId: this.audioInputDeviceId || "auto",
      noiseSuppressionEnabled: this.noiseSuppressionEnabled,
      hasPrewarmedStream: Boolean(this.prewarmedAudioStream),
    });
    this.localAudioStream = await this.getOrAcquireAudioStream();
    if (this.prewarmedAudioStream === this.localAudioStream) {
      this.log("ensureAudio:reused-prewarmed-stream");
      this.prewarmedAudioStream = null;
    }
    this.clearPrewarmReleaseTimer();
    this.onLocalAudioChanged(this.localAudioStream);
    this.log("ensureAudio:getUserMedia:completed", { elapsedMs: Math.round(performance.now() - startedAt) });
    return this.localAudioStream;
  }

  private async refreshAudioInput() {
    const startedAt = performance.now();
    this.log("refreshAudioInput:start", {
      deviceId: this.audioInputDeviceId || "auto",
      noiseSuppressionEnabled: this.noiseSuppressionEnabled,
      peers: this.peers.size,
    });
    const nextStream = await this.acquireAudioStream();

    this.stopTrackGroup(this.localAudioStream);
    this.localAudioStream = nextStream;
    this.prewarmedAudioStream = null;
    this.clearPrewarmReleaseTimer();
    this.onLocalAudioChanged(this.localAudioStream);

    await this.applyLocalTracksToAllPeers();
    this.log("refreshAudioInput:completed", { peers: this.peers.size, elapsedMs: Math.round(performance.now() - startedAt) });
  }

  private getOrAcquireAudioStream() {
    if (this.localAudioStream) {
      return Promise.resolve(this.localAudioStream);
    }
    if (this.prewarmedAudioStream) {
      return Promise.resolve(this.prewarmedAudioStream);
    }
    if (this.audioAcquirePromise) {
      return this.audioAcquirePromise;
    }
    const nextPromise = this.acquireAudioStream().finally(() => {
      if (this.audioAcquirePromise === nextPromise) {
        this.audioAcquirePromise = null;
      }
    });
    this.audioAcquirePromise = nextPromise;
    return nextPromise;
  }

  private async acquireAudioStream() {
    const startedAt = performance.now();
    const advancedConstraints = this.buildPreferredAudioConstraints();
    this.log("acquireAudioStream:advanced:start", {
      explicitDeviceId: this.getExplicitAudioDeviceId() || null,
      noiseSuppressionEnabled: this.noiseSuppressionEnabled,
    });

    return await new Promise<MediaStream>((resolve, reject) => {
      let settled = false;
      let fallbackStarted = false;
      let failures = 0;
      let lastError: unknown = null;
      let fallbackTimer: number | null = window.setTimeout(() => {
        fallbackTimer = null;
        startFallback("timeout");
      }, 1200);

      const finishWithSuccess = (source: "advanced" | "fallback", stream: MediaStream) => {
        if (settled) {
          this.stopTrackGroup(stream);
          return;
        }
        settled = true;
        if (fallbackTimer) {
          window.clearTimeout(fallbackTimer);
        }
        stream.getAudioTracks().forEach((track) => {
          track.enabled = this.micEnabled;
        });
        this.log(`acquireAudioStream:${source}:completed`, {
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        resolve(stream);
      };

      const finishWithFailure = (source: "advanced" | "fallback", error: unknown) => {
        lastError = error;
        failures += 1;
        this.log(`acquireAudioStream:${source}:failed`, {
          message: error instanceof Error ? error.message : String(error),
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        if (source === "advanced" && !fallbackStarted) {
          startFallback("advanced-failed");
          return;
        }
        if (settled) return;
        if ((fallbackStarted && failures >= 2) || (!fallbackStarted && failures >= 1)) {
          if (fallbackTimer) {
            window.clearTimeout(fallbackTimer);
          }
          reject(lastError instanceof Error ? lastError : new Error(String(lastError)));
        }
      };

      const startFallback = (reason: "timeout" | "advanced-failed") => {
        if (fallbackStarted) return;
        fallbackStarted = true;
        if (fallbackTimer) {
          window.clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        this.log("acquireAudioStream:fallback:start", {
          reason,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        navigator.mediaDevices
          .getUserMedia({ audio: true, video: false })
          .then((stream) => finishWithSuccess("fallback", stream))
          .catch((error) => finishWithFailure("fallback", error));
      };

      navigator.mediaDevices
        .getUserMedia({
          audio: advancedConstraints,
          video: false,
        })
        .then((stream) => finishWithSuccess("advanced", stream))
        .catch((error) => finishWithFailure("advanced", error));
    });
  }

  private buildPreferredAudioConstraints(): MediaTrackConstraints {
    return {
      deviceId: this.getExplicitAudioDeviceId() ? { exact: this.getExplicitAudioDeviceId() } : undefined,
      noiseSuppression: this.noiseSuppressionEnabled,
      echoCancellation: true,
      autoGainControl: true,
    };
  }

  private getExplicitAudioDeviceId() {
    if (!this.audioInputDeviceId) return "";
    if (this.audioInputDeviceId === "default" || this.audioInputDeviceId === "communications") return "";
    return this.audioInputDeviceId;
  }

  private schedulePrewarmRelease() {
    this.clearPrewarmReleaseTimer();
    if (!this.prewarmedAudioStream || this.localAudioStream) return;
    this.prewarmReleaseTimer = window.setTimeout(() => {
      if (!this.prewarmedAudioStream || this.localAudioStream) return;
      this.stopTrackGroup(this.prewarmedAudioStream);
      this.prewarmedAudioStream = null;
      this.prewarmReleaseTimer = null;
    }, 30000);
  }

  private clearPrewarmReleaseTimer() {
    if (!this.prewarmReleaseTimer) return;
    window.clearTimeout(this.prewarmReleaseTimer);
    this.prewarmReleaseTimer = null;
  }

  private discardPrewarmedAudio(_reason: string) {
    if (!this.prewarmedAudioStream) return;
    this.stopTrackGroup(this.prewarmedAudioStream);
    this.prewarmedAudioStream = null;
    this.clearPrewarmReleaseTimer();
  }

  // ensurePeer 确保与目标用户的 RTCPeerConnection 存在，并按需绑定本地轨道。
  private async ensurePeer(user: User, initialOfferOwner: boolean) {
    const existing = this.peers.get(user.id);
    if (existing) {
      if (initialOfferOwner) {
        existing.initialOfferOwner = true;
        await this.bindLocalTracks(existing, true);
      }
      return existing;
    }

    const currentUser = this.getCurrentUser();
    if (!currentUser) {
      throw new Error("missing current user");
    }

    const pc = new RTCPeerConnection({
      iceServers: this.getIceServers(),
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceTransportPolicy: "all",
    });
    const audioTransceiver = pc.addTransceiver("audio", { direction: "recvonly" });
    const displayAudioTransceiver = pc.addTransceiver("audio", { direction: "recvonly" });
    const screenTransceiver = pc.addTransceiver("video", { direction: "recvonly" });

    const wrapper: PeerWrapper = {
      user,
      pc,
      polite: currentUser.id > user.id,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      initialOfferOwner,
      hasBoundLocalTracks: false,
      pendingIceCandidates: [],
      audioTransceiver,
      displayAudioTransceiver,
      screenTransceiver,
    };

    pc.addEventListener("negotiationneeded", () => {
      if (!wrapper.initialOfferOwner && !wrapper.hasBoundLocalTracks) {
        return;
      }
      void this.sendOffer(wrapper);
    });

    pc.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      this.socket.send("rtc.ice_candidate", {
        channelId: this.getCurrentVoiceChannelId(),
        targetUserId: user.id,
        candidate: JSON.stringify(event.candidate.toJSON()),
      });
    });

    pc.addEventListener("track", (event) => {
      this.log("track:received", { userId: user.id, kind: event.track.kind, streams: event.streams.length });
      const current = this.remoteMedia.get(user.id) || {
        user,
        audioStream: null,
        displayAudioStream: null,
        screenStream: null,
      };

      if (event.track.kind === "audio") {
        if (event.transceiver === wrapper.displayAudioTransceiver) {
          current.displayAudioStream = new MediaStream([event.track]);
          this.clearMediaReconnect(user.id, "screen");
        } else {
          current.audioStream = new MediaStream([event.track]);
          this.clearMediaReconnect(user.id, "audio");
        }
      }
      if (event.track.kind === "video") {
        current.screenStream = event.streams[0] || new MediaStream([event.track]);
        this.clearMediaReconnect(user.id, "screen");
      }

      event.track.addEventListener("ended", () => {
        const media = this.remoteMedia.get(user.id);
        if (!media) return;
        if (event.track.kind === "audio") {
          if (event.transceiver === wrapper.displayAudioTransceiver) {
            media.displayAudioStream = null;
            this.ensureMediaFlow(user.id, "screen", "remote-track-ended");
          } else {
            media.audioStream = null;
            this.ensureMediaFlow(user.id, "audio", "remote-track-ended");
          }
        } else if (event.track.kind === "video") {
          media.screenStream = null;
          this.ensureMediaFlow(user.id, "screen", "remote-track-ended");
        }
        this.remoteMedia.set(user.id, media);
        this.onMediaChanged(new Map(this.remoteMedia));
      });

      event.track.addEventListener("mute", () => {
        if (event.track.kind === "audio") {
          this.ensureMediaFlow(user.id, event.transceiver === wrapper.displayAudioTransceiver ? "screen" : "audio", "remote-track-muted");
        } else if (event.track.kind === "video") {
          this.ensureMediaFlow(user.id, "screen", "remote-track-muted");
        }
      });

      this.remoteMedia.set(user.id, current);
      this.onMediaChanged(new Map(this.remoteMedia));
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") {
        this.clearPeerDisconnectTimer(user.id);
        return;
      }
      if (pc.connectionState === "disconnected") {
        this.schedulePeerDisconnectCleanup(user.id);
        this.ensureMediaFlow(user.id, "audio", "peer-disconnected");
        this.ensureMediaFlow(user.id, "screen", "peer-disconnected");
        return;
      }
      if (["failed", "closed"].includes(pc.connectionState)) {
        this.handleMemberLeft(user.id);
      }
    });

    this.peers.set(user.id, wrapper);
    if (initialOfferOwner) {
      await this.bindLocalTracks(wrapper, true);
    }
    this.log("peer:created", { userId: user.id, shouldOffer: initialOfferOwner });
    return wrapper;
  }

  private async bindLocalTracks(wrapper: PeerWrapper, includeLocalTracks: boolean) {
    const [audioTrack] = includeLocalTracks ? this.localAudioStream?.getAudioTracks() || [] : [];
    const [displayAudioTrack] = includeLocalTracks ? this.localScreenStream?.getAudioTracks() || [] : [];
    const [screenTrack] = includeLocalTracks ? this.localScreenStream?.getVideoTracks() || [] : [];

    await wrapper.audioTransceiver.sender.replaceTrack(audioTrack || null);
    wrapper.audioTransceiver.direction = audioTrack ? "sendrecv" : "recvonly";

    await wrapper.displayAudioTransceiver.sender.replaceTrack(displayAudioTrack || null);
    wrapper.displayAudioTransceiver.direction = displayAudioTrack ? "sendrecv" : "recvonly";

    await wrapper.screenTransceiver.sender.replaceTrack(screenTrack || null);
    wrapper.screenTransceiver.direction = screenTrack ? "sendrecv" : "recvonly";

    wrapper.hasBoundLocalTracks = includeLocalTracks;
  }

  private async applyLocalTracksToAllPeers() {
    await Promise.all(
      Array.from(this.peers.values()).map(async (wrapper) => {
        await this.bindLocalTracks(wrapper, true);
      }),
    );
  }

  private async sendOffer(wrapper: PeerWrapper) {
    const pc = wrapper.pc;
    if (wrapper.makingOffer) {
      return;
    }
    if (pc.signalingState !== "stable") {
      return;
    }
    const startedAt = performance.now();
    try {
      wrapper.makingOffer = true;
      this.log("negotiate:start", { userId: wrapper.user.id });
      await pc.setLocalDescription();
      this.socket.send("rtc.offer", {
        channelId: this.getCurrentVoiceChannelId(),
        targetUserId: wrapper.user.id,
        sdp: pc.localDescription?.sdp,
      });
      this.log("negotiate:offer-sent", {
        userId: wrapper.user.id,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      console.error(error);
      this.onError("WebRTC 协商失败，请刷新后重试");
    } finally {
      wrapper.makingOffer = false;
    }
  }

  private async flushPendingIceCandidates(wrapper: PeerWrapper) {
    if (!wrapper.pc.remoteDescription || !wrapper.pendingIceCandidates.length) return;
    const queued = [...wrapper.pendingIceCandidates];
    wrapper.pendingIceCandidates = [];
    for (const candidate of queued) {
      try {
        await wrapper.pc.addIceCandidate(candidate);
      } catch (error) {
        if (!wrapper.ignoreOffer) {
          console.error(error);
        }
      }
    }
  }

  private closeAllPeers() {
    for (const key of this.mediaReconnectTimers.keys()) {
      const [rawUserId, kind] = key.split(":");
      this.clearMediaReconnect(Number(rawUserId), kind as MediaSyncKind);
    }
    for (const userId of this.peerDisconnectTimers.keys()) {
      this.clearPeerDisconnectTimer(userId);
    }
    for (const wrapper of this.peers.values()) {
      wrapper.pc.close();
    }
    this.peers.clear();
    this.remoteMedia.clear();
    this.onMediaChanged(new Map(this.remoteMedia));
  }

  private stopTrackGroup(stream: MediaStream | null) {
    stream?.getTracks().forEach((track) => track.stop());
  }

  private lookupUser(userId: number) {
    const voiceUser = this.getVoiceMembers().get(userId)?.user;
    if (voiceUser) return voiceUser;
    return this.getMembers().find((member) => member.id === userId) || null;
  }

  handleScreenState(userId: number, screenSharing: boolean) {
    if (!screenSharing) {
      this.clearMediaReconnect(userId, "screen");
      return;
    }
    this.ensureMediaFlow(userId, "screen", "screen.state");
  }

  handleVoiceState(userId: number, micEnabled: boolean) {
    if (!micEnabled) {
      this.clearMediaReconnect(userId, "audio");
      return;
    }
    this.ensureMediaFlow(userId, "audio", "voice.state");
  }

  private ensureMediaFlow(userId: number, kind: MediaSyncKind, reason: string) {
    if (!this.getCurrentVoiceChannelId()) return;
    if (userId === this.getCurrentUser()?.id) return;
    const voiceMember = this.getVoiceMembers().get(userId);
    if (!voiceMember) return;
    if (kind === "screen" && !voiceMember.screenSharing) return;
    const media = this.remoteMedia.get(userId);
    const existingStream = kind === "audio" ? media?.audioStream : media?.screenStream;
    if (existingStream) {
      this.clearMediaReconnect(userId, kind);
      return;
    }
    this.requestMediaSync(userId, kind, reason);
  }

  private requestMediaSync(userId: number, kind: MediaSyncKind, reason: string) {
    if (!this.getCurrentVoiceChannelId()) return;
    const voiceMember = this.getVoiceMembers().get(userId);
    if (!voiceMember) {
      this.clearMediaReconnect(userId, kind);
      return;
    }
    if (kind === "screen" && !voiceMember.screenSharing) {
      this.clearMediaReconnect(userId, kind);
      return;
    }
    const reconnectKey = this.mediaReconnectKey(userId, kind);
    const attempt = (this.mediaReconnectAttempts.get(reconnectKey) || 0) + 1;
    if (attempt > RTCController.MEDIA_RECONNECT_MAX_ATTEMPTS) {
      this.clearMediaReconnect(userId, kind);
      return;
    }
    this.mediaReconnectAttempts.set(reconnectKey, attempt);
    this.clearMediaReconnectTimerOnly(reconnectKey);
    this.socket.send("media.sync_request", {
      channelId: this.getCurrentVoiceChannelId(),
      targetUserId: userId,
      kind,
      reason,
      attempt,
    });
    const timer = window.setTimeout(() => {
      this.mediaReconnectTimers.delete(reconnectKey);
      this.requestMediaSync(userId, kind, "retry");
    }, RTCController.MEDIA_RECONNECT_DELAY_MS);
    this.mediaReconnectTimers.set(reconnectKey, timer);
  }

  private clearMediaReconnect(userId: number, kind: MediaSyncKind) {
    const reconnectKey = this.mediaReconnectKey(userId, kind);
    this.clearMediaReconnectTimerOnly(reconnectKey);
    this.mediaReconnectAttempts.delete(reconnectKey);
  }

  private clearMediaReconnectTimerOnly(reconnectKey: string) {
    const timer = this.mediaReconnectTimers.get(reconnectKey);
    if (!timer) return;
    window.clearTimeout(timer);
    this.mediaReconnectTimers.delete(reconnectKey);
  }

  private schedulePeerDisconnectCleanup(userId: number) {
    if (this.peerDisconnectTimers.has(userId)) {
      return;
    }
    const timer = window.setTimeout(() => {
      this.peerDisconnectTimers.delete(userId);
      const wrapper = this.peers.get(userId);
      if (!wrapper) return;
      if (wrapper.pc.connectionState === "disconnected") {
        this.handleMemberLeft(userId);
      }
    }, RTCController.PEER_DISCONNECT_GRACE_MS);
    this.peerDisconnectTimers.set(userId, timer);
  }

  private clearPeerDisconnectTimer(userId: number) {
    const timer = this.peerDisconnectTimers.get(userId);
    if (!timer) return;
    window.clearTimeout(timer);
    this.peerDisconnectTimers.delete(userId);
  }

  private mediaReconnectKey(userId: number, kind: MediaSyncKind) {
    return `${userId}:${kind}`;
  }
}
