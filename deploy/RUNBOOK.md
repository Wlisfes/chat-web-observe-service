# Observe 服务运行手册

## 运行基线

| 项目                   | 基线                                                         |
| ---------------------- | ------------------------------------------------------------ |
| 容器                   | `chat-web-observe-service`                                   |
| HTTP 端口              | `5100`（主机只绑定 `127.0.0.1`，用于健康检查和 Swagger）     |
| TCP 端口               | `5101`（不映射到主机，Dispatch 经 Docker 网络访问）          |
| Nacos Data ID / 服务名 | `chat-web-observe-service.yaml` / `chat-web-observe-service` |
| 数据库配置键           | `database.chat-web-srm`（只读）                              |
| 数据库账号             | `chat_web_observe_service`                                   |
| RabbitMQ               | `/chat-sms`，账号复用 Dispatch                              |
| 部署目录               | `/opt/chat-web-observe-service`                              |

## 首次部署前准备

1. 部署主机已存在外部网络 `chat-web-infrastructure`、MySQL 容器 `chat-web-mysql`，以及 Finance 或 Gateway 的 `.env` 可供继承 Nacos 连接参数。
2. 仓库已注册带 `chat-home-server` 标签的自托管 Runner。
3. 部署时 `bootstrap-database.sh` 创建 `chat_web_observe_service` 并授予 `chat-web-srm` 中 `tb_srm_simbank_message`、`tb_srm_simbank`、`tb_srm_simbank_port` 的 `SELECT`；`bootstrap-nacos-config.cjs` 在 Nacos 缺少配置时创建，已有配置只校验。

## 流水线

推送 `main` 或手动触发 `workflow_dispatch` 后执行：

1. GitHub Hosted Runner 安装依赖、格式检查、构建并运行测试。
2. 构建 `ghcr.io/wlisfes/chat-web-observe-service:<Git SHA>` 镜像并推送 GHCR。
3. `chat-home-server` 自托管 Runner 拉取镜像，执行 `deploy/deploy.sh`，等待容器健康后检查 `/health` 和 TCP `5101`。

## 验证

```sh
docker exec chat-web-observe-service node -e "require('http').get('http://127.0.0.1:5100/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"
docker logs --tail 50 chat-web-dispatch-service | grep 'Observe TCP'
```

Dispatch 启动后会调用一次 `observe.ping`，日志出现 `Observe TCP 已连通` 表示链路正常。

RabbitMQ 延迟队列验证：成功回执进入 `chat.observe.delivered.delay.*`，到期后投递到 `observe.delivered`，消费者不再等待。

```sh
docker logs --tail 100 chat-web-observe-service | grep '成功回执已进入延迟队列'
docker logs --tail 100 chat-web-observe-service | grep '送达回执已推送到 Hooks'
```
