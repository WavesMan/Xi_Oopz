type SocketFrame = {
  type: string;
  payload: unknown;
};

/**
 * 判断运行时数据是否符合 Socket 帧结构。
 */
function isSocketFrame(value: unknown): value is SocketFrame {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === "string" && "payload" in record;
}

export class SocketClient {
  private socket: WebSocket | null = null;
  private heartbeat: number | null = null;
  private manualClose = false;

  constructor(
    private readonly token: string,
    private readonly domainId: number,
    private readonly onEvent: (type: string, payload: unknown) => void,
    private readonly onStatus: (connected: boolean) => void,
  ) {}

  connect() {
    this.manualClose = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(this.token)}&domainId=${this.domainId}`);

    this.socket.addEventListener("open", () => {
      this.onStatus(true);
      this.send("hello", {});
      this.heartbeat = window.setInterval(() => this.send("heartbeat", {}), 15000);
    });

    this.socket.addEventListener("close", () => {
      this.onStatus(false);
      if (this.heartbeat) {
        window.clearInterval(this.heartbeat);
      }
      if (!this.manualClose) {
        window.setTimeout(() => this.connect(), 2000);
      }
    });

    this.socket.addEventListener("message", (event) => {
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (!isSocketFrame(parsed)) return;
        this.onEvent(parsed.type, parsed.payload);
      } catch (error) {
        console.warn("WS 消息解析失败", error);
      }
    });
  }

  close() {
    this.manualClose = true;
    if (this.heartbeat) {
      window.clearInterval(this.heartbeat);
    }
    this.socket?.close();
  }

  send(type: string, payload: unknown) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type, payload }));
  }
}
