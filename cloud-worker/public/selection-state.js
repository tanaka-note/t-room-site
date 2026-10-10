/* Selection owns IDs only. Permissions, keys, DOM and operations stay in the host. */
(() => {
  function create() {
    const files = new Set(), folders = new Set();
    const items = kind => {
      if (kind === "file") return files;
      if (kind === "folder") return folders;
      throw new TypeError("Unknown selection kind");
    };
    const checkId = id => {
      if (typeof id !== "number" && typeof id !== "string") throw new TypeError("Selection requires an ID");
      return id;
    };
    return Object.freeze({
      count: kind => items(kind).size,
      has: (kind, id) => items(kind).has(id),
      add: (kind, id) => { items(kind).add(checkId(id)); },
      remove: (kind, id) => { items(kind).delete(id); },
      replace: (kind, ids) => {
        const next = Array.from(ids, checkId), target = items(kind);
        target.clear(); for (const id of next) target.add(id);
      },
      clear: () => { files.clear(); folders.clear(); },
      snapshot: () => Object.freeze({ fileIds: Object.freeze([...files]), folderIds: Object.freeze([...folders]) })
    });
  }
  globalThis.TCloudSelection = Object.freeze({ create });
})();
