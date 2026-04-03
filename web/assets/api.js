const JSON_HEADERS = {
  "Content-Type": "application/json",
};

export async function createGuestUser(displayName) {
  const response = await fetch("/api/users/guest", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ displayName }),
  });
  if (!response.ok) {
    throw new Error("无法创建用户");
  }
  return response.json();
}

export async function fetchBootstrap(userId, channelId) {
  const params = new URLSearchParams({ userId: String(userId) });
  if (channelId) params.set("channelId", String(channelId));

  const response = await fetch(`/api/bootstrap?${params.toString()}`);
  if (!response.ok) {
    throw new Error("加载引导数据失败");
  }
  return response.json();
}

export async function fetchChannelMessages(domainId, channelId) {
  const response = await fetch(`/api/domains/${domainId}/channels/${channelId}/messages`);
  if (!response.ok) {
    throw new Error("加载频道消息失败");
  }
  return response.json();
}
