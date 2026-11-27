// Reuse of RNNoise worklet nodes per AudioContext. The library's destroy() never
// reaches its processor (the processor's port is never started), so a retired
// node keeps its WASM instance for as long as its context lives, and a renderer
// runs out of WASM memory after about 124 of them. Handing a stopped chain's node
// to the next chain bounds the live instances by the chains that exist at once.
// No browser imports, so node:test can drive it.

// createNode(context) -> Promise<node>. Nodes are kept per context in a WeakMap,
// so a replaced or closed context takes its nodes with it.
export function createRnnoiseNodePool(createNode) {
  const idleByContext = new WeakMap()

  return {
    // An idle node of that context, else a new one. The node leaves the idle
    // list before it is returned, so two chains never hold the same node. A
    // failed createNode rejects and leaves the pool as it was.
    async acquire(context) {
      const idle = idleByContext.get(context)
      if (idle && idle.length > 0) return idle.pop()
      return createNode(context)
    },

    // Detach the node and keep it for the next acquire on that context. A node
    // of a closed context is dropped, and a node already idle is not added twice
    // (a chain's stop() may run twice).
    release(context, node) {
      let idle = idleByContext.get(context)
      if (idle?.includes(node)) return
      try {
        node.disconnect()
      } catch {
        // Already disconnected, or its context is gone.
      }
      if (context.state === 'closed') return
      if (!idle) {
        idle = []
        idleByContext.set(context, idle)
      }
      idle.push(node)
    }
  }
}
