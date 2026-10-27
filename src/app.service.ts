import { Injectable, ServiceUnavailableException } from '@nestjs/common'
import * as HealthDto from '@/health/dto/health.dto'
import { HealthService } from '@/health/health.service'

@Injectable()
export class AppService {
    constructor(private readonly healthService: HealthService) {}

    /**模拟发送服务信息。*/
    public async httpBaseObserveResolverService(): Promise<string> {
        return 'Chat Web Observe Service'
    }

    /**模拟发送服务存活状态。*/
    public async httpBaseObserveLiveHealth(): Promise<HealthDto.ServiceLivenessResponseDto> {
        return this.healthService.getLiveness()
    }

    /**模拟发送服务就绪状态。*/
    public async httpBaseObserveReadyHealth(): Promise<HealthDto.ServiceReadinessResponseDto> {
        const result = await this.healthService.getReadiness()
        if (result.status !== 'UP') {
            throw new ServiceUnavailableException({ message: '模拟发送服务尚未就绪', data: result })
        }
        return result
    }
}
