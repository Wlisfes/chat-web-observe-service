import { Get } from '@nestjs/common'
import { Public } from '@wlisfes/chat-web-base-schema/auth'
import { ApiServiceDecorator, ApifoxController } from '@wlisfes/chat-web-base-schema/decorator'
import { PreserveHttpStatus } from '@wlisfes/chat-web-base-schema/filters'
import { AppService } from '@/app.service'
import * as HealthDto from '@/health/dto/health.dto'

@ApifoxController('模拟发送服务-运行状态')
export class AppController {
    constructor(private readonly appService: AppService) {}

    @Public()
    @ApiServiceDecorator(Get(), {
        operation: { summary: '查看模拟发送服务信息' },
        response: { type: String, description: '模拟发送服务名称' }
    })
    public async httpBaseObserveResolverService(): Promise<string> {
        return this.appService.httpBaseObserveResolverService()
    }

    @Public()
    @ApiServiceDecorator(Get('health/live'), {
        operation: { summary: '模拟发送服务存活检查' },
        response: { type: HealthDto.ServiceLivenessResponseDto, description: '进程正常时返回 UP' }
    })
    public async httpBaseObserveLiveHealth(): Promise<HealthDto.ServiceLivenessResponseDto> {
        return this.appService.httpBaseObserveLiveHealth()
    }

    @Public()
    @ApiServiceDecorator(Get(['health', 'health/ready']), {
        operation: { summary: '模拟发送服务就绪检查' },
        response: { type: HealthDto.ServiceReadinessResponseDto, description: '数据库与鉴权配置状态' }
    })
    @PreserveHttpStatus()
    public async httpBaseObserveReadyHealth(): Promise<HealthDto.ServiceReadinessResponseDto> {
        return this.appService.httpBaseObserveReadyHealth()
    }
}
