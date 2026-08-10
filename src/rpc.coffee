# rpc.coffee — re-export brain's thin NDJSON-over-unix-socket client.
# tasks never opens pglite; every mutation is an RPC.
export { request, requestStream, serverRunning, noServerError } from 'brain/client'
export { paths, brainRoot, loadConfig, exists, storageDirs } from 'brain/config'
export { parseSlug, formatSlug, isSlug } from 'brain/slug'
