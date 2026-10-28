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

## 2026-10-28：按端口排队发送、异步回执

- 变更内容：新增 TCP 消息 `observe.sms.enqueue`：校验发送条件后进入端口发送队列立即返回受理结果；每个端口串行发送，相邻两条间隔通道 `sendInterval`；端口队列已满返回 `PORT_BUSY`。发送完成后 HTTP 推送回执到 Hooks（HMAC 签名，失败退避重试），Observe 不写库。`observe.sms.query` 立即返回 `queued`、`sending`、`settled` 状态。旧的同步 `observe.sms.submit` 保留兼容。
- 机器侧操作：Nacos `chat-web-observe-service.yaml` 增加 `hooks.url: http://chat-web-hooks-service:5110/observe/receipt`、`hooks.secret`（与 Hooks `simbank.secret` 一致），可选 `queue.maxSize`（默认 100）。修改后立即生效。
- 回滚方法：回退 Observe 镜像前先回退 Dispatch。
