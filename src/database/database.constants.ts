import * as SrmSchema from '@wlisfes/chat-web-base-schema/chat-web-srm-mysql'

/** Observe 只读 SRM 库，按 Dispatch 提交的参数查询发送记录、设备和端口。 */
export const OBSERVE_MYSQL_CONFIG_KEY = 'database.chat-web-srm'

/** 表都由 SRM 拥有，Observe 不建表。 */
export const OBSERVE_MYSQL_ENTITIES = [SrmSchema.TbSrmSimbankMessage, SrmSchema.TbSrmSimbank, SrmSchema.TbSrmSimbankPort] as const
