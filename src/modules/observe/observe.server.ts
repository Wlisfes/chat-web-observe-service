import type { Socket } from 'node:net'
import { ServerTCP } from '@nestjs/microservices'

/** 对端进程退出、重启或断网时 socket 报这些错误，属于正常断线，不按 ERROR 记录。 */
const PEER_DISCONNECT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT'])

/**
 * Observe TCP 服务端。
 * Nest 默认把客户端断线（ECONNRESET）也包装成 InvalidTcpDataReceptionException 按 ERROR 输出，Dispatch 每次重启都会刷一条错误堆栈。
 * 这里在 Nest 处理前识别对端断线，只记一条告警并跳过随后的包装异常；其他 socket 错误仍按 Nest 默认处理。
 */
export class ObserveTcpServer extends ServerTCP {
    private suppressNextError = false

    public bindHandler(socket: Socket): void {
        // 断线后 remoteAddress 会被清空，连接建立时先记下来。
        const peer = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? ''}`
        socket.on('error', (error: NodeJS.ErrnoException) => {
            if (!error?.code || !PEER_DISCONNECT_CODES.has(error.code)) return
            this.suppressNextError = true
            this.logger.warn(`TCP 客户端连接已断开：${peer}，code=${error.code}`)
        })
        super.bindHandler(socket)
    }

    protected handleError(error: string): void {
        if (this.suppressNextError) {
            this.suppressNextError = false
            return
        }
        super.handleError(error)
    }
}
