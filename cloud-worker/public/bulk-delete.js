/* Queue and results own IDs only. Permission, confirmation, API and UI stay in the host. */
(() => {
  async function run({ fileIds, folderIds }, { remove, onProgress, onFailure }) {
    const target = (type, id) => {
      if (typeof id !== "number" && typeof id !== "string") throw new TypeError("Deletion requires an ID");
      return Object.freeze({ type, id });
    };
    const queue = Object.freeze([
      ...folderIds.map(id => target("folder", id)),
      ...fileIds.map(id => target("file", id))
    ]);
    let next = 0, completed = 0, movedEntries = 0, processed = 0;
    const deletedFileIds = [], deletedFolderIds = [], failures = [];
    const worker = async () => {
      while (next < queue.length) {
        const task = queue[next++];
        try {
          const result = await remove(task);
          completed += 1;
          movedEntries += task.type === "folder" ? Number(result.deleted || 1) : 1;
          (task.type === "file" ? deletedFileIds : deletedFolderIds).push(task.id);
        } catch (error) {
          failures.push(Object.freeze({ target: task, error }));
          onFailure(task, error);
        }
        processed += 1;
        onProgress(Object.freeze({ processed, total: queue.length }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return Object.freeze({ completed, movedEntries, processed,
      deletedFileIds: Object.freeze(deletedFileIds), deletedFolderIds: Object.freeze(deletedFolderIds),
      failures: Object.freeze(failures) });
  }
  globalThis.TCloudBulkDelete = Object.freeze({ run });
})();
