using System.Drawing;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Windows.Forms;

namespace ClaudeUsageTray;

record UsageSection(string Name, int Percent, string ResetText);

static class Program
{
    private static readonly string CrashLogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "ClaudeUsageWidget", "crash.log");

    [STAThread]
    static void Main()
    {
        using var mutex = new Mutex(true, "ClaudeUsageWidget_SingleInstance", out bool createdNew);
        if (!createdNew)
        {
            MessageBox.Show("Claude Usage Widget is already running.", "Already Running", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var crashDir = Path.GetDirectoryName(CrashLogPath)!;

        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            try { Directory.CreateDirectory(crashDir); File.WriteAllText(CrashLogPath, e.ExceptionObject?.ToString() ?? "unknown"); } catch { }
        };

        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) =>
        {
            try { Directory.CreateDirectory(crashDir); File.WriteAllText(CrashLogPath, e.Exception.ToString()); } catch { }
        };

        try
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayContext());
        }
        catch (Exception ex)
        {
            try { Directory.CreateDirectory(crashDir); File.WriteAllText(CrashLogPath, ex.ToString()); } catch { }
        }
    }
}

sealed class TrayContext : ApplicationContext
{
    private static readonly string CredentialsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".claude", ".credentials.json");

    private const string UsageUrl = "https://api.anthropic.com/api/oauth/usage";
    private const string TokenUrl = "https://api.anthropic.com/v1/oauth/token";
    private const string ClientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

    private static readonly HttpClient Http = new();

    private readonly NotifyIcon _icon = null!;
    private readonly System.Windows.Forms.Timer _timer;
    private UsagePopup? _popup;

    private string _planName = "Loading...";
    private string _resetDate = "—";
    private int _usedPercent;
    private string _lastUpdated = "never";
    private List<UsageSection> _sections = new();

    private static readonly string[] IconStyleNames = ["Circle", "Rectangle", "Fill"];
    private int _iconStyle = 2; // 0 = circle, 1 = rectangle, 2 = fill

    public TrayContext()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Refresh", null, (_, _) => FetchUsage());
        menu.Items.Add($"Icon: {IconStyleNames[_iconStyle]}", null, (_, _) => CycleIconStyle(menu));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => { _icon.Visible = false; Application.Exit(); });

        _icon = new NotifyIcon
        {
            Visible = true,
            ContextMenuStrip = menu,
            Icon = MakeIcon(0),
            Text = "Claude Usage"
        };
        _icon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
                TogglePopup();
        };

        _timer = new System.Windows.Forms.Timer { Interval = 60 * 1000 };
        _timer.Tick += (_, _) => FetchUsage();
        _timer.Start();

        FetchUsage();
    }

    private void TogglePopup()
    {
        if (_popup is { Visible: true })
        {
            _popup.Close();
            _popup = null;
            return;
        }
        _popup = new UsagePopup(_planName, _resetDate, _sections, _lastUpdated);
        _popup.Show();
    }

    private void ApplyUsageData(string planName, List<UsageSection> sections)
    {
        _planName = planName;
        _sections = sections;

        var primary = sections.Find(s => s.Name == "Current session")
                      ?? sections.Find(s => s.Name == "All models")
                      ?? (sections.Count > 0 ? sections[0] : null);

        _usedPercent = primary?.Percent ?? 0;
        _resetDate = primary?.ResetText ?? "";
        _lastUpdated = DateTime.Now.ToString("h:mm tt");

        _icon.Icon?.Dispose();
        _icon.Icon = MakeIcon(_usedPercent);
        var tip = $"{_planName} — {_usedPercent}% used\nResets: {_resetDate}";
        _icon.Text = tip.Length > 127 ? tip[..127] : tip;
    }

    private void ShowError(string message)
    {
        _planName = "Error";
        var tip = $"Error: {message}";
        _icon.Text = tip.Length > 127 ? tip[..127] : tip;
    }

    private void FetchUsage()
    {
        Task.Run(async () =>
        {
            try
            {
                var (accessToken, subscriptionType) = await GetAccessTokenAsync();
                var raw = await FetchUsageApiAsync(accessToken);
                if (raw == null)
                {
                    (accessToken, subscriptionType) = await RefreshAndGetTokenAsync();
                    raw = await FetchUsageApiAsync(accessToken);
                    if (raw == null)
                        throw new Exception("Auth failed. Run \"claude auth\".");
                }

                var (planName, sections) = TransformUsageData(raw.Value, subscriptionType);
                InvokeOnUI(() => ApplyUsageData(planName, sections));
            }
            catch (Exception ex)
            {
                InvokeOnUI(() => ShowError(ex.Message));
            }
        });
    }

    private void InvokeOnUI(Action action)
    {
        if (_icon.ContextMenuStrip?.InvokeRequired == true)
            _icon.ContextMenuStrip.Invoke(action);
        else
            action();
    }

    private static async Task<(string accessToken, string subscriptionType)> GetAccessTokenAsync()
    {
        if (!File.Exists(CredentialsPath))
            throw new Exception($"No credentials. Run \"claude auth\".");

        using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(CredentialsPath));
        var oauth = doc.RootElement.GetProperty("claudeAiOauth");
        var token = oauth.GetProperty("accessToken").GetString()!;
        var refreshToken = oauth.GetProperty("refreshToken").GetString()!;
        var sub = oauth.TryGetProperty("subscriptionType", out var st) ? st.GetString() ?? "unknown" : "unknown";
        var expiresAt = oauth.TryGetProperty("expiresAt", out var ea) ? ea.GetInt64() : 0;

        if (expiresAt > 0 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > expiresAt - 60000)
            return await RefreshAndGetTokenAsync(refreshToken, sub);

        return (token, sub);
    }

    private static async Task<(string accessToken, string subscriptionType)> RefreshAndGetTokenAsync()
    {
        // Overload that reads credentials from file (used on auth failure retry)
        using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(CredentialsPath));
        var oauth = doc.RootElement.GetProperty("claudeAiOauth");
        var refreshToken = oauth.GetProperty("refreshToken").GetString()!;
        var sub = oauth.TryGetProperty("subscriptionType", out var st) ? st.GetString() ?? "unknown" : "unknown";
        return await RefreshAndGetTokenAsync(refreshToken, sub);
    }

    private static async Task<(string accessToken, string subscriptionType)> RefreshAndGetTokenAsync(string refreshToken, string subscriptionType)
    {
        var body = JsonSerializer.Serialize(new
        {
            grant_type = "refresh_token",
            refresh_token = refreshToken,
            client_id = ClientId
        });

        var resp = await Http.PostAsync(TokenUrl, new StringContent(body, System.Text.Encoding.UTF8, "application/json"));
        if (!resp.IsSuccessStatusCode)
            throw new Exception($"Token refresh failed ({(int)resp.StatusCode}). Run \"claude auth\".");

        var tokens = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        var newAccess = tokens.RootElement.GetProperty("access_token").GetString()!;
        var newRefresh = tokens.RootElement.GetProperty("refresh_token").GetString()!;
        var expiresIn = tokens.RootElement.GetProperty("expires_in").GetInt64();

        // Update credentials file
        var node = JsonNode.Parse(await File.ReadAllTextAsync(CredentialsPath))!;
        var oauthNode = node["claudeAiOauth"]!;
        oauthNode["accessToken"] = newAccess;
        oauthNode["refreshToken"] = newRefresh;
        oauthNode["expiresAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + expiresIn * 1000;
        await File.WriteAllTextAsync(CredentialsPath, node.ToJsonString());

        return (newAccess, subscriptionType);
    }

    private static async Task<JsonElement?> FetchUsageApiAsync(string accessToken)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, UsageUrl);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        req.Headers.Add("anthropic-beta", "oauth-2025-04-20");
        req.Headers.Add("User-Agent", "claude-code/2.0.32");
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var resp = await Http.SendAsync(req);
        if (resp.StatusCode is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden)
            return null;
        if (!resp.IsSuccessStatusCode)
            throw new Exception($"Usage API error ({(int)resp.StatusCode})");

        var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        return doc.RootElement.Clone();
    }

    private static (string planName, List<UsageSection> sections) TransformUsageData(JsonElement raw, string subscriptionType)
    {
        var planName = char.ToUpper(subscriptionType[0]) + subscriptionType[1..] + " Plan";
        var sections = new List<UsageSection>();

        void TryAdd(string prop, string name)
        {
            if (raw.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.Object)
            {
                var pct = el.TryGetProperty("utilization", out var u) && u.ValueKind == JsonValueKind.Number ? (int)Math.Round(u.GetDouble()) : 0;
                var resetText = el.TryGetProperty("resets_at", out var r) && r.ValueKind == JsonValueKind.String ? FormatResetTime(r.GetString()) : "";
                sections.Add(new UsageSection(name, pct, resetText));
            }
        }

        TryAdd("five_hour", "Current session");
        TryAdd("seven_day", "All models");
        TryAdd("seven_day_opus", "Opus only");
        TryAdd("seven_day_sonnet", "Sonnet only");

        return (planName, sections);
    }

    private static string FormatResetTime(string? resetsAt)
    {
        if (string.IsNullOrEmpty(resetsAt) || !DateTime.TryParse(resetsAt, null, System.Globalization.DateTimeStyles.RoundtripKind, out var reset))
            return "";
        var diff = reset - DateTime.UtcNow;
        if (diff <= TimeSpan.Zero) return "now";
        var hours = (int)diff.TotalHours;
        var mins = diff.Minutes;
        return hours > 0 ? $"in {hours}h {mins}m" : $"in {mins}m";
    }

    private void CycleIconStyle(ContextMenuStrip menu)
    {
        _iconStyle = (_iconStyle + 1) % IconStyleNames.Length;
        menu.Items[1].Text = $"Icon: {IconStyleNames[_iconStyle]}";
        _icon.Icon?.Dispose();
        _icon.Icon = MakeIcon(_usedPercent);
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    private Icon MakeIcon(int percent) => _iconStyle switch
    {
        1 => MakeRectangleIcon(percent),
        2 => MakeFillIcon(percent),
        _ => MakeCircleIcon(percent),
    };

    private static Icon MakeCircleIcon(int percent)
    {
        percent = Math.Clamp(percent, 0, 100);
        const int size = 32;
        const float penWidth = 3.5f;
        float inset = penWidth / 2f;
        var arcRect = new RectangleF(inset, inset, size - penWidth, size - penWidth);

        using var bmp = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);

            using var whitePen = new Pen(Color.White, penWidth);
            g.DrawEllipse(whitePen, arcRect);

            if (percent > 0)
            {
                float sweepAngle = -360f * percent / 100f;
                using var orangePen = new Pen(Color.FromArgb(234, 120, 0), penWidth);
                g.DrawArc(orangePen, arcRect, -90f, sweepAngle);
            }
        }

        return BitmapToIcon(bmp);
    }

    private static Icon MakeRectangleIcon(int percent)
    {
        percent = Math.Clamp(percent, 0, 100);
        const int size = 32;
        using var bmp = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            g.FillRectangle(Brushes.White, 0, 0, size, size);

            int fillW = (int)(size * percent / 100.0);
            if (fillW > 0)
            {
                using var brush = new SolidBrush(Color.FromArgb(234, 120, 0));
                g.FillRectangle(brush, 0, 0, fillW, size);
            }
        }

        return BitmapToIcon(bmp);
    }

    private static Icon MakeFillIcon(int percent)
    {
        percent = Math.Clamp(percent, 0, 100);
        const int size = 32;
        float radius = size / 2f;
        // Inner hole shrinks as percent grows: 100% = full circle, 0% = nothing
        float holeRadius = radius * (1f - percent / 100f);

        using var bmp = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);

            if (percent > 0)
            {
                // Draw full orange circle
                using var brush = new SolidBrush(Color.FromArgb(234, 120, 0));
                g.FillEllipse(brush, 0, 0, size, size);

                // Punch out the inner hole with transparency
                if (holeRadius > 0)
                {
                    float d = holeRadius * 2;
                    using var path = new System.Drawing.Drawing2D.GraphicsPath();
                    path.AddEllipse(radius - holeRadius, radius - holeRadius, d, d);
                    using var region = new Region(path);
                    g.SetClip(region, System.Drawing.Drawing2D.CombineMode.Replace);
                    g.Clear(Color.Transparent);
                    g.ResetClip();
                }
            }
        }

        return BitmapToIcon(bmp);
    }

    private static Icon BitmapToIcon(Bitmap bmp)
    {
        var hIcon = bmp.GetHicon();
        var icon = (Icon)Icon.FromHandle(hIcon).Clone();
        DestroyIcon(hIcon);
        return icon;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _popup?.Close();
            _timer.Dispose();
            _icon.Dispose();
        }
        base.Dispose(disposing);
    }
}

sealed class UsagePopup : Form
{
    private static readonly Color Orange = Color.FromArgb(217, 119, 87);
    private static readonly Color BgColor = Color.FromArgb(38, 38, 36);

    public UsagePopup(string planName, string resetDate, List<UsageSection> sections, string lastUpdated)
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = BgColor;
        Size = new Size(300, 0);

        int y = 12;

        var resetLabel = MakeLabel($"Resets {resetDate}", 12, y, 276, Color.FromArgb(180, 170, 160), 9f);
        Controls.Add(resetLabel);
        y += 22;

        var planLabel = MakeLabel(planName, 12, y, 276, Color.White, 14f, FontStyle.Bold);
        Controls.Add(planLabel);
        y += 30;

        bool first = true;
        foreach (var sec in sections)
        {
            if (!first)
            {
                y += 4;
                var sep = new Panel { Location = new Point(12, y), Size = new Size(276, 1), BackColor = Color.FromArgb(60, 60, 56) };
                Controls.Add(sep);
                y += 8;
            }
            first = false;

            y = AddProgressBar($"{sec.Name}: {sec.Percent}%", sec.Percent, y);
            if (!string.IsNullOrEmpty(sec.ResetText))
            {
                var rl = MakeLabel($"Resets {sec.ResetText}", 12, y, 276, Color.FromArgb(140, 130, 120), 7.5f);
                Controls.Add(rl);
                y += 16;
            }
        }

        y += 8;
        var sep2 = new Panel { Location = new Point(12, y), Size = new Size(276, 1), BackColor = Color.FromArgb(60, 60, 56) };
        Controls.Add(sep2);
        y += 6;
        var updatedLabel = MakeLabel($"Updated {lastUpdated}", 12, y, 276, Color.FromArgb(140, 130, 120), 7.5f);
        Controls.Add(updatedLabel);
        y += 18;
        ClientSize = new Size(300, y);

        var workArea = Screen.PrimaryScreen!.WorkingArea;
        Location = new Point(workArea.Right - Width - 8, workArea.Bottom - Height - 8);

        Deactivate += (_, _) => Close();
    }

    private int AddProgressBar(string label, int percent, int y)
    {
        var lbl = MakeLabel(label, 12, y, 220, Color.FromArgb(200, 190, 180), 9f);
        Controls.Add(lbl);

        var pctLabel = MakeLabel($"{percent}%", 232, y, 56, Color.White, 9f, FontStyle.Bold);
        pctLabel.TextAlign = ContentAlignment.TopRight;
        Controls.Add(pctLabel);
        y += 20;

        var track = new Panel
        {
            Location = new Point(12, y),
            Size = new Size(276, 8),
            BackColor = Color.FromArgb(60, 60, 56)
        };
        Controls.Add(track);

        int fillW = Math.Max(0, (int)(276.0 * percent / 100));
        if (fillW > 0)
        {
            var fill = new Panel
            {
                Location = new Point(0, 0),
                Size = new Size(fillW, 8),
                BackColor = Orange
            };
            track.Controls.Add(fill);
        }

        return y + 14;
    }

    private static Label MakeLabel(string text, int x, int y, int w, Color color, float fontSize, FontStyle style = FontStyle.Regular)
    {
        return new Label
        {
            Text = text,
            Location = new Point(x, y),
            Size = new Size(w, (int)(fontSize * 2.2)),
            ForeColor = color,
            Font = new Font("Segoe UI", fontSize, style),
            BackColor = Color.Transparent
        };
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using var pen = new Pen(Color.FromArgb(60, 60, 56), 1);
        e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
    }
}
