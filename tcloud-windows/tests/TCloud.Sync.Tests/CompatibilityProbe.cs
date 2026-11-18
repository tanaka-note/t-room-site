using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text.Json;
using TCloud.Sync.Windows;

/// <summary>Opt-in, synthetic files only. Office is never required by CI.</summary>
internal static class CompatibilityProbe
{
    public static void Run(bool includeOffice)
    {
        foreach (var denyDeletes in new[] { false, true })
        {
            using var fixture = CloudFilesFixture.Create(denyDeletes);
            foreach (var name in new[] { "delete.txt", "rename.txt", "write.txt", "replace.txt" })
            {
                fixture.Add(name, "original"u8);
                _ = File.ReadAllBytes(Path.Combine(fixture.Root, name));
            }
            string Argument(string name) => FixtureClient.PathArgument(Path.Combine(fixture.Root, name));
            var shell = ShellProbe.Read(Path.Combine(fixture.Root, "delete.txt"));
            var delete = FixtureClient.Run($"[System.IO.File]::Delete({Argument("delete.txt")})");
            var rename = FixtureClient.Run($"[System.IO.File]::Move({Argument("rename.txt")}, {Argument("renamed.txt")})");
            var write = FixtureClient.Run($"[System.IO.File]::WriteAllText({Argument("write.txt")}, 'edited')");
            File.WriteAllText(Path.Combine(fixture.Root, "replacement.txt"), "replacement");
            var replace = FixtureClient.Run($"[System.IO.File]::Replace({Argument("replacement.txt")}, {Argument("replace.txt")}, {Argument("backup.txt")})");
            Console.WriteLine(JsonSerializer.Serialize(new { denyDeletes, shell, delete, rename, write, replace,
                fixture.RejectedDeleteCount, providerErrors = fixture.Errors.Count }));
            if (includeOffice && denyDeletes) ProbeOffice(fixture);
            if (!fixture.Errors.IsEmpty) throw new InvalidOperationException("The synthetic provider reported callback errors.");
        }
    }

    private static OperationResult Attempt(Action action)
    {
        try { action(); return new OperationResult(true, null); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or COMException)
        { return new OperationResult(false, $"0x{error.HResult:X8}"); }
    }

    internal static void ProbeOffice(CloudFilesFixture fixture, string relativeDirectory = "")
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { ProbeExcel(fixture, relativeDirectory); }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null) ExceptionDispatchInfo.Capture(failure).Throw();
    }

    private static void ProbeExcel(CloudFilesFixture fixture, string relativeDirectory)
    {
        var type = Type.GetTypeFromProgID("Excel.Application")
            ?? throw new InvalidOperationException("Excel is not installed.");
        dynamic application = Activator.CreateInstance(type)
            ?? throw new InvalidOperationException("Excel could not be started.");
        object? workbooks = null;
        object? workbook = null;
        object? sheet = null;
        object? cell = null;
        try
        {
            application.Visible = false;
            application.DisplayAlerts = false;
            application.EnableEvents = false;
            application.AutomationSecurity = 3;
            workbooks = application.Workbooks;
            workbook = ((dynamic)workbooks).Add();
            sheet = ((dynamic)workbook).ActiveSheet;
            cell = ((dynamic)sheet).Range["A1"];
            ((dynamic)cell).Value2 = "original synthetic value";
            var directory = relativeDirectory.Length == 0 ? fixture.Root : Path.Combine(fixture.Root, relativeDirectory);
            var baseline = Path.Combine(directory, "baseline.xlsx");
            ((dynamic)workbook).SaveAs(baseline, 51);
            ((dynamic)workbook).Close(false);
            Release(cell); cell = null;
            Release(sheet); sheet = null;
            Release(workbook); workbook = null;

            fixture.Add("office.xlsx", File.ReadAllBytes(baseline), relativeDirectory);
            var path = Path.Combine(directory, "office.xlsx");
            _ = File.ReadAllBytes(path);
            workbook = ((dynamic)workbooks).Open(path, UpdateLinks: 0, ReadOnly: false, AddToMru: false);
            sheet = ((dynamic)workbook).ActiveSheet;
            cell = ((dynamic)sheet).Range["A1"];
            ((dynamic)cell).Value2 = "edited synthetic value";
            var rejectedBeforeSave = fixture.RejectedDeleteCount;
            var save = Attempt(() => ((dynamic)workbook).Save());
            var savedFlag = (bool)((dynamic)workbook).Saved;
            ((dynamic)workbook).Close(false);
            Release(cell); cell = null;
            Release(sheet); sheet = null;
            Release(workbook); workbook = null;

            workbook = ((dynamic)workbooks).Open(path, UpdateLinks: 0, ReadOnly: true, AddToMru: false);
            sheet = ((dynamic)workbook).ActiveSheet;
            cell = ((dynamic)sheet).Range["A1"];
            var valueVerified = string.Equals((string?)((dynamic)cell).Value2, "edited synthetic value", StringComparison.Ordinal);
            ((dynamic)workbook).Close(false);
            Release(cell); cell = null;
            Release(sheet); sheet = null;
            Release(workbook); workbook = null;
            var rejectedDuringSave = fixture.RejectedDeleteCount - rejectedBeforeSave;
            var savedBytes = File.ReadAllBytes(path);
            var copy = Path.Combine(directory, "saved-copy.xlsx");
            File.WriteAllBytes(copy, savedBytes);
            var deleteOrdinaryCopy = FixtureClient.Run($"[System.IO.File]::Delete({FixtureClient.PathArgument(copy)})");
            fixture.ConvertExisting(Path.GetRelativePath(fixture.Root, path));
            var deleteAfterConversion = FixtureClient.Run($"[System.IO.File]::Delete({FixtureClient.PathArgument(path)})");
            var contentPreserved = File.Exists(path) && File.ReadAllBytes(path).AsSpan().SequenceEqual(savedBytes);
            Console.WriteLine(JsonSerializer.Serialize(new { office = "Excel", save, savedFlag, valueVerified,
                rejectedDuringSave, deleteOrdinaryCopy, deleteAfterConversion, contentPreserved }));
            if (!save.Succeeded || !savedFlag || !valueVerified || deleteAfterConversion.Succeeded || !contentPreserved)
                throw new InvalidOperationException("The synthetic Excel edit was not verified after reopening.");
        }
        finally
        {
            try { if (workbook is not null) ((dynamic)workbook).Close(false); }
            finally
            {
                try { application.Quit(); }
                finally
                {
                    Release(cell); Release(sheet); Release(workbook); Release(workbooks); Release(application);
                }
            }
        }
    }

    private static void Release(object? value)
    {
        if (value is not null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
    }
}
