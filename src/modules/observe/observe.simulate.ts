/** 模拟发送参数：Nacos `simulate` 节点，未配置时使用默认值。 */
export interface ObserveSimulateOptions {
    /** 模拟设备发送耗时下限，毫秒。 */
    delayMin: number
    /** 模拟设备发送耗时上限，毫秒。 */
    delayMax: number
    /** 随机失败比例：0-1，0 表示全部成功。 */
    failureRate: number
}

export const OBSERVE_SIMULATE_DEFAULTS: ObserveSimulateOptions = { delayMin: 100, delayMax: 500, failureRate: 0 }

/** 解析 Nacos `simulate` 节点，非法值直接报错，避免配置写错后悄悄按默认值运行。 */
export function resolveObserveSimulateOptions(config: unknown): ObserveSimulateOptions {
    const record = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {}
    const delayMin = Number(record.delayMin ?? OBSERVE_SIMULATE_DEFAULTS.delayMin)
    const delayMax = Number(record.delayMax ?? OBSERVE_SIMULATE_DEFAULTS.delayMax)
    const failureRate = Number(record.failureRate ?? OBSERVE_SIMULATE_DEFAULTS.failureRate)
    if (!Number.isInteger(delayMin) || delayMin < 0) throw new Error('Nacos simulate.delayMin 必须是不小于 0 的整数毫秒数')
    if (!Number.isInteger(delayMax) || delayMax < delayMin) throw new Error('Nacos simulate.delayMax 必须是不小于 delayMin 的整数毫秒数')
    if (!Number.isFinite(failureRate) || failureRate < 0 || failureRate > 1) throw new Error('Nacos simulate.failureRate 必须在 0-1 之间')
    return { delayMin, delayMax, failureRate }
}
