/** 容器内 TCP 默认端口；HTTP 健康检查和 Swagger 使用 5100。 */
export const OBSERVE_TCP_DEFAULT_PORT = 5101
/** 容器内默认监听所有网卡，Dispatch 通过 Docker 网络访问 chat-web-observe-service:5101。 */
export const OBSERVE_TCP_DEFAULT_HOST = '0.0.0.0'
/** 服务名称：ping 响应中返回，便于调用方确认连到了 Observe。 */
export const OBSERVE_SERVICE_NAME = 'chat-web-observe-service'

export interface ObserveTcpOptions {
    host: string
    port: number
}

/**
 * 解析 TCP 监听地址：环境变量 OBSERVE_TCP_PORT/OBSERVE_TCP_HOST 优先，其次 Nacos `tcp` 节点，最后使用默认值。
 * 本地开发与 Docker 容器可能同时运行，本地 .env 使用不同端口避免冲突。
 */
export function resolveObserveTcpOptions(config: unknown, environment: NodeJS.ProcessEnv = process.env): ObserveTcpOptions {
    const record = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {}
    const host = text(environment.OBSERVE_TCP_HOST) ?? text(record.host) ?? OBSERVE_TCP_DEFAULT_HOST
    const port = Number(text(environment.OBSERVE_TCP_PORT) ?? record.port ?? OBSERVE_TCP_DEFAULT_PORT)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Observe TCP 端口必须是 1-65535 之间的整数')
    return { host, port }
}

function text(value: unknown): string | undefined {
    if (typeof value === 'number') return String(value)
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
