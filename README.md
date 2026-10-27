# chat-web-observe-service

模拟发送服务。Dispatch 通过 TCP 调用 Observe，Observe 按 Dispatch 提交的参数读取 SRM 库做模拟发送。当前只打通 TCP 连接和响应（`observe.ping`），模拟发送接口后续接入。

| 项目          | 生产（Docker）                  | 本地开发                                    |
| ------------- | ------------------------------- | ------------------------------------------- |
| HTTP 端口     | `5100`（健康检查、Swagger）     | `5102`                                      |
| TCP 端口      | `5101`（只在 Docker 网络内）    | `5103`                                      |
| Nacos Data ID | `chat-web-observe-service.yaml` | `chat-web-observe-service-development.yaml` |
| 数据库配置键  | `database.chat-web-srm`（只读） | 同左                                        |

TCP 消息模式和请求/响应类型定义在 `@wlisfes/chat-web-base-schema/observe`，Dispatch 和 Observe 共用。

Dispatch 在 Nacos 中配置 `observe.host`、`observe.port`、`observe.timeout` 连接 Observe：Docker 内为 `chat-web-observe-service:5101`，本地开发为 `127.0.0.1:5103`。

本地启动前复制 `.env.example` 为 `.env` 并填写 Nacos 连接信息，然后执行 `yarn dev`。

生产部署由 main 分支流水线构建镜像并部署到 chat-home-server，详见 `deploy/RUNBOOK.md`。
