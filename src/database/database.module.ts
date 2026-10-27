import { Global, Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { NacosService } from '@wlisfes/chat-web-base-schema/nacos'
import { createMysqlOptions, DataBaseService } from '@wlisfes/chat-web-base-schema/database'
import { OBSERVE_MYSQL_CONFIG_KEY, OBSERVE_MYSQL_ENTITIES } from '@/database/database.constants'

@Global()
@Module({
    imports: [
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService, NacosService],
            useFactory: async (configService: ConfigService, nacosService: NacosService) => {
                await nacosService.loadConfig()
                return createMysqlOptions(configService, {
                    configKey: OBSERVE_MYSQL_CONFIG_KEY,
                    entities: [...OBSERVE_MYSQL_ENTITIES],
                    decimalNumbers: true
                })
            }
        }),
        TypeOrmModule.forFeature([...OBSERVE_MYSQL_ENTITIES])
    ],
    providers: [DataBaseService],
    exports: [TypeOrmModule, DataBaseService]
})
export class DatabaseModule {}
