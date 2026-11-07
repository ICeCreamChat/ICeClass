using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using ICeClass.Receiver;

namespace ICeClass.Desktop;

internal sealed class TeacherFeedbackWindow : Window
{
    private readonly TeacherFeedbackClient _client;
    private readonly FeedbackAccount _account;
    private readonly Func<Task<FeedbackImage>> _capture;
    private readonly Func<string> _page;
    private readonly Func<CancellationToken, Task<string>> _collectLogs;
    private readonly DesktopDiagnostics? _diagnostics;
    private Task<string>? _logs;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly List<(FeedbackImage Image, Bitmap Preview)> _images = [];
    private readonly TextBox _description = new() { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, VerticalContentAlignment = VerticalAlignment.Top, MinHeight = 104, MaxHeight = 160, MaxLength = 2000, FontSize = 16, Watermark = "例如：收到教室来音后，点击收听没有声音…" };
    private readonly TextBox _contact = new() { MaxLength = 120, FontSize = 16, Watermark = "邮箱或其他联系方式…" };
    private readonly CheckBox _includeLogs = new() { Content = "附诊断日志", IsChecked = true, FontSize = 14 };
    private readonly WrapPanel _previews = new() { Orientation = Orientation.Horizontal };
    private readonly TextBlock _imageHint = DesktopStyle.Text("最多 3 张 · 单张 2 MB · 合计 3 MB", 12, muted: true);
    private readonly TextBlock _status = DesktopStyle.Text("", 13);
    private readonly Button _send = Dialogs.Button("发送反馈", true);
    private readonly Button _cancel = Dialogs.Button("取消");
    private readonly StackPanel _form;
    private bool _busy, _sent, _disposed;

    internal TeacherFeedbackWindow(TeacherFeedbackClient client, FeedbackAccount account,
        Func<Task<FeedbackImage>> capture, Func<string> page, Func<CancellationToken, Task<string>> collectLogs, DesktopDiagnostics? diagnostics = null)
    {
        _client = client; _account = account; _capture = capture; _page = page; _collectLogs = collectLogs;
        _diagnostics = diagnostics;
        Title = "使用反馈"; Width = 600; Height = 520; MinWidth = 450; MinHeight = 460;
        Background = Brushes.White; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        TeacherStyle.Apply(this);
        DesktopStyle.KeepWindowInWorkingArea(this);
        AutomationProperties.SetName(_description, "问题描述");
        AutomationProperties.SetName(_contact, "联系方式，选填");
        AutomationProperties.SetLiveSetting(_status, AutomationLiveSetting.Polite);
        _status.IsVisible = false;
        var previewLogs = SmallButton("预览日志");
        previewLogs.Click += async (_, _) =>
        {
            if (!previewLogs.IsEnabled) return;
            previewLogs.IsEnabled = false; previewLogs.Content = "正在读取…";
            try { await PreviewLogs(); }
            finally
            {
                if (!_disposed) { previewLogs.Content = "预览日志"; previewLogs.IsEnabled = true; }
            }
        };
        var logRow = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        logRow.Children.Add(_includeLogs); Grid.SetColumn(previewLogs, 1); logRow.Children.Add(previewLogs);
        var captureButton = SmallButton("截取页面"); var add = SmallButton("添加图片");
        captureButton.Click += async (_, _) => await Capture();
        add.Click += async (_, _) => await PickImages();
        var imageActions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { captureButton, add } };
        var imageHeader = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        var imageLabel = DesktopStyle.Text("截图", 14, true); imageLabel.VerticalAlignment = VerticalAlignment.Center;
        imageHeader.Children.Add(imageLabel); Grid.SetColumn(imageActions, 1); imageHeader.Children.Add(imageActions);
        _form = new StackPanel { Spacing = 14, Margin = new Thickness(24, 16), Children =
        {
            Field("问题描述", _description), Field("联系方式（选填）", _contact),
            new StackPanel { Spacing = 2, Children = { logRow, DesktopStyle.Text("最近 24 小时 · 仅含本机诊断 · 已隐藏登录凭据", 12, muted: true) } },
            new StackPanel { Spacing = 6, Children = { imageHeader, _imageHint, _previews } }
        } };
        var heading = new Grid { ColumnDefinitions = new ColumnDefinitions("*,16,Auto") };
        heading.Children.Add(DesktopStyle.Text("使用反馈", 20, true));
        var identity = DesktopStyle.Text(account.DisplayName, 13, muted: true);
        identity.VerticalAlignment = VerticalAlignment.Center; identity.MaxWidth = 260;
        identity.TextWrapping = TextWrapping.NoWrap; identity.TextTrimming = TextTrimming.CharacterEllipsis;
        ToolTip.SetTip(identity, account.DisplayName); Grid.SetColumn(identity, 2); heading.Children.Add(identity);
        var header = new Border { Classes = { "teacher-glass" }, Padding = new Thickness(24, 16), Background = Brushes.Transparent,
            BorderBrush = DesktopStyle.Brush("#E2E8F0"), BorderThickness = new Thickness(0, 0, 0, 1), Child = heading };
        var buttons = new Grid { ColumnDefinitions = new ColumnDefinitions("*,10,*") };
        buttons.Children.Add(_cancel); Grid.SetColumn(_send, 2); buttons.Children.Add(_send);
        var footer = DesktopStyle.DialogFooter(new StackPanel { Spacing = 8, Children = { _status, buttons } });
        var scroll = new ScrollViewer { Content = _form, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        var root = new Grid { RowDefinitions = new RowDefinitions("Auto,*,Auto") };
        root.Children.Add(header); Grid.SetRow(scroll, 1); root.Children.Add(scroll); Grid.SetRow(footer, 2); root.Children.Add(footer);
        Content = root;
        _send.Click += async (_, _) => { if (_sent) Close(); else await Send(); };
        _cancel.Click += (_, _) => Close();
        KeyDown += (_, args) => { if (args.Key == Key.Escape && !_busy) { args.Handled = true; Close(); } };
        Closing += (_, args) => { if (_busy) args.Cancel = true; };
        Closed += (_, _) => { _diagnostics?.Record("feedback", "关闭反馈", _page()); DisposeResources(); };
        Opened += (_, _) => _description.Focus();
    }

    private static StackPanel Field(string title, TextBox input)
    {
        var label = new Label { Content = title, Target = input, FontSize = 14, FontWeight = FontWeight.SemiBold,
            Foreground = DesktopStyle.Ink, Padding = new Thickness(0) };
        return new StackPanel { Spacing = 7, Children = { label, input } };
    }

    private static Button SmallButton(string text)
    {
        var button = Dialogs.Button(text); button.MinHeight = 34; button.FontSize = 13;
        button.Padding = new Thickness(12, 5); return button;
    }

    private void Status(string text, bool error = true)
    {
        _status.Text = text; _status.Foreground = DesktopStyle.Brush(error ? "#AC3D32" : "#247451");
        _status.IsVisible = text.Length > 0;
    }

    private async Task PreviewLogs()
    {
        try
        {
            _diagnostics?.Record("feedback", "预览日志", _page());
            var logs = await ReadLogs();
            if (_disposed) return;
            var window = Dialogs.Window("诊断日志预览", 620); window.CanResize = true;
            window.SizeToContent = SizeToContent.Manual; window.Height = 500; window.MinWidth = 380; window.MinHeight = 300;
            DesktopStyle.KeepWindowInWorkingArea(window);
            var text = new TextBox { Text = logs, IsReadOnly = true, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, VerticalContentAlignment = VerticalAlignment.Top, FontSize = 14 };
            AutomationProperties.SetName(text, "将发送的诊断日志");
            window.Content = new Grid { Margin = new Thickness(16), Children = { text } };
            await window.ShowDialog(this);
        }
        catch (OperationCanceledException) { }
        catch { if (!_disposed) Status("暂时无法读取诊断日志，请稍后重试。"); }
    }

    private Task<string> ReadLogs() => _logs ??= _collectLogs(_lifetime.Token);

    private async Task Capture()
    {
        if (_images.Count >= FeedbackImage.MaximumCount) { Status("最多附 3 张截图，请先移除一张。"); return; }
        try { _diagnostics?.Record("feedback", "截取页面", _page()); AddImage(await _capture()); }
        catch (Exception error) { if (!_disposed) Status(error is InvalidDataException ? error.Message : "暂时无法截取页面，可选择添加图片。"); }
    }

    private async Task PickImages()
    {
        if (_images.Count >= FeedbackImage.MaximumCount) { Status("最多附 3 张截图，请先移除一张。"); return; }
        try
        {
            _diagnostics?.Record("feedback", "添加图片", _page());
            var files = await StorageProvider.OpenFilePickerAsync(new Avalonia.Platform.Storage.FilePickerOpenOptions
            {
                Title = "添加反馈截图", AllowMultiple = true,
                FileTypeFilter = [new Avalonia.Platform.Storage.FilePickerFileType("图片") { Patterns = ["*.png", "*.jpg", "*.jpeg", "*.webp"] }]
            });
            foreach (var file in files)
            {
                if (_disposed) return;
                await using var source = await file.OpenReadAsync();
                using var bytes = new MemoryStream();
                var buffer = new byte[65536]; int count;
                while ((count = await source.ReadAsync(buffer, _lifetime.Token)) > 0)
                {
                    if (bytes.Length + count > FeedbackImage.MaximumBytes) throw new InvalidDataException("每张截图最多 2 MB，请缩小图片后添加。");
                    bytes.Write(buffer, 0, count);
                }
                AddImage(FeedbackImage.Create(file.Name, bytes.ToArray()));
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { if (!_disposed) Status(error is InvalidDataException ? error.Message : "图片暂时无法读取，请换一张重试。"); }
    }

    private void AddImage(FeedbackImage image)
    {
        if (_disposed) return;
        if (_images.Count >= FeedbackImage.MaximumCount || _images.Sum(item => (long)item.Image.Bytes.Length) + image.Bytes.Length > FeedbackImage.MaximumTotalBytes)
            throw new InvalidDataException("最多附 3 张截图，合计不超过 3 MB。");
        Bitmap preview;
        try { using var stream = new MemoryStream(image.Bytes); preview = Bitmap.DecodeToWidth(stream, 280); }
        catch { throw new InvalidDataException("图片内容无法识别，请换一张重试。"); }
        _images.Add((image, preview)); RenderImages(); Status("");
    }

    private void RenderImages()
    {
        _previews.Children.Clear();
        foreach (var item in _images.ToArray())
        {
            var number = _images.IndexOf(item) + 1;
            var view = new Button { Content = new Image { Source = item.Preview, Stretch = Stretch.Uniform, Height = 88 },
                Padding = new Thickness(4), HorizontalAlignment = HorizontalAlignment.Stretch };
            AutomationProperties.SetName(view, $"预览截图 {number}"); ToolTip.SetTip(view, "预览截图");
            view.Click += async (_, _) => await PreviewImage(item.Image);
            var remove = SmallButton("移除");
            AutomationProperties.SetName(remove, $"移除截图 {number}");
            remove.Click += (_, _) => { _images.Remove(item); RenderImages(); item.Preview.Dispose(); };
            _previews.Children.Add(new Border { Width = 156, Margin = new Thickness(0, 0, 10, 8),
                Child = new StackPanel { Spacing = 5, Children = { view, remove } } });
        }
        _imageHint.Text = _images.Count == 0 ? "最多 3 张 · 单张 2 MB · 合计 3 MB" : $"已附 {_images.Count}/3 张 · 合计 {_images.Sum(item => item.Image.Bytes.Length) / 1024} KB";
    }

    private async Task PreviewImage(FeedbackImage image)
    {
        try
        {
            using var stream = new MemoryStream(image.Bytes); using var bitmap = Bitmap.DecodeToWidth(stream, 1600);
            var window = Dialogs.Window("截图预览", 800); window.CanResize = true; window.SizeToContent = SizeToContent.Manual;
            window.Height = 600; window.MinWidth = 380; window.MinHeight = 300;
            DesktopStyle.KeepWindowInWorkingArea(window);
            window.Content = new Image { Source = bitmap, Stretch = Stretch.Uniform, Margin = new Thickness(12) };
            await window.ShowDialog(this);
        }
        catch { if (!_disposed) Status("暂时无法预览这张图片，请移除后重新添加。"); }
    }

    private async Task Send()
    {
        if (_busy || _disposed) return;
        _busy = true; _form.IsEnabled = false; _send.IsEnabled = false; _cancel.IsEnabled = false;
        _send.Content = "正在发送…"; Status("");
        _diagnostics?.Record("feedback", "发送反馈", _page(), $"附日志={_includeLogs.IsChecked == true}；截图={_images.Count}");
        try
        {
            var report = new FeedbackReport(_description.Text?.Trim() ?? "", _contact.Text?.Trim() ?? "",
                DesktopUpdates.CurrentVersion, $"{RuntimeInformation.OSDescription} / {RuntimeInformation.ProcessArchitecture}",
                $"{RenderScaling * 100:0}%", DateTimeOffset.Now.ToString("O"), _page());
            var logs = _includeLogs.IsChecked == true ? await ReadLogs() : null;
            await _client.SendAsync(_account, report, logs,
                _images.Select(item => item.Image).ToArray(), _lifetime.Token);
            if (_disposed) return;
            _sent = true; Status("反馈已发送，感谢帮助班伴改进。", false);
            _diagnostics?.Record("feedback", "发送成功", _page());
            _send.Content = "完成"; _cancel.IsVisible = false;
        }
        catch (OperationCanceledException) { if (!_disposed) Status("发送超时，填写内容已保留，请稍后重试。"); }
        catch (Exception error)
        {
            _diagnostics?.Record("feedback", "发送失败", _page(), error.GetType().Name);
            if (!_disposed) Status(error is InvalidOperationException or InvalidDataException ? error.Message : "暂时无法发送，填写内容已保留，请检查网络后重试。");
        }
        finally
        {
            _busy = false;
            if (!_disposed) { _form.IsEnabled = !_sent; _send.IsEnabled = true; _cancel.IsEnabled = true; if (!_sent) _send.Content = "发送反馈"; }
        }
    }

    internal void CloseWithOwner() { _busy = false; _lifetime.Cancel(); Close(); }

    private void DisposeResources()
    {
        if (_disposed) return; _disposed = true; _lifetime.Cancel();
        foreach (var image in _images) image.Preview.Dispose();
        _images.Clear(); _client.Dispose(); _lifetime.Dispose();
    }
}
