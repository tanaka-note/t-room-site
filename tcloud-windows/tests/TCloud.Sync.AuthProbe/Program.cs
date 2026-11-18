using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using TCloud.Sync.Windows;

namespace TCloud.Sync.AuthProbe;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new ProbeForm());
    }
}

/// <summary>Opt-in compatibility tool, not the production login UI. No network until a human starts it.</summary>
internal sealed class ProbeForm : Form
{
    private readonly Button start = new() { Text = "パスキーで確認", Dock = DockStyle.Top, Height = 44 };
    private readonly ComboBox mode = new() { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Top, Height = 34 };
    private readonly Label status = new() { Dock = DockStyle.Fill, AutoSize = false, Padding = new(0, 16, 0, 0), Text = "認証と端末内復号の互換性を確認します。" };
    private CancellationTokenSource? cancellation;
    private bool closing;

    public ProbeForm()
    {
        Text = "T-Cloud 認証の互換性確認";
        ClientSize = new(500, 360);
        MinimumSize = MaximumSize = Size;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(244, 246, 243);
        ForeColor = Color.FromArgb(41, 56, 49);
        Font = new("Yu Gothic UI", 10);
        var card = new Panel { BackColor = Color.White, Size = new(440, 300), Location = new(30, 30), Padding = new(36) };
        var title = new Label { Text = "T-Cloud", Font = new(Font.FontFamily, 20, FontStyle.Bold), Dock = DockStyle.Top, Height = 48 };
        var instruction = new Label { Text = "パスキーを使ってログインしてください。", Dock = DockStyle.Top, Height = 38 };
        mode.Items.AddRange(["通常利用", "管理者として利用"]);
        mode.SelectedIndex = 0;
        start.BackColor = Color.FromArgb(87, 114, 99);
        start.ForeColor = Color.White;
        start.FlatStyle = FlatStyle.Flat;
        start.FlatAppearance.BorderSize = 0;
        card.Controls.Add(status); card.Controls.Add(start); card.Controls.Add(mode); card.Controls.Add(instruction); card.Controls.Add(title);
        Controls.Add(card);
        start.Click += Start;
        FormClosing += (_, args) =>
        {
            if (cancellation is null) return;
            args.Cancel = true;
            closing = true;
            status.Text = "認証を中断し、終了処理を行っています。";
            cancellation.Cancel();
        };
    }

    private async void Start(object? sender, EventArgs args)
    {
        start.Enabled = mode.Enabled = false;
        cancellation = new(TimeSpan.FromMinutes(3));
        var administrator = mode.SelectedIndex == 1;
        var result = new ProbeResult { Administrator = administrator };
        try
        {
            result.ApiVersion = WindowsPasskey.ApiVersion;
            await RunProbe(Handle, administrator, result, message => status.Text = message, cancellation.Token);
            result.Success = result.AssertionVerified && result.EnvelopeUnlocked && result.ExportDenied && result.CloudLogout && result.SecurityLogout;
            status.Text = result.Success ? "ログインと端末内復号を確認しました。ウィンドウを閉じてください。" : "終了処理を含めた確認が完了していません。";
        }
        catch (Exception error)
        {
            result.ErrorKind = error.GetType().Name;
            result.ErrorCode = $"0x{error.HResult:X8}";
            status.Text = error is OperationCanceledException ? "確認を中断しました。" : "認証または端末内復号を確認できませんでした。";
        }
        finally
        {
            result.CompletedAt = DateTimeOffset.UtcNow;
            WriteResult(result);
            cancellation.Dispose(); cancellation = null;
            start.Enabled = mode.Enabled = true;
            if (closing) Close();
        }
    }

    private static async Task RunProbe(nint owner, bool administrator, ProbeResult result, Action<string> progress, CancellationToken token)
    {
        using var handler = new HttpClientHandler { AllowAutoRedirect = false, CookieContainer = new CookieContainer(), UseCookies = true };
        using var client = new HttpClient(handler) { BaseAddress = new(WindowsPasskey.Origin), Timeout = TimeSpan.FromSeconds(20), MaxResponseContentBufferSize = 1024 * 1024 };
        client.DefaultRequestHeaders.Add("Origin", WindowsPasskey.Origin);
        client.DefaultRequestHeaders.UserAgent.ParseAdd("TCloud-Windows-Compatibility/0.1");
        var keyId = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var imported = false;
        var cloudAttempted = false;
        try
        {
            result.Stage = "authentication-options";
            progress("認証情報を確認しています。");
            var options = await Post(client, "/security/api/auth/options", new { service = "cloud" }, token);
            var request = WindowsPasskey.Prepare(options.GetProperty("options"));
            progress("Windowsの画面でパスキーの本人確認を行ってください。");
            result.Stage = "windows-authentication";
            using var assertion = await Task.Run(() => WindowsPasskey.Authenticate(owner, request, token), token);
            result.Stage = "assertion-verification";
            var verified = await Post(client, "/security/api/auth/verify", new { service = "cloud", challengeId = options.GetProperty("challengeId").GetString(), response = assertion.ServerResponse }, token);
            if (!verified.GetProperty("authenticated").GetBoolean()
                || verified.GetProperty("credentialId").GetString() != assertion.ServerResponse.GetProperty("id").GetString())
                throw new CryptographicException("認証されたパスキーが一致しません。");
            result.AssertionVerified = true;
            result.Stage = "cloud-handoff";
            var links = verified.GetProperty("links").EnumerateArray().ToArray();
            var linkId = administrator
                ? links.SingleOrDefault(link => link.GetProperty("accountId").GetString() == "admin").GetProperty("id").GetString()
                : links.Any(link => link.GetProperty("accountId").GetString() == "folder-member") ? "cloud-member" : null;
            if (linkId is null) throw new CryptographicException("選択した利用区分の連携がありません。");
            var handoff = await Post(client, "/security/api/auth/handoff", new { service = "cloud", linkId }, token);
            cloudAttempted = true;
            var session = await Post(client, "/cloud/api/passkey/handoff", new { handoffToken = handoff.GetProperty("handoffToken").GetString() }, token);
            var sessionId = session.GetProperty("sessionCacheId").GetString();
            if (!session.GetProperty("authenticated").GetBoolean() || session.GetProperty("authMethod").GetString() != "passkey"
                || session.GetProperty("role").GetString() != (administrator ? "admin" : "member")
                || session.GetProperty("credentialId").GetString() != verified.GetProperty("credentialId").GetString() || string.IsNullOrWhiteSpace(sessionId))
                throw new CryptographicException("T-Cloudのセッションが一致しません。");
            client.DefaultRequestHeaders.Add("X-TCloud-Session", sessionId);
            JsonElement? administratorPublicKey = null;
            if (administrator)
            {
                result.Stage = "administrator-public-key";
                progress("管理者公開鍵を確認しています。");
                administratorPublicKey = await PasskeyEnvelope.LoadAdministratorPublicKeyAsync(client, token);
            }
            result.Stage = "local-envelope-unlock";
            progress("この端末内で暗号鍵の解除を確認しています。");
            var envelope = handoff.GetProperty("tcloudKey").GetProperty(administrator ? "admin_private_prf" : "client_private_prf");
            PasskeyEnvelope.Import(keyId, assertion.GetPrfOutput(), envelope, administrator, administratorPublicKey);
            imported = true;
            assertion.Dispose();
            using (var key = WindowsPrivateKey.Open(keyId))
            using (var publicKey = RSA.Create())
            {
                publicKey.ImportParameters(key.ExportParameters(false));
                var sample = RandomNumberGenerator.GetBytes(32);
                var decrypted = key.Decrypt(publicKey.Encrypt(sample, RSAEncryptionPadding.OaepSHA256), RSAEncryptionPadding.OaepSHA256);
                try { result.EnvelopeUnlocked = decrypted.AsSpan().SequenceEqual(sample); }
                finally { CryptographicOperations.ZeroMemory(sample); CryptographicOperations.ZeroMemory(decrypted); }
                try { var unexpected = key.ExportPkcs8PrivateKey(); CryptographicOperations.ZeroMemory(unexpected); }
                catch (CryptographicException) { result.ExportDenied = true; }
            }
            result.Stage = "local-key-verified";
        }
        finally
        {
            try { if (imported) WindowsPrivateKey.Delete(keyId); }
            finally
            {
                progress("検証用のログインを終了しています。");
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                if (cloudAttempted) result.CloudLogout = await Logout(client, "/cloud/api/logout", cleanup.Token);
                result.SecurityLogout = await Logout(client, "/security/api/logout", cleanup.Token);
            }
        }
    }

    private static async Task<JsonElement> Post(HttpClient client, string path, object body, CancellationToken token)
    {
        using var response = await client.PostAsJsonAsync(path, body, token);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException("認証APIで確認を完了できませんでした。", null, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
        return document.RootElement.Clone();
    }
    private static async Task<bool> Logout(HttpClient client, string path, CancellationToken token)
    {
        try { var response = await Post(client, path, new { }, token); return response.GetProperty("ok").GetBoolean(); }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or JsonException) { return false; }
    }
    private static void WriteResult(ProbeResult result)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (!File.Exists(Path.Combine(directory.FullName, "tcloud-windows", "TCloud.Sync.slnx"))) continue;
            var folder = Path.Combine(directory.FullName, "tcloud-windows", "artifacts");
            Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder, "auth-probe-result.json"), JsonSerializer.Serialize(result));
            return;
        }
    }
}

internal sealed class ProbeResult
{
    public uint ApiVersion { get; set; }
    public bool Administrator { get; init; }
    public bool AssertionVerified { get; set; }
    public bool EnvelopeUnlocked { get; set; }
    public bool ExportDenied { get; set; }
    public bool CloudLogout { get; set; }
    public bool SecurityLogout { get; set; }
    public bool Success { get; set; }
    public string? ErrorKind { get; set; }
    public string? ErrorCode { get; set; }
    public string? Stage { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
}
