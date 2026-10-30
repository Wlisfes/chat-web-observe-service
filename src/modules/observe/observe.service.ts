import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { OBSERVE_SERVICE_NAME } from '@/modules/observe/observe.constants'
import { ObserveSendLedger, type LedgerEntry } from '@/modules/observe/observe.ledger'
import { ObservePortQueue } from '@/modules/observe/observe.queue'
import { ObserveSubmitService } from '@/modules/observe/observe.submit'
import { ObserveDeliveredQueueService } from '@/modules/observe/observe.delivered.queue'
import * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'
import * as ObserveSchema from '@wlisfes/chat-web-base-schema/observe'
import * as ObserveSimulate from '@/modules/observe/observe.simulate'

/** 校验不通过时的结果码和说明。 */
type Rejection = { code: ObserveSchema.ObserveSubmitCode; message: string }

/** 已校验的提交参数。 */
interface SubmitTarget {
    msgId: string
    msgKeyId: number
    simbankKeyId: number
    portKeyId: number
    sendInterval: number
}

@Injectable()
export class ObserveService {
    private readonly logger = new Logger(ObserveService.name)
    /** 设备侧按短信ID记录的受理和发送状态：重复提交不重复发送，供 Dispatch 重投和超时检查前查询。 */
    private readonly ledger = new ObserveSendLedger()
    /** 按端口串行发送，同一端口两条短信之间间隔通道的发送间隔。 */
    private readonly queue = new ObservePortQueue((job, error) =>
        this.logger.error(`端口发送异常：msgId=${job.msgId}，原因=${error instanceof Error ? error.message : String(error)}`)
    )

    constructor(
        private readonly configService: ConfigService,
        @InjectRepository(SrmSchema.TbSrmSimbankMessage) private readonly messageRepository: Repository<SrmSchema.TbSrmSimbankMessage>,
        @InjectRepository(SrmSchema.TbSrmSimbank) private readonly simbankRepository: Repository<SrmSchema.TbSrmSimbank>,
        @InjectRepository(SrmSchema.TbSrmSimbankPort) private readonly portRepository: Repository<SrmSchema.TbSrmSimbankPort>,
        private readonly submitService?: ObserveSubmitService,
        private readonly deliveredQueueService?: ObserveDeliveredQueueService
    ) {}

    /** 连通性检查：原样返回调用方名称，附带 Observe 当前时间。 */
    public ping(payload: Partial<ObserveSchema.ObservePingPayload> | undefined): ObserveSchema.ObservePingResult {
        return {
            service: OBSERVE_SERVICE_NAME,
            from: typeof payload?.from === 'string' && payload.from.trim() ? payload.from.trim() : 'unknown',
            timestamp: new Date().toISOString()
        }
    }

    /**
     * 异步提交：校验发送条件后加入端口发送队列并立即返回受理结果，发送完成后通过 Hooks 推送回执。
     * 同一短信ID只受理一次，重复提交返回第一次的受理结果；端口队列已满时拒绝，Dispatch 换端口后可再次提交。
     */
    public async enqueue(payload: Partial<ObserveSchema.ObserveSubmitPayload> | undefined): Promise<ObserveSchema.ObserveEnqueueResult> {
        const msgId = text(payload?.msgId)
        // 缺少短信ID无法去重，直接按参数错误处理，不记入设备发送记录。
        if (!msgId) return this.admission(msgId, false, ObserveSchema.OBSERVE_SUBMIT_CODE.INVALID_PAYLOAD, '请求缺少 msgId')
        return this.ledger.admit(msgId, entry => this.admit(msgId, payload, entry))
    }

    /** 同步提交（兼容旧版 Dispatch）：受理后等待本条短信发送完成再返回结果。 */
    public async submit(payload: Partial<ObserveSchema.ObserveSubmitPayload> | undefined): Promise<ObserveSchema.ObserveSubmitResult> {
        const admission = await this.enqueue(payload)
        const entry = admission.msgId ? this.ledger.get(admission.msgId) : undefined
        if (entry && (admission.accepted || entry.result)) return entry.done
        return this.result(admission.msgId, 'failed', admission.statusCode, admission.statusMessage)
    }

    /** 按短信ID查询设备侧状态，立即返回：没有记录表示设备未收到过这条短信。 */
    public async query(payload: Partial<ObserveSchema.ObserveQueryPayload> | undefined): Promise<ObserveSchema.ObserveQueryResult> {
        const msgId = text(payload?.msgId)
        const entry = msgId ? this.ledger.get(msgId) : undefined
        if (!entry) return { msgId, found: false }
        // 受理还在校验中：等待受理结果，被拒绝或端口忙时按设备侧状态返回。
        await entry.admission.catch(() => undefined)
        const current = this.ledger.get(msgId)
        if (!current) return { msgId, found: false }
        const accepted = current.accepted === true
        return current.result
            ? { msgId, found: true, state: 'settled', accepted, result: current.result }
            : { msgId, found: true, state: current.state, accepted }
    }

    /** 校验发送条件并加入端口队列；同一短信ID只会执行一次。 */
    private async admit(
        msgId: string,
        payload: Partial<ObserveSchema.ObserveSubmitPayload> | undefined,
        entry: LedgerEntry
    ): Promise<{ admission: ObserveSchema.ObserveEnqueueResult; retryable?: boolean }> {
        const target = this.target(msgId, payload)
        const maxSize = this.queueMaxSize()
        if (target && this.queue.size(target.portKeyId) >= maxSize) return this.busy(msgId, target.portKeyId)
        const rejection = target
            ? await this.check(target)
            : { code: ObserveSchema.OBSERVE_SUBMIT_CODE.INVALID_PAYLOAD, message: INVALID_MESSAGE }
        if (rejection) {
            // 发送条件不满足：记为设备侧已有失败结果，重复提交和查询都返回同一结果。
            entry.resolve(this.result(msgId, 'failed', rejection.code, rejection.message))
            return { admission: this.admission(msgId, false, rejection.code, rejection.message) }
        }
        const queueSize = this.queue.push(
            target.portKeyId,
            { msgId, sendInterval: target.sendInterval, send: () => this.send(target, entry) },
            maxSize
        )
        if (queueSize === undefined) return this.busy(msgId, target.portKeyId)
        entry.accepted = true
        return { admission: { ...this.admission(msgId, true, ObserveSchema.OBSERVE_SUBMIT_CODE.QUEUED, '已进入端口发送队列'), queueSize } }
    }

    /** 端口队列中轮到本条短信：模拟设备耗时，写入设备侧结果并提交给 Hooks。 */
    private async send(target: SubmitTarget, entry: LedgerEntry): Promise<void> {
        entry.state = 'sending'
        const simulate = this.simulateOptions()
        await this.delay(simulate)
        const result =
            Math.random() < simulate.failureRate
                ? this.result(target.msgId, 'failed', ObserveSchema.OBSERVE_SUBMIT_CODE.SIMULATED_FAILURE, '模拟设备发送失败')
                : this.result(target.msgId, 'success', ObserveSchema.OBSERVE_SUBMIT_CODE.OK, '模拟设备发送成功')
        entry.resolve(result)
        const message = `模拟发送完成：msgId=${target.msgId}，msgKeyId=${target.msgKeyId}，portKeyId=${target.portKeyId}，sendStatus=${result.sendStatus}，statusCode=${result.statusCode}`
        if (result.sendStatus === 'success') this.logger.log(message)
        else this.logger.warn(message)
        const receipt = {
            ...result,
            msgKeyId: target.msgKeyId,
            simbankKeyId: target.simbankKeyId,
            portKeyId: target.portKeyId
        }
        // 成功回执立即推送；送达回执进入延迟队列。失败回执保持立即推送。
        if (this.deliveredQueueService) await this.deliveredQueueService.enqueueSuccess(receipt)
        else this.submitService?.submit(receipt)
    }

    private target(msgId: string, payload: Partial<ObserveSchema.ObserveSubmitPayload> | undefined): SubmitTarget | undefined {
        const msgKeyId = Number(payload?.msgKeyId)
        const simbankKeyId = Number(payload?.simbankKeyId)
        const portKeyId = Number(payload?.portKeyId)
        if (!msgId || ![msgKeyId, simbankKeyId, portKeyId].every(value => Number.isInteger(value) && value > 0)) return undefined
        const interval = Number(payload?.sendInterval ?? 0)
        const sendInterval = Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 0
        return { msgId, msgKeyId, simbankKeyId, portKeyId, sendInterval }
    }

    private busy(msgId: string, portKeyId: number): { admission: ObserveSchema.ObserveEnqueueResult; retryable: boolean } {
        return {
            admission: this.admission(
                msgId,
                false,
                ObserveSchema.OBSERVE_SUBMIT_CODE.PORT_BUSY,
                `端口发送队列已满：portKeyId=${portKeyId}`
            ),
            retryable: true
        }
    }

    /** 依次校验发送记录、设备和端口；全部通过返回 undefined。 */
    private async check({ msgId, msgKeyId, simbankKeyId, portKeyId }: SubmitTarget): Promise<Rejection | undefined> {
        const [message, simbank, port] = await Promise.all([
            this.messageRepository.findOne({
                where: { keyId: msgKeyId },
                select: { keyId: true, msgId: true, simbankKeyId: true, portKeyId: true }
            }),
            this.simbankRepository.findOne({ where: { keyId: simbankKeyId }, select: { keyId: true, status: true, online: true } }),
            this.portRepository.findOne({
                where: { keyId: portKeyId },
                select: { keyId: true, simbankKeyId: true, status: true, insertStatus: true, activateStatus: true, online: true }
            })
        ])
        if (!message || message.msgId !== msgId)
            return { code: ObserveSchema.OBSERVE_SUBMIT_CODE.MESSAGE_NOT_FOUND, message: '发送记录不存在或短信ID不匹配' }
        if (message.simbankKeyId !== simbankKeyId || message.portKeyId !== portKeyId) {
            return { code: ObserveSchema.OBSERVE_SUBMIT_CODE.MESSAGE_MISMATCH, message: '发送记录的设备或端口与请求不一致' }
        }
        if (!simbank) return { code: ObserveSchema.OBSERVE_SUBMIT_CODE.SIMBANK_NOT_FOUND, message: '设备不存在' }
        if (simbank.status !== SrmSchema.TbSrmSimbankStatus.ENABLE)
            return { code: ObserveSchema.OBSERVE_SUBMIT_CODE.SIMBANK_DISABLED, message: '设备已停用' }
        if (simbank.online !== SrmSchema.TbSrmSimbankOnline.ONLINE)
            return { code: ObserveSchema.OBSERVE_SUBMIT_CODE.SIMBANK_OFFLINE, message: '设备离线' }
        if (!port || port.simbankKeyId !== simbankKeyId)
            return { code: ObserveSchema.OBSERVE_SUBMIT_CODE.PORT_NOT_FOUND, message: '端口不存在或不属于该设备' }
        if (port.status !== SrmSchema.TbSrmSimbankPortStatus.ENABLE)
            return { code: ObserveSchema.OBSERVE_SUBMIT_CODE.PORT_DISABLED, message: '端口已停用' }
        if (port.insertStatus !== SrmSchema.TbSrmSimbankPortInsertStatus.INSERTED) {
            return { code: ObserveSchema.OBSERVE_SUBMIT_CODE.PORT_REMOVED, message: '端口未插卡' }
        }
        if (port.activateStatus !== SrmSchema.TbSrmSimbankPortActivateStatus.ACTIVE) {
            return { code: ObserveSchema.OBSERVE_SUBMIT_CODE.PORT_INACTIVE, message: '端口未激活' }
        }
        if (port.online !== SrmSchema.TbSrmSimbankPortOnline.ONLINE)
            return { code: ObserveSchema.OBSERVE_SUBMIT_CODE.PORT_OFFLINE, message: '端口离线' }
        return undefined
    }

    /** 每次读取最新配置，Nacos 修改 simulate 后无需重启。 */
    private simulateOptions(): ObserveSimulate.ObserveSimulateOptions {
        try {
            return ObserveSimulate.resolveObserveSimulateOptions(this.configService.get('simulate'))
        } catch (error) {
            this.logger.warn(`模拟发送配置无效，使用默认值：${error instanceof Error ? error.message : String(error)}`)
            return ObserveSimulate.resolveObserveSimulateOptions(undefined)
        }
    }

    /** 每次读取最新配置，Nacos 修改 queue.maxSize 后无需重启。 */
    private queueMaxSize(): number {
        try {
            return ObserveSimulate.resolveObservePortQueueMaxSize(this.configService.get('queue'))
        } catch (error) {
            this.logger.warn(`端口队列配置无效，使用默认值：${error instanceof Error ? error.message : String(error)}`)
            return ObserveSimulate.OBSERVE_PORT_QUEUE_DEFAULT_MAX_SIZE
        }
    }

    private async delay({ delayMin, delayMax }: ObserveSimulate.ObserveSimulateOptions): Promise<void> {
        const ms = delayMin + Math.floor(Math.random() * (delayMax - delayMin + 1))
        if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms))
    }

    private result(
        msgId: string,
        sendStatus: ObserveSchema.ObserveSubmitResult['sendStatus'],
        statusCode: ObserveSchema.ObserveSubmitCode,
        statusMessage: string
    ): ObserveSchema.ObserveSubmitResult {
        return { msgId, sendStatus, statusCode, statusMessage, sendTime: new Date().toISOString() }
    }

    private admission(
        msgId: string,
        accepted: boolean,
        statusCode: ObserveSchema.ObserveSubmitCode,
        statusMessage: string
    ): ObserveSchema.ObserveEnqueueResult {
        return { msgId, accepted, statusCode, statusMessage, time: new Date().toISOString() }
    }
}

const INVALID_MESSAGE = '请求缺少 msgId、msgKeyId、simbankKeyId 或 portKeyId'

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}
