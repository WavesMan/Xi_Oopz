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
- `MYSQL_DSN`
- `REDIS_ADDR`
- `REDIS_PASSWORD`
- `AUTH_SECRET`

默认本地值已经和 `docker-compose.yml` 对齐。

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
