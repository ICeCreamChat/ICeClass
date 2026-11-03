using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using ICeClass.Diagnostics;

namespace ICeClass.Receiver;

internal sealed class AboutDiagnosticsView : Grid
{
    private readonly Func<CancellationToken, Task<string>> _collect;
    private readonly Func<string, CancellationToken, Task<string>>? _submit;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly TextBox _text = new()
    {
        IsReadOnly = true, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap,
        VerticalContentAlignment = VerticalAlignment.Top, FontSize = 13,
        FontFamily = new FontFamily("Microsoft YaHei UI, Microsoft YaHei, Segoe UI")
    };
    private readonly TextBlock _status = DesktopStyle.Text("选择此页后读取本机记录。", 13, muted: true);
    private readonly Button _refresh = DesktopStyle.Button("刷新日志");
    private readonly Button _copy = DesktopStyle.Button("复制日志");
    private readonly Button _export = DesktopStyle.Button("导出诊断包");
    private readonly Button _upload = DesktopStyle.Button("提交诊断", true);
    private readonly string _edition, _version;
    private bool _busy, _disposed;
    private string _report = "";

    internal AboutDiagnosticsView(string edition, string version, Func<CancellationToken, Task<string>> collect,
        Func<string, CancellationToken, Task<string>>? submit = null)
    {
        _collect = collect; _submit = submit; _edition = edition; _version = version;
        RowDefinitions = new RowDefinitions("Auto,12,*,10,Auto");
        var actions = new WrapPanel { Orientation = Orientation.Horizontal };
        foreach (var button in new[] { _refresh, _copy, _export, _upload })
        { button.Margin = new Thickness(0, 0, 8, 0); actions.Children.Add(button); }
        Children.Add(actions);
        AutomationProperties.SetName(_text, "本机诊断日志，可选择并复制");
        AutomationProperties.SetName(_status, "诊断日志状态");
        AutomationProperties.SetLiveSetting(_status, AutomationLiveSetting.Polite);
        Grid.SetRow(_text, 2); Children.Add(_text);
        var footer = new StackPanel { Spacing = 4, Children = { _status,
            DesktopStyle.Text("错误会自动上报；提交会将本页脱敏日志发给学校平台管理员。导出另含更新记录。", 13, muted: true) } };
        Grid.SetRow(footer, 4); Children.Add(footer);
        _refresh.Click += async (_, _) => await RefreshAsync();
        _copy.Click += async (_, _) => await CopyAsync();
        _export.Click += async (_, _) => await ExportAsync();
        _upload.Click += async (_, _) => await SubmitAsync();
        SetBusy(false);
    }

    internal void SetActive(bool active)
    {
        if (active && _report.Length == 0 && !_busy && !_disposed) _ = RefreshAsync();
    }

    internal async Task RefreshAsync()
    {
        if (_busy || _disposed) return;
        SetBusy(true); _status.Text = "正在读取本机日志…";
        try
        {
            var report = SupportDiagnostics.Redact(await _collect(_lifetime.Token));
            if (_disposed) return;
            _report = report; _text.Text = report;
            _status.Text = $"已读取 · {DateTimeOffset.Now:HH:mm:ss}";
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch { if (!_disposed) _status.Text = "读取失败，请点击“刷新日志”重试。"; }
        finally { if (!_disposed) SetBusy(false); }
    }

    private async Task CopyAsync()
    {
        if (_busy || _disposed || _report.Length == 0) return;
        try
        {
            if (TopLevel.GetTopLevel(this)?.Clipboard is not { } clipboard)
            { _status.Text = "剪贴板暂不可用，请导出诊断包。"; return; }
            await clipboard.SetTextAsync(_report);
            if (!_disposed) _status.Text = "日志已复制。";
        }
        catch { if (!_disposed) _status.Text = "复制失败，请导出诊断包。"; }
    }

    private async Task ExportAsync()
    {
        if (_busy || _disposed || _report.Length == 0) return;
        var token = _lifetime.Token;
        SetBusy(true);
        try
        {
            if (TopLevel.GetTopLevel(this)?.StorageProvider is not { CanSave: true } storage)
            { _status.Text = "当前系统无法选择保存位置，请复制日志。"; return; }
            var file = await storage.SaveFilePickerAsync(new FilePickerSaveOptions
            {
                Title = "导出诊断包", DefaultExtension = "zip",
                SuggestedFileName = $"ICeClass-{_edition}-{_version}-诊断-{DateTimeOffset.Now:yyyyMMdd-HHmmss}.zip",
                FileTypeChoices = [new FilePickerFileType("ZIP 诊断包") { Patterns = ["*.zip"] }]
            });
            if (file is null || _disposed) return;
            if (file.TryGetLocalPath() is not { } path)
            { _status.Text = "请选择本机文件夹保存诊断包。"; return; }
            _status.Text = "正在导出诊断包…";
            await Task.Run(() => SupportDiagnostics.SaveArchiveAsync(path, _report, AboutReleaseNotes.Text, token), token);
            if (!_disposed) _status.Text = "诊断包已导出，可以将 ZIP 文件发给维护人员。";
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch { if (!_disposed) _status.Text = "导出失败，请换一个保存位置重试。"; }
        finally { if (!_disposed) SetBusy(false); }
    }

    private void SetBusy(bool busy)
    {
        _busy = busy; _refresh.IsEnabled = !busy;
        _copy.IsEnabled = _export.IsEnabled = !busy && _report.Length > 0;
        _upload.IsEnabled = !busy && _report.Length > 0 && _submit is not null;
    }

    private async Task SubmitAsync()
    {
        if (_busy || _disposed || _report.Length == 0 || _submit is null) return;
        SetBusy(true); _status.Text = "正在提交诊断…";
        try
        {
            var id = await _submit(_report, _lifetime.Token);
            if (!_disposed) _status.Text = "已提交，诊断编号：" + id;
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (!_disposed) _status.Text = error is InvalidOperationException or InvalidDataException ? error.Message : "提交失败，请稍后重试或导出诊断包。";
        }
        finally { if (!_disposed) SetBusy(false); }
    }

    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e)
    {
        _disposed = true; _lifetime.Cancel(); _lifetime.Dispose();
        base.OnDetachedFromVisualTree(e);
    }
}
