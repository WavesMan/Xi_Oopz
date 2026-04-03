# Oopz Live

一个参考 Discord 交互模式的 WebRTC 连麦与屏幕共享网站 MVP。

## 技术栈

- 前端：React + TypeScript + Vite
- 后端：Gin + GORM + WebSocket + Redis + MySQL
- 实时音视频：浏览器 WebRTC mesh

## 当前能力

- 账号注册 / 登录 / token 鉴权
- 域 / 分类 / 频道模型
- 域详情、成员列表、频道树、分类创建、频道创建、频道更新接口
- 频道内文字消息，通过 WS 广播并写入 MySQL
- 语音房加入 / 离开系统消息，仅在当前频道内通过 WS 实时广播
- Redis 维护在线语音房与成员 presence
- WebRTC `offer` / `answer` / `ice_candidate` 信令转发
- 麦克风开关状态同步
- 屏幕共享开关状态同步与重协商
- Discord 风格三栏 UI

## 运行方式

1. 启动依赖：

```bash
docker compose up -d
```

2. 拉取 Go 依赖并启动服务：

```bash
go mod tidy
go run ./cmd/server
```

服务启动时会自动执行 `GORM AutoMigrate`，确保所需数据表存在。

3. 前端开发：

```bash
cd frontend
npm install
npm run dev
```

如果你想让 Gin 直接服务前端页面，先执行：

```bash
cd frontend
npm install
npm run build
cd ..
go run ./cmd/server
```

Gin 会优先服务 `frontend/dist`；如果 dist 还没构建，会回退到仓库里的静态原型页。

4. 浏览器打开：

```text
前端开发模式: http://localhost:5173
后端直出模式: http://localhost:8080
```

## 环境变量

- `PORT`
- `HTTPS_ENABLED`
- `TLS_CERT_FILE`
- `TLS_KEY_FILE`
- `MYSQL_DSN`
- `REDIS_ADDR`
- `REDIS_PASSWORD`
- `AUTH_SECRET`

默认本地值已经和 `docker-compose.yml` 对齐。

## 一键本地 HTTPS 调试

为了在局域网多设备上测试 WebRTC 麦克风、屏幕共享和 `wss`，推荐直接启用本地 HTTPS。

1. 先生成本地证书，例如使用 `mkcert`：

```bash
mkcert -install
mkcert localhost 127.0.0.1 192.168.1.100
```

2. 把证书路径写进 `.env`：

```bash
HTTPS_ENABLED=true
PORT=8443
TLS_CERT_FILE=/absolute/path/to/localhost+2.pem
TLS_KEY_FILE=/absolute/path/to/localhost+2-key.pem
```

3. 一键启动 HTTPS 版：

```bash
./scripts/run-local-https.sh
```

4. 访问：

```text
https://localhost:8443
https://你的局域网IP:8443
```

前端 WebSocket 会根据页面协议自动切换成 `wss://`，不需要额外改代码。

说明：

- 如果其他设备要信任这张本地证书，需要在测试设备里安装并信任 `mkcert` 生成的本地根证书
- 如果没有配置 `TLS_CERT_FILE` / `TLS_KEY_FILE`，服务会继续按 HTTP 模式运行

## 服务器部署（Nginx + Gin）

如果你的服务器已经有 MySQL 和 Redis，只需要部署：

- `frontend/dist`
- Gin 二进制
- Nginx 反向代理

推荐目录：

```text
/home/oopz/oopz-live/
├── frontend/dist
├── release/oopz-live-linux-amd64
└── deploy/
```

本仓库提供：

- Nginx 配置模板：[deploy/nginx/oopz.xixiu.top.conf](/Users/xixiu/Documents/New%20project/deploy/nginx/oopz.xixiu.top.conf)
- systemd 模板：[deploy/systemd/oopz-live.service](/Users/xixiu/Documents/New%20project/deploy/systemd/oopz-live.service)

说明：

- Nginx 代理 `https://oopz.xixiu.top/api` 和 `wss://oopz.xixiu.top/ws` 到本机 Gin `127.0.0.1:18080`
- 静态前端由 Nginx 直接从 `frontend/dist` 提供
- Gin 不需要再自己启 HTTPS，线上 TLS 终止交给 Nginx

## 关键流程

- 首次进入页面注册或登录账号
- 前端用 Bearer token 请求 `/api/auth/me` 与 `/api/bootstrap`
- 前端建立 `/ws?token=...&domainId=...` 连接
- 进入语音频道后，浏览器获取麦克风并发送 `channel.join`
- 新加入用户收到 `presence.snapshot`，向房内其他成员发起 WebRTC 连接
- 文本消息 / join / leave / mic / screen 事件通过 WS 广播
- 普通文本消息持久化到 MySQL，加入 / 离开消息不落库
- 在线房间与在线人数由 Redis hash / set 维护
- 屏幕共享支持浏览器内放大预览与系统全屏两种查看方式

## 新增接口

- `GET /api/domains/:domainId`
- `PATCH /api/domains/:domainId`
- `GET /api/domains/:domainId/members`
- `GET /api/domains/:domainId/channels`
- `GET /api/domains/:domainId/presence`
- `POST /api/domains/:domainId/categories`
- `POST /api/domains/:domainId/channels`
- `PATCH /api/channels/:channelId`
- `GET /api/domains/:domainId/channels/:channelId/messages?limit=60&beforeId=123`

## 手测建议

1. 打开两个浏览器会话，例如一个普通窗口加一个无痕窗口。
2. 分别注册两个不同账号并登录。
3. 进入同一个语音频道，确认成员列表与在线人数变化。
4. 在文本频道发送消息，确认另一侧实时收到。
5. 分别测试开关麦克风与屏幕共享，确认状态同步。

## 注意事项

- 这是 mesh WebRTC 版本，建议单房间控制在 6 人以内
- 屏幕共享在多数浏览器里要求安全上下文，正式环境请使用 HTTPS
- 现在的 WebSocket hub 是单节点内存广播，Redis 主要承担在线房间状态；如果要多实例横向扩展，需要继续补 Redis Pub/Sub 或消息总线
