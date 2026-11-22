const READ_TIMEOUT_MS = 12_000;

// A live session can survive a short network failure during read-only startup.
export async function readDiaryStartup(read) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new DOMException('日記の利用準備が時間内に完了しませんでした。もう一度お試しください。', 'TimeoutError'));
    }, READ_TIMEOUT_MS);
    try {
      const result = await read(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      const transient = controller.signal.aborted || error instanceof TypeError
        || error.transportOutcomeUnknown || error.status === 408 || error.status >= 500;
      if (attempt > 0 || !transient) throw controller.signal.reason ?? error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
