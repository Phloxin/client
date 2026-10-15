// Runs a copy of the E2EE worker in a Node worker thread (see harness.mjs): `self` is the
// global, and messages go through parentPort. Like a browser worker, messages wait until the
// script sets onmessage.
import { parentPort, workerData } from 'node:worker_threads'

const queued = []
globalThis.self = globalThis
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer)
parentPort.on('message', (data) => {
  if (globalThis.onmessage) globalThis.onmessage({ data })
  else queued.push(data)
})
await import(workerData.worker)
for (const data of queued.splice(0)) globalThis.onmessage?.({ data })
