/* Pure listing decisions; callers provide filters instead of sharing UI state. */
(() => {
  function finalizeFiles(hydrated, preferences) {
    let result = [...hydrated];
    if (preferences.query) {
      result = result.filter((file) => matchesSearchFile(file, preferences.query, preferences.kind));
      result.sort((left, right) => compareSearchResults(left, right, preferences.query));
      return result;
    }
    if (preferences.kind) result = result.filter((file) => file.mediaKind === preferences.kind);
    const direction = preferences.sortDirection === "asc" ? 1 : -1;
    if (preferences.sortUsesTypeDefaults) result.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    else if (preferences.sort === "name") result.sort((a, b) => direction * a.name.localeCompare(b.name, "ja", { numeric: true, sensitivity: "base" }));
    else if (preferences.sort === "size") result.sort((a, b) => direction * (Number(a.sizeBytes || 0) - Number(b.sizeBytes || 0)) || a.name.localeCompare(b.name, "ja", { numeric: true, sensitivity: "base" }));
    else result.sort((a, b) => direction * String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    return result;
  }

  function compareSearchResults(left, right, query) {
    const depthDifference = Number(left?.searchDepth || 0) - Number(right?.searchDepth || 0);
    if (depthDifference) return depthDifference;
    const rankDifference = searchNameMatchRank(left?.name, query) - searchNameMatchRank(right?.name, query);
    if (rankDifference) return rankDifference;
    return String(left?.name || "").localeCompare(String(right?.name || ""), "ja", { numeric: true, sensitivity: "base" });
  }

  function matchesSearchFolder(folder, query) {
    if (!query) return true;
    return String(folder?.name || "").toLocaleLowerCase("ja").includes(query.toLocaleLowerCase("ja"));
  }

  function matchesSearchFile(file, query, kind) {
    if (query && !String(file?.name || "").toLocaleLowerCase("ja").includes(query.toLocaleLowerCase("ja"))) return false;
    return !kind || file?.mediaKind === kind;
  }

  function searchNameMatchRank(name, query) {
    const normalizedName = String(name || "").trim().toLocaleLowerCase("ja");
    const normalizedQuery = String(query || "").trim().toLocaleLowerCase("ja");
    if (!normalizedQuery) return 0;
    if (normalizedName === normalizedQuery) return 0;
    if (normalizedName.startsWith(normalizedQuery)) return 1;
    if (normalizedName.includes(normalizedQuery)) return 2;
    return 3;
  }

  function normalizeFolderSelection(records, explicitDirectories = new Set()) {
    const directories = new Set([...explicitDirectories].map(normalizeRelativePath).filter(Boolean));
    const files = [];
    for (const record of records) {
      const relativePath = normalizeRelativePath(record.relativePath || record.file?.name);
      if (!record.file || !relativePath) continue;
      const parts = relativePath.split("/");
      if (parts.length < 2) continue;
      files.push({ file: record.file, relativePath });
      for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join("/"));
    }
    const roots = [...directories].filter((path) => !path.includes("/")).sort((a, b) => a.localeCompare(b, "ja"));
    if (!roots.length) throw new Error("アップロードするフォルダを確認してください。");
    return { files, directories: [...directories].sort(compareFolderPaths), roots };
  }

  function normalizeRelativePath(value) {
    return String(value || "").replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/");
  }

  function compareFolderPaths(left, right) {
    const depth = left.split("/").length - right.split("/").length;
    return depth || left.localeCompare(right, "ja");
  }

  function mergeFolderSelections(current, incoming) {
    if (!current) return incoming;
    const directories = new Set([...current.directories, ...incoming.directories]);
    const files = new Map();
    for (const record of [...current.files, ...incoming.files]) {
      const file = record.file;
      const identity = [record.relativePath, Number(file?.size || 0), Number(file?.lastModified || 0)].join("\u0000");
      if (!files.has(identity)) files.set(identity, record);
    }
    const merged = normalizeFolderSelection([...files.values()], directories);
    const looseFiles = new Map();
    for (const file of [...(current.looseFiles || []), ...(incoming.looseFiles || [])]) {
      const identity = [file.name, Number(file.size || 0), Number(file.lastModified || 0)].join("\u0000");
      if (!looseFiles.has(identity)) looseFiles.set(identity, file);
    }
    merged.looseFiles = [...looseFiles.values()];
    return merged;
  }

  globalThis.TCloudListing = Object.freeze({ finalizeFiles, compareSearchResults, matchesSearchFolder, matchesSearchFile, searchNameMatchRank, normalizeFolderSelection, normalizeRelativePath, compareFolderPaths, mergeFolderSelections });
})();
