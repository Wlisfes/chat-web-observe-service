const test = require('node:test')
const assert = require('node:assert/strict')
const { HealthService } = require('../dist/health/health.service')
const { AppService } = require('../dist/app.service')

test('存活检查返回 UP', async () => {
    const result = await new HealthService({ entityMetadatas: [] }).getLiveness()
    assert.equal(result.status, 'UP')
})

test('缺失 SRM 表时就绪检查返回 DOWN', async () => {
    const service = new HealthService({
        isInitialized: true,
        entityMetadatas: [{ tableName: 'tb_srm_simbank' }],
        async query() {
            return []
        }
    })
    const result = await service.getReadiness()
    assert.equal(result.status, 'DOWN')
    assert.deepEqual(result.database.missingTables, ['tb_srm_simbank'])
})

test('服务信息返回模拟发送服务名称', async () => {
    const service = new AppService({ getLiveness: async () => ({ status: 'UP' }) })
    assert.equal(await service.httpBaseObserveResolverService(), 'Chat Web Observe Service')
})
