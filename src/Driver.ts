import { NitroModules } from 'react-native-nitro-modules'
import type { NetDriver } from './Net.nitro'

export const Driver = NitroModules.createHybridObject<NetDriver>('NetDriver')
