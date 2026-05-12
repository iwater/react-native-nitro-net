import * as net from './net'
import * as tls from './tls'
import * as http from './http'
import * as https from './https'
import { fetch } from './fetch'

export * from './net'
export {
    tls,
    http,
    https,
    fetch
}

export default {
    ...net,
    tls,
    http,
    https,
};
