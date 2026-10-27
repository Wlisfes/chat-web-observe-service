import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'
import {
    OBSERVE_SUBMIT_CODE,
    type ObservePingPayload,
    type ObservePingResult,
    type ObserveSubmitCode,
    type ObserveSubmitPayload,
    type ObserveSubmitResult
} from '@wlisfes/chat-web-base-schema/observe'
import { OBSERVE_SERVICE_NAME } from '@/modules/observe/observe.constants'
import { resolveObserveSimulateOptions, type ObserveSimulateOptions } from '@/modules/observe/observe.simulate'

/** 校验不通过时的结果码和说明。 */
type Rejection = { code: ObserveSubmitCode; message: string }

@Injectable()
export class ObserveService {
    private readonly logger = new Logger(ObserveService.name)

    constructor(
        private readonly configService: ConfigService,
        @InjectRepository(SrmSchema.TbSrmSimbankMessage) private readonly messageRepository: Repository<SrmSchema.TbSrmSimbankMessage>,
        @InjectRepository(SrmSchema.TbSrmSimbank) private readonly simbankRepository: Repository<SrmSchema.TbSrmSimbank>,
        @InjectRepository(SrmSchema.TbSrmSimbankPort) private readonly portRepository: Repository<SrmSchema.TbSrmSimbankPort>
    ) {}

    /** 连通性检查：原样返回调用方名称，附带 Observe 当前时间。 */
    public ping(payload: Partial<ObservePingPayload> | undefined): ObservePingResult {
        return {
            service: OBSERVE_SERVICE_NAME,
            from: typeof payload?.from === 'string' && payload.from.trim() ? payload.from.trim() : 'unknown',
            timestamp: new Date().toISOString()
        }
    }

    /**
     * 模拟设备发送：按 Dispatch 提交的主键读取 SRM 发送记录、设备和端口，校验发送条件后模拟设备耗时并返回结果。
     * Observe 只读 SRM 库，发送结果由 Dispatch 写回发送记录。
     */
    public async submit(payload: Partial<ObserveSubmitPayload> | undefined): Promise<ObserveSubmitResult> {
        const msgId = typeof payload?.msgId === 'string' ? payload.msgId.trim() : ''
        const rejection = await this.check(msgId, payload)
        if (rejection) return this.result(msgId, 'failed', rejection.code, rejection.message)
        const simulate = this.simulateOptions()
        await this.delay(simulate)
        if (Math.random() < simulate.failureRate) {
            return this.result(msgId, 'failed', OBSERVE_SUBMIT_CODE.SIMULATED_FAILURE, '模拟设备发送失败')
        }
        return this.result(msgId, 'success', OBSERVE_SUBMIT_CODE.OK, '模拟设备发送成功')
    }

    /** 依次校验发送记录、设备和端口；全部通过返回 undefined。 */
    private async check(msgId: string, payload: Partial<ObserveSubmitPayload> | undefined): Promise<Rejection | undefined> {
        const msgKeyId = Number(payload?.msgKeyId)
        const simbankKeyId = Number(payload?.simbankKeyId)
        const portKeyId = Number(payload?.portKeyId)
        if (!msgId || ![msgKeyId, simbankKeyId, portKeyId].every(value => Number.isInteger(value) && value > 0)) {
            return { code: OBSERVE_SUBMIT_CODE.INVALID_PAYLOAD, message: '请求缺少 msgId、msgKeyId、simbankKeyId 或 portKeyId' }
        }
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
            return { code: OBSERVE_SUBMIT_CODE.MESSAGE_NOT_FOUND, message: '发送记录不存在或短信ID不匹配' }
        if (message.simbankKeyId !== simbankKeyId || message.portKeyId !== portKeyId) {
            return { code: OBSERVE_SUBMIT_CODE.MESSAGE_MISMATCH, message: '发送记录的设备或端口与请求不一致' }
        }
        if (!simbank) return { code: OBSERVE_SUBMIT_CODE.SIMBANK_NOT_FOUND, message: '设备不存在' }
        if (simbank.status !== SrmSchema.TbSrmSimbankStatus.ENABLE)
            return { code: OBSERVE_SUBMIT_CODE.SIMBANK_DISABLED, message: '设备已停用' }
        if (simbank.online !== SrmSchema.TbSrmSimbankOnline.ONLINE)
            return { code: OBSERVE_SUBMIT_CODE.SIMBANK_OFFLINE, message: '设备离线' }
        if (!port || port.simbankKeyId !== simbankKeyId)
            return { code: OBSERVE_SUBMIT_CODE.PORT_NOT_FOUND, message: '端口不存在或不属于该设备' }
        if (port.status !== SrmSchema.TbSrmSimbankPortStatus.ENABLE)
            return { code: OBSERVE_SUBMIT_CODE.PORT_DISABLED, message: '端口已停用' }
        if (port.insertStatus !== SrmSchema.TbSrmSimbankPortInsertStatus.INSERTED) {
            return { code: OBSERVE_SUBMIT_CODE.PORT_REMOVED, message: '端口未插卡' }
        }
        if (port.activateStatus !== SrmSchema.TbSrmSimbankPortActivateStatus.ACTIVE) {
            return { code: OBSERVE_SUBMIT_CODE.PORT_INACTIVE, message: '端口未激活' }
        }
        if (port.online !== SrmSchema.TbSrmSimbankPortOnline.ONLINE) return { code: OBSERVE_SUBMIT_CODE.PORT_OFFLINE, message: '端口离线' }
        return undefined
    }

    /** 每次读取最新配置，Nacos 修改 simulate 后无需重启。 */
    private simulateOptions(): ObserveSimulateOptions {
        try {
            return resolveObserveSimulateOptions(this.configService.get('simulate'))
        } catch (error) {
            this.logger.warn(`模拟发送配置无效，使用默认值：${error instanceof Error ? error.message : String(error)}`)
            return resolveObserveSimulateOptions(undefined)
        }
    }

    private async delay({ delayMin, delayMax }: ObserveSimulateOptions): Promise<void> {
        const ms = delayMin + Math.floor(Math.random() * (delayMax - delayMin + 1))
        if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms))
    }

    private result(
        msgId: string,
        sendStatus: ObserveSubmitResult['sendStatus'],
        statusCode: ObserveSubmitCode,
        statusMessage: string
    ): ObserveSubmitResult {
        return { msgId, sendStatus, statusCode, statusMessage, sendTime: new Date().toISOString() }
    }
}
