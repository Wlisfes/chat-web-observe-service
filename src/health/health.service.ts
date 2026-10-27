import { Injectable } from '@nestjs/common'
import { InjectDataSource, DataSource } from '@wlisfes/chat-web-base-schema/database'
import * as HealthDto from '@/health/dto/health.dto'

type TableRow = { tableName: string }

@Injectable()
export class HealthService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /**模拟发送服务存活状态。*/
    public async getLiveness(): Promise<HealthDto.ServiceLivenessResponseDto> {
        return { status: 'UP', timestamp: new Date().toISOString() }
    }

    /**模拟发送服务就绪状态：检查 SRM 库连接和需要读取的表。*/
    public async getReadiness(): Promise<HealthDto.ServiceReadinessResponseDto> {
        const requiredTables = [...new Set(this.dataSource.entityMetadatas.map(metadata => metadata.tableName))].sort()
        let databaseReady = false
        let database: HealthDto.ServiceDependencyResponseDto
        try {
            if (requiredTables.length === 0) {
                await this.dataSource.query('SELECT 1')
                databaseReady = this.dataSource.isInitialized
                database = { connected: this.dataSource.isInitialized, requiredTableCount: 0, missingTables: [] }
            } else {
                const rows = (await this.dataSource.query(
                    `SELECT table_name AS tableName FROM information_schema.tables
                     WHERE table_schema = DATABASE() AND table_name IN (${requiredTables.map(() => '?').join(', ')})`,
                    requiredTables
                )) as TableRow[]
                const existing = new Set(rows.map(row => row.tableName))
                const missingTables = requiredTables.filter(table => !existing.has(table))
                databaseReady = this.dataSource.isInitialized && missingTables.length === 0
                database = { connected: this.dataSource.isInitialized, requiredTableCount: requiredTables.length, missingTables }
            }
        } catch (error) {
            database = { connected: false, error: error instanceof Error ? error.message : String(error) }
        }
        return {
            status: databaseReady ? 'UP' : 'DOWN',
            database,
            auth: { mode: 'gateway-principal' },
            timestamp: new Date().toISOString()
        }
    }
}
