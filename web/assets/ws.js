export class SocketClient {
  constructor({ userId, domainId, onEvent, onStatus }) {
    this.userId = userId;
    this.domainId = domainId;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.socket = null;
    this.heartbeat = null;
  }

  connect() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${window.location.host}/ws?userId=${this.userId}&domainId=${this.domainId}`);

    this.socket.addEventListener("open", () => {
      this.onStatus(true);
      this.send("hello", {});
      this.heartbeat = window.setInterval(() => this.send("heartbeat", {}), 15000);
    });

    this.socket.addEventListener("close", () => {
      this.onStatus(false);
      if (this.heartbeat) window.clearInterval(this.heartbeat);
      window.setTimeout(() => this.connect(), 2000);
    });

    this.socket.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        this.onEvent(parsed.type, parsed.payload);
      } catch (error) {
        console.error("invalid ws message", error);
      }
    });
  }

  send(type, payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type, payload }));
  }
}
