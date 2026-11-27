using System.Text.Json;

namespace TCloud.Sync.Windows;

internal sealed record WindowsMetadataIntent(string ScopeHash,long RootFileId,string Kind,long Id,long ExpectedRevision,
    string Epoch,string RelativePath,long LocalFileId,JsonElement Request,bool Acknowledged=false,DateTimeOffset? DetectedAt=null);
