using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;

namespace ClaudeUsageTray;

static class Program
{
    [STAThread]
    static void Main()
    {
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            var logPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "ClaudeUsageWidget", "crash.log");
            try { File.WriteAllText(logPath, e.ExceptionObject?.ToString() ?? "unknown"); } catch { }
        };

        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) =>
        {
            var logPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "ClaudeUsageWidget", "crash.log");
            try { File.WriteAllText(logPath, e.Exception.ToString()); } catch { }
        };

        try
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayContext());
        }
        catch (Exception ex)
        {
            var logPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "ClaudeUsageWidget", "crash.log");
            try { File.WriteAllText(logPath, ex.ToString()); } catch { }
        }
    }
}

sealed class TrayContext : ApplicationContext
{
    private static readonly string UsageJsonPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "ClaudeUsageWidget", "usage.json");

    private readonly NotifyIcon _icon;
    private readonly System.Windows.Forms.Timer _timer;
    private UsagePopup? _popup;

    private string _planName = "Loading...";
    private string _usageText = "Click Refresh";
    private string _resetDate = "—";
    private int _usedPercent;
    private string _lastUpdated = "never";
    private JsonElement _sections;

    private static string FindScraperPath()
    {
        // Walk up from exe directory looking for scraper/scrape-usage.js
        var dir = AppContext.BaseDirectory;
        for (int i = 0; i < 8; i++)
        {
            var candidate = Path.Combine(dir, "scraper", "scrape-usage.js");
            if (File.Exists(candidate))
                return Path.GetFullPath(candidate);
            var parent = Path.GetDirectoryName(dir);
            if (parent == null || parent == dir) break;
            dir = parent;
        }
        return "";
    }

    public TrayContext()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Refresh", null, (_, _) => RunScraper());
        menu.Items.Add("Login", null, (_, _) => RunScraper(login: true));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => { _icon.Visible = false; Application.Exit(); });

        _icon = new NotifyIcon
        {
            Visible = true,
            ContextMenuStrip = menu,
            Icon = MakeBatteryIcon(0),
            Text = "Claude Usage"
        };
        _icon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
                TogglePopup();
        };

        _timer = new System.Windows.Forms.Timer { Interval = 60 * 1000 };
        _timer.Tick += (_, _) => RunScraper();
        _timer.Start();

        LoadData();
    }

    private void TogglePopup()
    {
        if (_popup is { Visible: true })
        {
            _popup.Close();
            _popup = null;
            return;
        }
        _popup = new UsagePopup(_planName, _resetDate, _usedPercent, _usageText, _sections, _lastUpdated);
        _popup.Show();
    }

    private void LoadData()
    {
        try
        {
            if (!File.Exists(UsageJsonPath)) return;
            var json = File.ReadAllText(UsageJsonPath);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            _planName = root.TryGetProperty("planName", out var pn) ? pn.GetString() ?? "—" : "—";
            _usageText = root.TryGetProperty("usageText", out var ut) ? ut.GetString() ?? "—" : "—";
            _resetDate = root.TryGetProperty("resetDate", out var rd) ? rd.GetString() ?? "—" : "—";
            _usedPercent = root.TryGetProperty("usedPercent", out var up) ? up.GetInt32() : 0;
            if (root.TryGetProperty("sections", out var sec))
                _sections = sec.Clone();
            if (root.TryGetProperty("scrapedAt", out var sa) && DateTime.TryParse(sa.GetString(), out var dt))
                _lastUpdated = dt.ToLocalTime().ToString("h:mm tt");

            _icon.Icon?.Dispose();
            _icon.Icon = MakeBatteryIcon(_usedPercent);
            var tip = $"{_planName} — {_usedPercent}% used\nResets: {_resetDate}";
            _icon.Text = tip.Length > 127 ? tip[..127] : tip;
        }
        catch (Exception ex)
        {
            _planName = "Load error";
            _usageText = ex.Message;
            var tip = $"Failed to read usage.json:\n{ex.Message}";
            _icon.Text = tip.Length > 127 ? tip[..127] : tip;
        }
    }

    private void RunScraper(bool login = false)
    {
        var scraperFull = FindScraperPath();
        if (string.IsNullOrEmpty(scraperFull))
        {
            _planName = "Scraper not found";
            _usageText = $"Searched from {AppContext.BaseDirectory}";
            _icon.Text = "Scraper not found";
            return;
        }

        var scraperDir = Path.GetDirectoryName(scraperFull)!;
        Task.Run(() =>
        {
            string stderr = "";
            int exitCode = -1;
            try
            {
                var args = login ? $"\"{scraperFull}\" --login" : $"\"{scraperFull}\"";
                var psi = new ProcessStartInfo("node", args)
                {
                    UseShellExecute = false,
                    CreateNoWindow = !login,
                    RedirectStandardError = true,
                    WorkingDirectory = scraperDir
                };
                var proc = Process.Start(psi);
                if (proc != null)
                {
                    stderr = proc.StandardError.ReadToEnd();
                    proc.WaitForExit(120000);
                    exitCode = proc.ExitCode;
                }
            }
            catch (Exception ex)
            {
                stderr = ex.Message;
            }

            void Update()
            {
                LoadData();
                if (exitCode != 0 && _planName == "Error")
                {
                    var shortErr = stderr.Length > 200 ? stderr[..200] : stderr;
                    var tip = $"Scraper failed (exit {exitCode})\n{shortErr}";
                    _icon.Text = tip.Length > 127 ? tip[..127] : tip;
                }
            }

            if (_icon.ContextMenuStrip?.InvokeRequired == true)
                _icon.ContextMenuStrip.Invoke(Update);
            else
                Update();
        });
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    private static Icon MakeBatteryIcon(int percent)
    {
        percent = Math.Clamp(percent, 0, 100);
        const int size = 32;
        using var bmp = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            g.FillRectangle(Brushes.White, 0, 0, size, size);

            int fillW = (int)(size * percent / 100.0);
            if (fillW > 0)
            {
                using var brush = new SolidBrush(Color.FromArgb(234, 120, 0));
                g.FillRectangle(brush, 0, 0, fillW, size);
            }
        }

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

    public UsagePopup(string planName, string resetDate, int usedPercent, string usageText, JsonElement sections, string lastUpdated)
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

        if (sections.ValueKind == JsonValueKind.Array)
        {
            bool first = true;
            foreach (var sec in sections.EnumerateArray())
            {
                var name = sec.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
                var pct = sec.TryGetProperty("percent", out var p) ? p.GetInt32() : 0;
                var reset = sec.TryGetProperty("resetText", out var r) ? r.GetString() ?? "" : "";

                if (!first)
                {
                    y += 4;
                    var sep = new Panel { Location = new Point(12, y), Size = new Size(276, 1), BackColor = Color.FromArgb(60, 60, 56) };
                    Controls.Add(sep);
                    y += 8;
                }
                first = false;

                y = AddProgressBar($"{name}: {pct}%", pct, y);
                if (!string.IsNullOrEmpty(reset))
                {
                    var rl = MakeLabel($"Resets {reset}", 12, y, 276, Color.FromArgb(140, 130, 120), 7.5f);
                    Controls.Add(rl);
                    y += 16;
                }
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
