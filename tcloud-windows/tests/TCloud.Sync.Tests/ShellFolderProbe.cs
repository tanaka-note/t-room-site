using System.Diagnostics;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;
using TCloud.Sync.Windows;

/// <summary>The parent owns cleanup even when the native Shell probe child fails.</summary>
public static class ShellFolderProbe
{
    private const string ClassId = "{b5d30db5-7fb2-438c-80e2-00f5d027891c}";

    public static void Run(bool useClassSuffix = false, bool includeOffice = false, bool holdForUi = false, bool hostView = false)
    {
        using var mutex = new Mutex(false, "Local\\TCloud.ShellProbe");
        if (!mutex.WaitOne(0)) throw new InvalidOperationException("Another synthetic Shell probe is running.");
        try { RunOwned(useClassSuffix, includeOffice, holdForUi, hostView); }
        finally { mutex.ReleaseMutex(); }
    }

    private static void RunOwned(bool useClassSuffix, bool includeOffice, bool holdForUi, bool hostView)
    {
        var serverPath = NativeServerPath();
        using var fixture = CloudFilesFixture.Create(denyDeletes: true);
        var viewPath = Path.Combine(fixture.Root, useClassSuffix ? "view." + ClassId : "view");
        Directory.CreateDirectory(viewPath);
        var path = Path.Combine(viewPath, "probe.txt");
        var relativeView = Path.GetFileName(viewPath);
        fixture.Add("probe.txt", "synthetic"u8, relativeView);
        fixture.Add("probe.txt", "synthetic"u8, Path.Combine(relativeView, "nested", "deeper"));
        File.WriteAllText(Path.Combine(viewPath, "new.txt"), "synthetic");
        _ = File.ReadAllText(path);
        var originalAttributes = File.GetAttributes(viewPath);
        var registryPath = @"Software\Classes\CLSID\" + ClassId;
        // Elevated COM clients ignore per-user classes. Use an equally temporary
        // machine registration only when this process already has administrator rights.
        // Never prompt for elevation or replace an existing registration in either hive.
        using var identity = WindowsIdentity.GetCurrent();
        var elevated = new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        var registry = elevated ? Registry.LocalMachine : Registry.CurrentUser;
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using var existing = hive.OpenSubKey(registryPath);
            if (existing is not null) throw new InvalidOperationException("The synthetic class is already registered.");
        }
        var registered = false;
        try
        {
            using (var key = registry.CreateSubKey(registryPath))
            {
                registered = true;
                key.SetValue("", "T-Cloud synthetic folder probe");
                using var server = key.CreateSubKey("InProcServer32");
                server.SetValue("", serverPath);
                server.SetValue("ThreadingModel", "Apartment");
                using var shell = key.CreateSubKey("ShellFolder");
                shell.SetValue("Attributes", unchecked((int)0xE0000011), RegistryValueKind.DWord);
            }
            var desktopIni = Path.Combine(viewPath, "desktop.ini");
            File.WriteAllText(desktopIni, "[.ShellClassInfo]\r\nCLSID=" + ClassId + "\r\nCLSID2=" + ClassId + "\r\n", Encoding.Unicode);
            File.SetAttributes(desktopIni, FileAttributes.Hidden | FileAttributes.System);
            File.SetAttributes(viewPath, originalAttributes | FileAttributes.ReadOnly | FileAttributes.System);
            foreach (var inspectedPath in new[] { path, Path.Combine(viewPath, "new.txt"), Path.Combine(viewPath, "nested", "deeper", "probe.txt") })
            {
                var result = RunClient(inspectedPath);
                Console.WriteLine(JsonSerializer.Serialize(new { useClassSuffix, elevated, relativePath = Path.GetRelativePath(viewPath, inspectedPath), result }));
                if (result.CanDelete || result.HasDeleteCommand || !result.CanRename)
                    throw new InvalidOperationException("The native folder did not meet the Shell capability requirements.");
            }
            if (includeOffice) CompatibilityProbe.ProbeOffice(fixture, relativeView);
            if (hostView)
            {
                var hostStart = new ProcessStartInfo(Path.Combine(Path.GetDirectoryName(serverPath)!, "TCloud.ShellViewHost.exe"))
                { UseShellExecute = false };
                hostStart.ArgumentList.Add(viewPath);
                using var host = Process.Start(hostStart) ?? throw new InvalidOperationException("Could not start the isolated Shell view host.");
                Console.WriteLine(JsonSerializer.Serialize(new { viewPath, hostProcessId = host.Id }));
                if (!host.WaitForExit(180000))
                {
                    host.Kill(entireProcessTree: true);
                    host.WaitForExit();
                    throw new TimeoutException("The isolated Shell view host did not complete.");
                }
                if (host.ExitCode != 0)
                    throw new InvalidOperationException($"The isolated Shell view host failed with 0x{host.ExitCode:X8}.");
            }
            if (holdForUi)
            {
                Console.WriteLine(JsonSerializer.Serialize(new { viewPath, readyForUi = true }));
                _ = Console.ReadLine();
            }
        }
        finally
        {
            try { File.SetAttributes(viewPath, originalAttributes); }
            finally { if (registered) registry.DeleteSubKeyTree(registryPath, throwOnMissingSubKey: true); }
        }
    }

    private static ShellCapabilities RunClient(string path)
    {
        var start = new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "TCloud.Sync.Tests.exe"))
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            start.ArgumentList.Add("--inspect-shell-path");
            start.ArgumentList.Add(path);
            using var child = Process.Start(start) ?? throw new InvalidOperationException("Could not start the isolated Shell client.");
            var output = child.StandardOutput.ReadToEndAsync();
            var errors = child.StandardError.ReadToEndAsync();
            if (!child.WaitForExit(30000))
            {
                child.Kill(entireProcessTree: true);
                child.WaitForExit();
                throw new TimeoutException("The isolated Shell client did not complete.");
            }
            _ = errors.GetAwaiter().GetResult();
            if (child.ExitCode != 0)
                throw new InvalidOperationException($"The isolated Shell client failed with 0x{child.ExitCode:X8}.");
            return JsonSerializer.Deserialize<ShellCapabilities>(output.GetAwaiter().GetResult())
                ?? throw new InvalidDataException("The isolated Shell client returned an invalid result.");
    }

    public static void InspectPath(string path)
    {
        var fullPath = Path.GetFullPath(path);
        var view = Directory.GetParent(fullPath) ?? throw new ArgumentException("Missing view folder.");
        var root = view;
        while (root.Parent is not null && !root.Name.StartsWith("tcloud-cfapi-", StringComparison.Ordinal))
        {
            if (root.LinkTarget is not null) throw new ArgumentException("The Shell client cannot traverse links.");
            root = root.Parent;
        }
        var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())) + Path.DirectorySeparatorChar;
        if (!root.FullName.StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase)
            || !root.Name.StartsWith("tcloud-cfapi-", StringComparison.Ordinal) || root.LinkTarget is not null
            || root.Parent?.FullName != Path.TrimEndingDirectorySeparator(temporaryRoot)
            || new FileInfo(fullPath).LinkTarget is not null || Path.GetFileName(fullPath) is not ("probe.txt" or "new.txt")
            || File.ReadAllText(fullPath) != "synthetic")
            throw new ArgumentException("The Shell client requires an owned synthetic file.");
        Console.WriteLine(JsonSerializer.Serialize(ShellProbe.Read(fullPath)));
    }

    private static string NativeServerPath()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (!File.Exists(Path.Combine(directory.FullName, "tcloud-windows", "TCloud.Sync.slnx"))) continue;
            var artifacts = Path.Combine(directory.FullName, "tcloud-windows", "artifacts", "native-shell");
            using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(artifacts, "active.json")));
            var buildId = manifest.RootElement.GetProperty("buildId").GetString();
            if (buildId is null || buildId.Length != 64 || buildId.Any(ch => !char.IsAsciiHexDigit(ch)))
                throw new InvalidDataException("Invalid native probe build identifier.");
            var path = Path.Combine(artifacts, buildId, "TCloud.ShellProbe.dll");
            if (!File.Exists(path)) throw new FileNotFoundException("Build the native Shell probe first.");
            return path;
        }
        throw new DirectoryNotFoundException("Repository root not found.");
    }
}
