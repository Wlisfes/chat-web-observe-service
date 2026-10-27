# Observe 部署变更记录

## 2026-10-27：新增模拟发送服务

- 影响机器：`chat-home-server`。
- 变更内容：新增 `chat-web-observe-service` 容器，HTTP `5100`、TCP `5101`；Dispatch 通过 TCP 调用 `observe.ping` 检查连通性。
- 机器侧操作：创建数据库账号 `chat_web_observe_service`，只读 `chat-web-srm` 的 `tb_srm_simbank_message`、`tb_srm_simbank`、`tb_srm_simbank_port`；创建 Nacos `chat-web-observe-service.yaml`；Dispatch 的 Nacos 增加 `observe` 节点。
- 验证命令：`yarn test`；部署后容器 `/health` 返回 200，Dispatch 日志出现 `Observe TCP 已连通`。
- 回滚方法：停止并删除 `chat-web-observe-service` 容器；Dispatch 连接失败只记录告警，不影响启动。

## 2026-10-27：新增模拟发送接口

- 变更内容：新增 TCP 消息 `observe.sms.submit`。Observe 按 Dispatch 提交的发送记录、设备、端口主键读取 SRM 库，校验设备在线启用、端口启用插卡激活在线后模拟设备耗时并返回结果；Dispatch 把结果写回发送记录。
- 机器侧操作：Nacos `chat-web-observe-service.yaml` 增加 `simulate` 节点（`delayMin`、`delayMax`、`failureRate`），修改后立即生效。
- 回滚方法：回退 Observe 与 Dispatch 镜像；已写回的发送结果保留。
