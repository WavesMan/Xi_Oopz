function wait(value) {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(value), 0);
  });
}

export class RTCController {
  constructor({ state, socket, onMediaChanged, onError }) {
    this.state = state;
    this.socket = socket;
    this.onMediaChanged = onMediaChanged;
    this.onError = onError;
    this.localAudioStream = null;
    this.localScreenStream = null;
    this.peers = new Map();
    this.remoteMedia = new Map();
  }

  async ensureAudio() {
    if (this.localAudioStream) return this.localAudioStream;
    this.localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.localAudioStream.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    return this.localAudioStream;
  }

  async joinVoice(channelId) {
    await this.ensureAudio();
    this.socket.send("channel.join", { channelId });
  }

  async leaveVoice() {
    this.socket.send("channel.leave", { channelId: this.state.currentVoiceChannelId });
    this.closeAllPeers();
    this.stopTrackGroup(this.localAudioStream);
    this.stopScreenShare(false);
    this.localAudioStream = null;
  }

  async toggleMic(enabled) {
    if (!this.localAudioStream) return;
    this.localAudioStream.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  async startScreenShare() {
    if (this.localScreenStream) return;
    this.localScreenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });

    const [screenTrack] = this.localScreenStream.getVideoTracks();
    screenTrack.addEventListener("ended", () => {
      this.stopScreenShare(true);
    });

    for (const wrapper of this.peers.values()) {
      if (!wrapper.screenSender && screenTrack) {
        wrapper.screenSender = wrapper.pc.addTrack(screenTrack, this.localScreenStream);
      }
      await this.negotiate(wrapper);
    }
  }

  async stopScreenShare(notifyServer = true) {
    if (!this.localScreenStream) return;
    this.stopTrackGroup(this.localScreenStream);

    for (const wrapper of this.peers.values()) {
      if (wrapper.screenSender) {
        wrapper.pc.removeTrack(wrapper.screenSender);
        wrapper.screenSender = null;
        await this.negotiate(wrapper);
      }
    }

    this.localScreenStream = null;
    if (notifyServer && this.state.currentVoiceChannelId) {
      this.socket.send("screen.state", {
        channelId: this.state.currentVoiceChannelId,
        screenSharing: false,
      });
    }
  }

  async handlePresenceSnapshot(members) {
    const others = members.filter((member) => member.user.id !== this.state.user.id);
    for (const member of others) {
      const wrapper = await this.ensurePeer(member.user, true);
      await this.negotiate(wrapper);
    }
  }

  async handleMemberJoined(member) {
    if (member.user.id === this.state.user.id) return;
    await this.ensurePeer(member.user, false);
  }

  handleMemberLeft(userId) {
    const wrapper = this.peers.get(userId);
    if (!wrapper) return;
    wrapper.pc.close();
    this.peers.delete(userId);
    this.remoteMedia.delete(userId);
    this.onMediaChanged(new Map(this.remoteMedia));
  }

  async handleSignal(type, payload) {
    const sourceUser = this.findMember(payload.sourceUserId);
    if (!sourceUser) return;
    const wrapper = await this.ensurePeer(sourceUser, false);

    if (type === "rtc.offer") {
      const collision = wrapper.makingOffer || wrapper.pc.signalingState !== "stable";
      wrapper.ignoreOffer = !wrapper.polite && collision;
      if (wrapper.ignoreOffer) {
        return;
      }

      await wrapper.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      await this.ensureLocalTracks(wrapper);
      await wrapper.pc.setLocalDescription(await wrapper.pc.createAnswer());
      this.socket.send("rtc.answer", {
        channelId: this.state.currentVoiceChannelId,
        targetUserId: payload.sourceUserId,
        sdp: wrapper.pc.localDescription.sdp,
      });
      return;
    }

    if (type === "rtc.answer") {
      await wrapper.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      return;
    }

    if (type === "rtc.ice_candidate" && payload.candidate) {
      try {
        await wrapper.pc.addIceCandidate(JSON.parse(payload.candidate));
      } catch (error) {
        if (!wrapper.ignoreOffer) {
          console.error("ice candidate failed", error);
        }
      }
    }
  }

  async ensurePeer(user, shouldOffer) {
    if (this.peers.has(user.id)) {
      return this.peers.get(user.id);
    }

    const pc = new RTCPeerConnection({
      iceServers: this.state.stunServers.length ? this.state.stunServers : [{ urls: "stun:stun.l.google.com:19302" }],
    });

    const wrapper = {
      user,
      pc,
      polite: this.state.user.id > user.id,
      makingOffer: false,
      ignoreOffer: false,
      audioSender: null,
      screenSender: null,
      initiated: shouldOffer,
    };

    pc.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      this.socket.send("rtc.ice_candidate", {
        channelId: this.state.currentVoiceChannelId,
        targetUserId: user.id,
        candidate: JSON.stringify(event.candidate.toJSON()),
      });
    });

    pc.addEventListener("track", (event) => {
      const current = this.remoteMedia.get(user.id) || {
        user,
        audioStream: null,
        screenStream: null,
      };

      if (event.track.kind === "audio") {
        current.audioStream = event.streams[0];
      } else if (event.track.kind === "video") {
        current.screenStream = event.streams[0];
      }
      this.remoteMedia.set(user.id, current);
      this.onMediaChanged(new Map(this.remoteMedia));
    });

    pc.addEventListener("connectionstatechange", () => {
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        this.handleMemberLeft(user.id);
      }
    });

    await this.ensureLocalTracks(wrapper);
    this.peers.set(user.id, wrapper);
    return wrapper;
  }

  async ensureLocalTracks(wrapper) {
    if (this.localAudioStream && !wrapper.audioSender) {
      const [audioTrack] = this.localAudioStream.getAudioTracks();
      if (audioTrack) {
        wrapper.audioSender = wrapper.pc.addTrack(audioTrack, this.localAudioStream);
      }
    }

    if (this.localScreenStream && !wrapper.screenSender) {
      const [screenTrack] = this.localScreenStream.getVideoTracks();
      if (screenTrack) {
        wrapper.screenSender = wrapper.pc.addTrack(screenTrack, this.localScreenStream);
      }
    }
    await wait();
  }

  async negotiate(wrapper) {
    if (!wrapper.initiated && wrapper.pc.signalingState !== "stable") {
      return;
    }
    try {
      wrapper.makingOffer = true;
      await wrapper.pc.setLocalDescription(await wrapper.pc.createOffer());
      this.socket.send("rtc.offer", {
        channelId: this.state.currentVoiceChannelId,
        targetUserId: wrapper.user.id,
        sdp: wrapper.pc.localDescription.sdp,
      });
    } catch (error) {
      console.error("offer failed", error);
      this.onError("WebRTC 协商失败，请刷新后重试");
    } finally {
      wrapper.makingOffer = false;
      wrapper.initiated = true;
    }
  }

  closeAllPeers() {
    for (const wrapper of this.peers.values()) {
      wrapper.pc.close();
    }
    this.peers.clear();
    this.remoteMedia.clear();
    this.onMediaChanged(new Map(this.remoteMedia));
  }

  stopTrackGroup(stream) {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
  }

  findMember(userId) {
    const voiceMember = this.state.voiceMembers.get(userId);
    if (voiceMember) return voiceMember.user;
    const domainMember = this.state.members.find((member) => member.id === userId);
    return domainMember || null;
  }
}
