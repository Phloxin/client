// Serialize async operations while keeping the queue usable after a rejection.
// Each caller still receives its own operation's original result or error.
export function createSerialQueue() {
  let tail = Promise.resolve()

  return (operation) => {
    const result = tail.then(operation, operation)
    tail = result.catch(() => {})
    return result
  }
}
