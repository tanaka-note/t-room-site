using TCloud.Sync.Windows;

namespace TCloud.Sync.Host;

internal sealed class SyncDashboard : UserControl
{
    private static readonly Color Ink = Color.FromArgb(32, 44, 38);
    private static readonly Color Muted = Color.FromArgb(88, 105, 98);
    private static readonly Color Line = Color.FromArgb(220, 229, 223);
    private static readonly Color Accent = Color.FromArgb(52, 99, 78);
    private static readonly Color Soft = Color.FromArgb(237, 245, 239);
    private static readonly Color Subtle = Color.FromArgb(244, 247, 245);
    private readonly Font small = new("Yu Gothic UI", 8);
    private readonly Font strong = new("Yu Gothic UI", 9, FontStyle.Bold);
    private readonly Font title = new("Yu Gothic UI", 18, FontStyle.Bold);
    private readonly Font detailTitle = new("Yu Gothic UI", 11, FontStyle.Bold);
    private readonly Label drive = new() { Dock = DockStyle.Fill, ForeColor = Muted };
    private readonly Label summary = new() { Dock = DockStyle.Fill, Padding = new(11, 0, 0, 0), TextAlign = ContentAlignment.MiddleLeft };
    private readonly Label checkedAt = new() { Dock = DockStyle.Fill, ForeColor = Muted, TextAlign = ContentAlignment.MiddleRight, Padding = new(0, 0, 11, 0) };
    private readonly Label notice = new() { Dock = DockStyle.Fill, ForeColor = Muted, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft };
    private readonly Button check = MakeButton("今すぐ照合", primary: true);
    private readonly Button send = MakeButton("PC → T-Cloud");
    private readonly Button receive = MakeButton("T-Cloud → HDD");
    private readonly Button completedFilter = MakeButton("反映済み");
    private readonly Button verify = MakeButton("原本を読み戻して検証");
    private readonly ComboBox folders = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 150 };
    private readonly ComboBox dates = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 112 };
    private readonly DataGridView grid = new();
    private readonly TableLayoutPanel detail = new() { ColumnCount = 1, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Dock = DockStyle.Top, Padding = new(12) };
    private readonly Label fileName = new() { AutoSize = true };
    private readonly Label fileState = new() { AutoSize = true };
    private readonly Label fileReason = new() { AutoSize = true };
    private readonly TableLayoutPanel fileFields = new() { AutoSize = true, ColumnCount = 2, Dock = DockStyle.Top, Margin = new(0, 8, 0, 6) };
    private readonly (Label Name, Label Value)[] fields = new (Label, Label)[6];
    private readonly Label readbackResult = new() { AutoSize = true, ForeColor = Accent };
    private readonly Button recovery = MakeButton("保全した編集を開く");
    private readonly Dictionary<Button, int> buttons = new();
    private readonly string?[] selection = new string?[2];
    private readonly string?[] selectionPath = new string?[2];
    private readonly string?[] scroll = new string?[2];
    private readonly int[] stateFilter = new int[2];
    private WindowsActivitySnapshot? latest;
    private WindowsActivityItem[] rows = [];
    private int direction;
    private bool updating;
    private bool canCheck;
    private bool hddConnected;
    private string? hostNotice;
    private string? verifyingKey;
    private string? readbackKey;
    private string? readbackMessage;

    public event Action? CheckRequested;
    public event Action<WindowsActivityItem>? RecoveryRequested;
    public event Action<WindowsActivityItem>? VerifyRequested;

    public SyncDashboard(CheckBox startup, Action openHdd)
    {
        Dock = DockStyle.Fill;
        BackColor = Color.White;
        ForeColor = Ink;
        Font = new("Yu Gothic UI", 9);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new(23, 15, 23, 9), ColumnCount = 1, RowCount = 6 };
        layout.RowStyles.Add(new(SizeType.Absolute, 70));
        layout.RowStyles.Add(new(SizeType.Absolute, 46));
        layout.RowStyles.Add(new(SizeType.Absolute, 44));
        layout.RowStyles.Add(new(SizeType.Absolute, 29));
        layout.RowStyles.Add(new(SizeType.Percent, 100));
        layout.RowStyles.Add(new(SizeType.Absolute, 50));
        Controls.Add(layout);

        var heading = Pair(100, 124);
        var headingText = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 1, Margin = Padding.Empty };
        headingText.RowStyles.Add(new(SizeType.Absolute, 42));
        headingText.RowStyles.Add(new(SizeType.Percent, 100));
        headingText.Controls.Add(new Label { Text = "同期状況", Dock = DockStyle.Fill, Font = title }, 0, 0);
        drive.Font = small;
        headingText.Controls.Add(drive, 0, 1);
        heading.Controls.Add(headingText, 0, 0);
        check.Dock = DockStyle.Top;
        check.Height = 36;
        check.Margin = new(0, 10, 0, 0);
        check.Click += (_, _) => CheckRequested?.Invoke();
        heading.Controls.Add(check, 1, 0);
        layout.Controls.Add(heading, 0, 0);

        var directions = Flow();
        send.Click += (_, _) => SelectDirection(0);
        receive.Click += (_, _) => SelectDirection(1);
        directions.Controls.AddRange([send, receive]);
        layout.Controls.Add(directions, 0, 1);

        var counts = Pair(100, 232);
        counts.BackColor = Soft;
        summary.Font = strong;
        checkedAt.Font = small;
        counts.Controls.Add(summary, 0, 0);
        counts.Controls.Add(checkedAt, 1, 0);
        layout.Controls.Add(counts, 0, 2);
        notice.Font = small;
        layout.Controls.Add(notice, 0, 3);

        var content = Pair(100, 282);
        var list = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Margin = new(0, 0, 13, 0) };
        list.RowStyles.Add(new(SizeType.Absolute, 36));
        list.RowStyles.Add(new(SizeType.Absolute, 35));
        list.RowStyles.Add(new(SizeType.Percent, 100));
        var listHeader = Pair(100, 272);
        listHeader.Controls.Add(new Label { Text = "ファイルの同期履歴", AutoSize = true, Anchor = AnchorStyles.Left, Font = strong }, 0, 0);
        var folderPicker = Flow();
        folders.AccessibleName = "フォルダで絞り込み";
        dates.AccessibleName = "日付で絞り込み";
        dates.Items.AddRange(["全期間", "今日", "過去7日間"]);
        dates.SelectedIndex = 0;
        folders.SelectedIndexChanged += (_, _) => { if (!updating) RefreshRows(); };
        dates.SelectedIndexChanged += (_, _) => { if (!updating) RefreshRows(); };
        folderPicker.Controls.AddRange([folders, dates]);
        listHeader.Controls.Add(folderPicker, 1, 0);
        list.Controls.Add(listHeader, 0, 0);
        var filters = Flow();
        foreach (var (button, index) in new[] { (MakeButton("すべて"), 0), (MakeButton("進行中"), 1), (MakeButton("要対応"), 2), (completedFilter, 3) })
        {
            buttons[button] = index;
            button.Click += (_, _) => { stateFilter[direction] = index; RefreshRows(); };
            filters.Controls.Add(button);
        }
        list.Controls.Add(filters, 0, 1);
        ConfigureGrid();
        list.Controls.Add(grid, 0, 2);
        content.Controls.Add(list, 0, 0);

        var detailScroll = new Panel { AutoScroll = true, Dock = DockStyle.Fill, BackColor = Subtle, Margin = new(0, 1, 0, 0) };
        detailScroll.Controls.Add(detail);
        detail.Controls.Add(new Label { Text = "ファイル詳細", AutoSize = true, ForeColor = Muted, Font = small });
        fileName.Font = detailTitle;
        fileState.Font = strong;
        fileReason.Margin = new(3, 8, 3, 8);
        fileFields.ColumnStyles.Add(new(SizeType.Absolute, 83));
        fileFields.ColumnStyles.Add(new(SizeType.Percent, 100));
        var names = new[] { "保存先", "操作", "検出日時", "ファイルサイズ", "確認日時", "転送済み" };
        for (var index = 0; index < names.Length; index++)
        {
            var label = new Label { Text = names[index], AutoSize = true, ForeColor = Muted, Font = small, Margin = new(3, 3, 4, 4) };
            var value = new Label { AutoSize = true, Margin = new(3, 3, 3, 4), Font = small };
            fields[index] = (label, value);
            fileFields.RowStyles.Add(new(SizeType.AutoSize));
            fileFields.Controls.Add(label, 0, index);
            fileFields.Controls.Add(value, 1, index);
        }
        verify.Click += (_, _) => { if (Selected is {} row) VerifyRequested?.Invoke(row); };
        recovery.Click += (_, _) => { if (Selected is {} row) RecoveryRequested?.Invoke(row); };
        foreach (var child in new Control[] { fileName, fileState, fileReason, fileFields, verify, recovery, readbackResult }) detail.Controls.Add(child);
        detailScroll.SizeChanged += (_, _) =>
        {
            var width = Math.Max(120, detailScroll.ClientSize.Width - 28);
            foreach (var label in new[] { fileName, fileState, fileReason, readbackResult }) label.MaximumSize = new(width, 0);
            foreach (var field in fields) field.Value.MaximumSize = new(Math.Max(60, width - 87), 0);
        };
        content.Controls.Add(detailScroll, 1, 0);
        layout.Controls.Add(content, 0, 4);

        var footer = Flow();
        footer.Padding = new(0, 7, 0, 0);
        var open = MakeButton("HDDのフォルダを開く");
        open.Click += (_, _) => openHdd();
        startup.Visible = true;
        startup.AutoSize = true;
        startup.Margin = new(10, 6, 0, 0);
        footer.Controls.AddRange([open, startup]);
        layout.Controls.Add(footer, 0, 5);
        SetConnection(false, null, false, "登録したHDDを確認しています。");
        RefreshRows();
    }

    public int VisibleCount => rows.Length;
    public void SelectDirection(int next)
    {
        RememberSelection();
        direction = next;
        RefreshRows(preserveSelection: false);
    }

    public void SetConnection(bool connected, string? path, bool available, string? message)
    {
        hddConnected = connected;
        canCheck = available;
        hostNotice = message;
        drive.Text = connected ? "●  HDD接続中    " + path : "○  HDDの接続を確認中";
        UpdateSummary();
        ShowDetail();
    }

    public void Apply(WindowsActivitySnapshot snapshot)
    {
        latest = snapshot;
        RefreshRows();
    }

    public void ShowReadback(string key, bool running, string message)
    {
        verifyingKey = running ? key : null;
        readbackKey = key;
        readbackMessage = message;
        ShowDetail();
    }

    private void UpdateSummary()
    {
        var all = DirectionRows;
        var pending = all.Count(row => Group(row) == 1);
        var attention = all.Count(row => Group(row) == 2);
        var done = all.Length - pending - attention;
        summary.Text = latest is { Current: true } && pending + attention == 0
            ? "✓  すべて確認済み" : all.Length == 0 ? "同期状況を確認しています" : $"進行中  {pending:N0}件      要対応  {attention:N0}件      確認済み  {done:N0}件";
        checkedAt.Text = latest?.LastCheckedAt is {} time ? $"最終照合 {FormatTime(time)}" : "最終照合 —";
        notice.Text = hostNotice ?? latest?.Notice ?? (latest is { Current: true } ? "" : "HDDとオンライン一覧を照合しています。");
        check.Enabled = canCheck;
    }

    private WindowsActivityItem[] DirectionRows => (direction == 0 ? latest?.Uploads : latest?.Downloads) ?? [];
    private WindowsActivityItem? Selected => grid.CurrentCell is { RowIndex: var index } && index >= 0 && index < rows.Length ? rows[index] : null;

    private void RememberSelection()
    {
        if (Selected is {} row) { selection[direction] = row.Key; selectionPath[direction] = row.RelativePath; }
        if (grid.FirstDisplayedScrollingRowIndex is var start && start >= 0 && start < rows.Length) scroll[direction] = rows[start].Key;
    }

    private void RefreshRows(bool preserveSelection = true)
    {
        if (preserveSelection) RememberSelection();
        updating = true;
        try
        {
            Mark(send, direction == 0);
            Mark(receive, direction == 1);
            completedFilter.Text = direction == 0 ? "反映済み" : "保存済み";
            foreach (var (button, index) in buttons) Mark(button, index == stateFilter[direction]);
            var all = DirectionRows;
            var options = all.Select(Folder).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(path => path, StringComparer.CurrentCultureIgnoreCase).ToArray();
            var oldFolder = folders.SelectedItem as string;
            if (!folders.Items.Cast<string>().Skip(1).SequenceEqual(options))
            {
                folders.Items.Clear();
                folders.Items.Add("すべてのフォルダ");
                folders.Items.AddRange(options);
                var index = oldFolder is null ? -1 : folders.Items.IndexOf(oldFolder);
                folders.SelectedIndex = Math.Max(0, index);
            }
            if (folders.SelectedIndex < 0) { folders.Items.Add("すべてのフォルダ"); folders.SelectedIndex = 0; }
            var filterFolder = folders.SelectedIndex > 0 ? folders.SelectedItem as string : null;
            var today = DateTimeOffset.Now.Date;
            rows = all.Where(row => (stateFilter[direction] == 0 || Group(row) == stateFilter[direction])
                && (filterFolder is null || Folder(row).Equals(filterFolder, StringComparison.OrdinalIgnoreCase))
                && (dates.SelectedIndex == 0 || (row.ConfirmedAt ?? row.DetectedAt).ToLocalTime().Date >= today.AddDays(dates.SelectedIndex == 1 ? 0 : -6)))
                .OrderBy(row => Group(row) == 2 ? 0 : Group(row) == 1 ? 1 : 2)
                .ThenBy(row => row.Operation == WindowsActivityOperation.Existing)
                .ThenByDescending(row => row.ConfirmedAt ?? row.DetectedAt).ThenBy(row => row.RelativePath, StringComparer.CurrentCultureIgnoreCase).ToArray();
            grid.RowCount = rows.Length;
            if (rows.Length > 0)
            {
                var index = Array.FindIndex(rows, row => row.Key == selection[direction]);
                if (index < 0) index = Array.FindIndex(rows, row => row.RelativePath.Equals(selectionPath[direction], StringComparison.OrdinalIgnoreCase));
                grid.CurrentCell = grid.Rows[Math.Max(0, index)].Cells[0];
                var first = Array.FindIndex(rows, row => row.Key == scroll[direction]);
                if (first >= 0 && grid.IsHandleCreated) grid.FirstDisplayedScrollingRowIndex = first;
            }
            grid.Invalidate();
        }
        finally { updating = false; }
        UpdateSummary();
        ShowDetail();
    }

    private void ShowDetail()
    {
        var row = Selected;
        fileName.Text = row is null ? "表示するファイルはありません" : Path.GetFileName(row.RelativePath);
        fileState.Text = row is null ? "" : StateText(row);
        fileState.ForeColor = row is null ? Muted : StateColors(row.State).Text;
        fileReason.Text = row?.Reason ?? (row?.State switch
        {
            WindowsActivityState.Confirmed when row.Operation is WindowsActivityOperation.Added or WindowsActivityOperation.Updated
                => "PCで保存した内容と、オンラインの該当版が一致しました。",
            WindowsActivityState.Confirmed => "オンラインの名前と保存先が一致しました。",
            WindowsActivityState.Retained => "オンラインの該当版と一致する原本をHDDに保存しました。",
            _ => ""
        });
        fileReason.Visible = fileReason.Text.Length != 0;
        if (row is not null)
        {
            SetField(0, Folder(row));
            SetField(1, OperationText(row.Operation));
            SetField(2, FormatFullTime(row.DetectedAt));
            SetField(3, row.Size is {} size ? SizeText(size) : null);
            SetField(4, row.ConfirmedAt is {} time ? FormatFullTime(time) : null);
            SetField(5, row.Bytes > 0 && Group(row) == 1 ? SizeText(row.Bytes) : null);
        }
        fileFields.Visible = row is not null;
        verify.Visible = row is { State: WindowsActivityState.Confirmed, Sha256: not null, ContentVersion: not null, FileId: not null };
        verify.Enabled = hddConnected && canCheck && verifyingKey is null;
        verify.Text = verifyingKey is not null && verifyingKey == row?.Key ? "原本を検証中…" : "原本を読み戻して検証";
        recovery.Visible = row?.State == WindowsActivityState.Preserved;
        recovery.Enabled = hddConnected;
        readbackResult.Text = row is null ? "" : row.Key == readbackKey && readbackMessage is not null ? readbackMessage
            : row.ReadbackFailedAt is {} failed ? row.ReadbackFailure + "\n" + FormatFullTime(failed)
            : row.ReadbackAt is {} verified ? "原本の読み戻し検証済み\n" + FormatFullTime(verified) : "";
        readbackResult.Visible = readbackResult.Text.Length != 0;
    }

    private void SetField(int index, string? text)
    {
        var (name, value) = fields[index];
        value.Text = text;
        name.Visible = value.Visible = text is not null;
    }

    private void ConfigureGrid()
    {
        grid.Dock = DockStyle.Fill;
        grid.Margin = Padding.Empty;
        grid.VirtualMode = true;
        grid.ReadOnly = true;
        grid.MultiSelect = false;
        grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
        grid.AllowUserToResizeRows = grid.AllowUserToAddRows = grid.AllowUserToDeleteRows = false;
        grid.RowHeadersVisible = false;
        grid.BackgroundColor = Color.White;
        grid.BorderStyle = BorderStyle.None;
        grid.CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal;
        grid.GridColor = Line;
        grid.EnableHeadersVisualStyles = false;
        grid.ColumnHeadersHeight = 31;
        grid.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
        grid.ColumnHeadersDefaultCellStyle = new() { BackColor = Subtle, ForeColor = Muted, Font = small, Padding = new(5, 0, 0, 0) };
        grid.DefaultCellStyle = new() { SelectionBackColor = Soft, SelectionForeColor = Ink };
        grid.RowTemplate.Height = 53;
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "ファイル · 操作", AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill, FillWeight = 58, SortMode = DataGridViewColumnSortMode.NotSortable });
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "状態", AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill, FillWeight = 42, SortMode = DataGridViewColumnSortMode.NotSortable });
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "検出／確認", Width = 111, SortMode = DataGridViewColumnSortMode.NotSortable });
        grid.CellValueNeeded += (_, e) =>
        {
            if (e.RowIndex < 0 || e.RowIndex >= rows.Length) return;
            var row = rows[e.RowIndex];
            e.Value = e.ColumnIndex switch { 0 => row.RelativePath, 1 => StateText(row), _ => FormatTime(row.ConfirmedAt ?? row.DetectedAt) };
        };
        grid.CellPainting += PaintCell;
        grid.SelectionChanged += (_, _) => { if (!updating) ShowDetail(); };
    }

    private void PaintCell(object? sender, DataGridViewCellPaintingEventArgs e)
    {
        if (e.Graphics is null || e.RowIndex < 0 || e.RowIndex >= rows.Length) return;
        var g = e.Graphics;
        var row = rows[e.RowIndex];
        var box = e.CellBounds;
        var width = Math.Max(0, box.Width - 13);
        var top = (e.State & DataGridViewElementStates.Selected) != 0;
        e.PaintBackground(box, top);
        if (e.ColumnIndex == 0)
        {
            if (top) { using var mark = new SolidBrush(Accent); g.FillRectangle(mark, box.X, box.Y + 6, 3, box.Height - 12); }
            Draw(g, Path.GetFileName(row.RelativePath), strong, Ink, new(box.X + 8, box.Y + 7, width, 18));
            Draw(g, $"{Folder(row)} · {OperationText(row.Operation)}", small, Muted, new(box.X + 8, box.Y + 27, width, 17));
        }
        else if (e.ColumnIndex == 1)
        {
            var (text, fill) = StateColors(row.State);
            var status = StateText(row);
            var measured = TextRenderer.MeasureText(status, small).Width + 8;
            var badgeWidth = Math.Min(width, measured);
            var badgeHeight = measured > width ? 35 : 18;
            using var badge = new SolidBrush(fill);
            g.FillRectangle(badge, box.X + 6, box.Y + 8, badgeWidth, badgeHeight);
            TextRenderer.DrawText(g, status, small, new Rectangle(box.X + 9, box.Y + 9, Math.Max(0, badgeWidth - 4), badgeHeight - 2), text,
                TextFormatFlags.NoPadding | TextFormatFlags.WordBreak | TextFormatFlags.VerticalCenter);
            if (row.Bytes > 0 && row.Size is > 0 && Group(row) == 1)
            {
                using var track = new SolidBrush(Line);
                using var progress = new SolidBrush(text);
                var trackWidth = Math.Min(75, width);
                g.FillRectangle(track, box.X + 6, box.Y + 30, trackWidth, 3);
                g.FillRectangle(progress, box.X + 6, box.Y + 30, (int)(trackWidth * Math.Clamp((double)row.Bytes / row.Size.Value, 0, 1)), 3);
                Draw(g, $"{SizeText(row.Bytes)} / {SizeText(row.Size.Value)}", small, Muted, new(box.X + 6, box.Y + 35, width, 15));
            }
        }
        else Draw(g, FormatTime(row.ConfirmedAt ?? row.DetectedAt), small, Muted, new(box.X + 6, box.Y + 17, width, 18));
        e.Paint(box, DataGridViewPaintParts.Border | DataGridViewPaintParts.Focus);
        e.Handled = true;
    }

    private static int Group(WindowsActivityItem row) => row.State switch
    {
        WindowsActivityState.Confirmed or WindowsActivityState.Retained => 3,
        WindowsActivityState.Attention or WindowsActivityState.Preserved or WindowsActivityState.Unverified => 2,
        _ => 1
    };

    private static (Color Text, Color Fill) StateColors(WindowsActivityState state) => state switch
    {
        WindowsActivityState.Attention or WindowsActivityState.Preserved or WindowsActivityState.Unverified => (Color.FromArgb(128, 81, 14), Color.FromArgb(250, 240, 223)),
        WindowsActivityState.Sending or WindowsActivityState.Checking or WindowsActivityState.Receiving => (Color.FromArgb(38, 91, 134), Color.FromArgb(234, 242, 250)),
        WindowsActivityState.Confirmed or WindowsActivityState.Retained => (Accent, Soft),
        _ => (Muted, Subtle)
    };

    private static string StateText(WindowsActivityItem row) => row.State switch
    {
        WindowsActivityState.Waiting => "保存完了待ち", WindowsActivityState.Queued => "送信待ち", WindowsActivityState.Sending => "送信中",
        WindowsActivityState.Checking => "オンライン反映を確認中",
        WindowsActivityState.Confirmed when row.Operation == WindowsActivityOperation.Existing => "照合済み（既存）",
        WindowsActivityState.Confirmed => "オンライン反映確認済み",
        WindowsActivityState.Retry => "再試行待ち", WindowsActivityState.Attention => "要対応", WindowsActivityState.Preserved => "競合で保全",
        WindowsActivityState.Listed => "一覧のみ取得", WindowsActivityState.Receiving => "原本を取得中",
        WindowsActivityState.Retained => "HDD保存確認済み", _ => "未確認"
    };

    private static string OperationText(WindowsActivityOperation operation) => operation switch
    {
        WindowsActivityOperation.Added => "追加", WindowsActivityOperation.Updated => "上書き", WindowsActivityOperation.Renamed => "名前変更／移動",
        WindowsActivityOperation.CreatedFolder => "フォルダ作成", WindowsActivityOperation.Existing => "既存ファイル照合", _ => "原本取得"
    };

    private static string Folder(WindowsActivityItem row) => Path.GetDirectoryName(row.RelativePath) is { Length: > 0 } parent
        ? parent.Replace("\\", " / ") : "HDDの同期ルート直下";
    private static string FormatTime(DateTimeOffset time) => time.ToLocalTime().ToString("MM/dd HH:mm");
    private static string FormatFullTime(DateTimeOffset time) => time.ToLocalTime().ToString("yyyy/MM/dd HH:mm:ss");
    private static string SizeText(long bytes) => bytes switch
    { >= 1L << 30 => $"{bytes / (double)(1L << 30):0.#} GB", >= 1L << 20 => $"{bytes / (double)(1L << 20):0.#} MB", >= 1024 => $"{bytes / 1024d:0.#} KB", _ => $"{bytes} B" };

    private static void Draw(Graphics g, string text, Font font, Color color, Rectangle bounds)
        => TextRenderer.DrawText(g, text, font, bounds, color, TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.VerticalCenter);
    private static TableLayoutPanel Pair(int percent, int trailing)
    {
        var pane = new TableLayoutPanel { ColumnCount = 2, RowCount = 1, Dock = DockStyle.Fill, Margin = Padding.Empty };
        pane.ColumnStyles.Add(new(SizeType.Percent, percent));
        pane.ColumnStyles.Add(new(SizeType.Absolute, trailing));
        pane.RowStyles.Add(new(SizeType.Percent, 100));
        return pane;
    }

    private static FlowLayoutPanel Flow() => new() { Dock = DockStyle.Fill, Margin = Padding.Empty, WrapContents = false };
    private static Button MakeButton(string text, bool primary = false)
    {
        var button = new Button { Text = text, AutoSize = true, MinimumSize = new(0, 29), FlatStyle = FlatStyle.Flat,
            BackColor = primary ? Accent : Color.White, ForeColor = primary ? Color.White : Ink, Padding = new(6, 0, 6, 0), Margin = new(0, 2, 5, 2), UseVisualStyleBackColor = false };
        button.FlatAppearance.BorderColor = primary ? Accent : Line;
        return button;
    }
    private static void Mark(Button button, bool selected)
    {
        button.BackColor = selected ? Soft : Color.White;
        button.ForeColor = selected ? Accent : Ink;
        button.FlatAppearance.BorderColor = selected ? Accent : Line;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { small.Dispose(); strong.Dispose(); title.Dispose(); detailTitle.Dispose(); Font.Dispose(); }
        base.Dispose(disposing);
    }
}
