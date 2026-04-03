function initials(name) {
  return (name || "?").trim().slice(0, 2).toUpperCase();
}

function formatTime(value) {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function render(state) {
  renderShell(state);
  renderChannels(state);
  renderMessages(state);
  renderMembers(state);
  renderVoiceStage(state);
}

export function renderShell(state) {
  document.getElementById("domainName").textContent = state.domain?.name || "Oopz Live";
  document.getElementById("domainDescription").textContent = state.domain?.description || "";
  document.getElementById("selfName").textContent = state.user?.displayName || "Guest";
  document.getElementById("selfAvatar").textContent = initials(state.user?.displayName);
  document.getElementById("selfAvatar").style.background = state.user?.avatarColor || "#455A64";

  const currentChannel = state.activeChannel;
  document.getElementById("currentChannelLabel").textContent = currentChannel ? `# ${currentChannel.name}` : "No channel";
  document.getElementById("currentChannelTopic").textContent = currentChannel?.topic || "";
  document.getElementById("voiceStatusText").textContent = state.currentVoiceChannelId
    ? `In voice · ${voiceCount(state)} online`
    : "Not in voice";
  document.getElementById("heroOnlineCount").textContent = String(voiceCount(state));
  document.getElementById("memberSummary").textContent = `${state.members.length} members`;

  const joinButton = document.getElementById("joinVoiceButton");
  const leaveButton = document.getElementById("leaveVoiceButton");
  const micButton = document.getElementById("micButton");
  const screenButton = document.getElementById("screenButton");

  const isVoiceChannel = currentChannel?.type === "voice";
  joinButton.disabled = !isVoiceChannel || state.currentVoiceChannelId === currentChannel?.id;
  leaveButton.disabled = !state.currentVoiceChannelId;
  micButton.disabled = !state.currentVoiceChannelId;
  screenButton.disabled = !state.currentVoiceChannelId;
}

export function renderChannels(state) {
  const tree = document.getElementById("channelTree");
  tree.innerHTML = "";

  state.categories.forEach((category) => {
    const wrapper = document.createElement("div");
    wrapper.className = "channel-group";
    wrapper.innerHTML = `<div class="channel-group__title">${category.name}</div>`;

    category.channels.forEach((channel) => {
      const item = document.createElement("button");
      const online = channel.type === "voice" ? Number(state.onlineCounts[String(channel.id)] || 0) : null;
      const selected = state.selectedChannelId === channel.id;
      item.className = `channel-item ${selected ? "channel-item--active" : ""}`;
      item.dataset.channelId = String(channel.id);
      item.innerHTML = `
        <span>${channel.type === "voice" ? "◉" : "#"}</span>
        <span class="channel-item__name">${channel.name}</span>
        ${online !== null ? `<span class="channel-item__meta">${online}/${channel.maxMembers}</span>` : ""}
      `;
      wrapper.appendChild(item);
    });

    tree.appendChild(wrapper);
  });
}

export function renderMessages(state) {
  const list = document.getElementById("messageList");
  list.innerHTML = "";

  if (!state.messages.length) {
    list.innerHTML = `<div class="empty-state">这里还没有消息。可以先发一句，或者直接进入语音房。</div>`;
    return;
  }

  state.messages.forEach((message) => {
    const row = document.createElement("article");
    row.className = `message-row ${message.messageType === "system" ? "message-row--system" : ""}`;
    row.innerHTML = `
      <div class="avatar" style="background:${message.userAvatarColor}">${initials(message.userDisplayName)}</div>
      <div class="message-body">
        <div class="message-meta">
          <strong>${message.userDisplayName}</strong>
          <span>${formatTime(message.createdAt)}</span>
        </div>
        <p>${escapeHTML(message.body)}</p>
      </div>
    `;
    list.appendChild(row);
  });

  list.scrollTop = list.scrollHeight;
}

export function renderMembers(state) {
  const list = document.getElementById("memberList");
  list.innerHTML = "";

  const onlineIds = new Set([...state.voiceMembers.keys()]);
  const onlineMembers = state.members.filter((member) => onlineIds.has(member.id));
  const offlineMembers = state.members.filter((member) => !onlineIds.has(member.id));

  list.appendChild(makeMemberSection("在线", onlineMembers, state.voiceMembers));
  list.appendChild(makeMemberSection("离线", offlineMembers, state.voiceMembers));
}

export function renderVoiceStage(state) {
  const stage = document.getElementById("voiceStage");
  stage.innerHTML = "";

  const localCard = document.createElement("div");
  localCard.className = "stage-card";
  localCard.innerHTML = `
    <div class="stage-card__header">
      <div class="avatar avatar--large" style="background:${state.user?.avatarColor || "#556"}">${initials(state.user?.displayName)}</div>
      <div>
        <strong>${state.user?.displayName || "You"}</strong>
        <p>${state.currentVoiceChannelId ? "本地设备已准备" : "未加入语音房"}</p>
      </div>
    </div>
    <div class="stage-card__chips">
      <span class="chip">${state.currentVoiceChannelId ? "Connected" : "Idle"}</span>
      <span class="chip">${state.activeChannel?.type === "voice" ? "Voice Channel" : "Text Channel"}</span>
    </div>
  `;
  stage.appendChild(localCard);

  if (!state.remoteMedia.size) {
    const empty = document.createElement("div");
    empty.className = "stage-placeholder";
    empty.textContent = "加入语音房后，这里会出现远端成员与屏幕共享。";
    stage.appendChild(empty);
    return;
  }

  state.remoteMedia.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "stage-card";
    card.innerHTML = `
      <div class="stage-card__header">
        <div class="avatar avatar--large" style="background:${entry.user.avatarColor}">${initials(entry.user.displayName)}</div>
        <div>
          <strong>${entry.user.displayName}</strong>
          <p>${entry.screenStream ? "正在共享屏幕" : "语音在线中"}</p>
        </div>
      </div>
      <div class="remote-media"></div>
    `;

    const mediaRoot = card.querySelector(".remote-media");
    if (entry.screenStream) {
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = entry.screenStream;
      mediaRoot.appendChild(video);
    }
    if (entry.audioStream) {
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.srcObject = entry.audioStream;
      mediaRoot.appendChild(audio);
      const label = document.createElement("div");
      label.className = "audio-badge";
      label.textContent = "Audio connected";
      mediaRoot.appendChild(label);
    }
    stage.appendChild(card);
  });
}

function makeMemberSection(title, members, voiceMembers) {
  const section = document.createElement("section");
  section.className = "member-section";

  const titleEl = document.createElement("h4");
  titleEl.textContent = `${title} · ${members.length}`;
  section.appendChild(titleEl);

  members.forEach((member) => {
    const presence = voiceMembers.get(member.id);
    const row = document.createElement("div");
    row.className = "member-row";
    row.innerHTML = `
      <div class="avatar" style="background:${member.avatarColor}">${initials(member.displayName)}</div>
      <div class="member-row__content">
        <strong>${member.displayName}</strong>
        <span>${presence ? `${presence.micEnabled ? "Mic On" : "Muted"} · ${presence.screenSharing ? "Sharing" : "No Share"}` : member.role}</span>
      </div>
    `;
    section.appendChild(row);
  });

  if (!members.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state empty-state--small";
    empty.textContent = "暂无成员";
    section.appendChild(empty);
  }

  return section;
}

function voiceCount(state) {
  return state.voiceMembers.size;
}

function escapeHTML(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
