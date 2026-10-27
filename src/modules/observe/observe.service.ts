import { Injectable } from '@nestjs/common'
import { ObservePingPayload, ObservePingResult } from '@wlisfes/chat-web-base-schema/observe'
import { OBSERVE_SERVICE_NAME } from '@/modules/observe/observe.constants'

@Injectable()
export class ObserveService {
    /** 连通性检查：原样返回调用方名称，附带 Observe 当前时间。 */
    public ping(payload: Partial<ObservePingPayload> | undefined): ObservePingResult {
        return {
            service: OBSERVE_SERVICE_NAME,
            from: typeof payload?.from === 'string' && payload.from.trim() ? payload.from.trim() : 'unknown',
            timestamp: new Date().toISOString()
        }
    }
}
