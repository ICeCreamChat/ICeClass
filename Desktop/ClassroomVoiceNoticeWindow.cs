using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using ICeClass.Receiver;
using NAudio.Wave;

namespace ICeClass.Desktop;

internal sealed class ClassroomVoiceNoticeWindow : Window
{
    private readonly ClassroomVoiceInbox _inbox;
    private readonly Window _anchor;
    private readonly int _accountVersion;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly List<ClassroomVoiceMessage> _messages = [];
    private readonly Dictionary<string, string> _transcripts = [];
    private readonly TextBlock _class = DesktopStyle.Text("", 20, true);
    private readonly TextBlock _time = DesktopStyle.Text("", 13, muted: true);
    private readonly TextBlock _duration = DesktopStyle.Text("", 14, true);
    private readonly TextBlock _status = DesktopStyle.Text("", 13, muted: true);
    private readonly TextBlock _position = DesktopStyle.Text("", 13, muted: true);
    private readonly Button _listen = Dialogs.Button("收听", true);
    private readonly Button _previous = Dialogs.Button("上一条");
    private readonly Button _next = Dialogs.Button("下一条");
    private readonly Button _transcribe = Dialogs.Button("转文字");
    private readonly Button _download = Dialogs.Button("下载并转文字");
    private readonly TextBlock _transcriptionStatus = DesktopStyle.Text("", 13, muted: true);
    private readonly SelectableTextBlock _transcript = new() { FontSize = 14, TextWrapping = TextWrapping.Wrap,
        Foreground = DesktopStyle.Ink, LineHeight = 23, Focusable = true };
    private readonly Border _transcriptionPanel;
    private readonly Grid _navigation;
    private readonly DispatcherTimer _progress = new() { Interval = TimeSpan.FromMilliseconds(250) };
    private CancellationTokenSource? _transcriptionCancellation;
    private ClassroomVoiceMessage? _current;
    private int _messageIndex;
    private byte[]? _audio;
    private WaveOutEvent? _output;
    private WaveFileReader? _reader;
    private bool _busy, _closed, _transcribing;

    internal ClassroomVoiceNoticeWindow(ClassroomVoiceInbox inbox, Window anchor)
    {
        _inbox = inbox; _anchor = anchor; _accountVersion = inbox.AccountVersion;
        Title = "ICeClass 班伴 · 教室来音";
        Width = 416; SizeToContent = SizeToContent.Height; CanResize = false;
        SystemDecorations = SystemDecorations.None; ShowInTaskbar = false; ShowActivated = false; Topmost = true;
        WindowStartupLocation = WindowStartupLocation.Manual;
        Background = Brushes.Transparent;
        TransparencyLevelHint = [WindowTransparencyLevel.Transparent];
        AutomationProperties.SetName(this, "教室来音提醒");
        var heading = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        var label = DesktopStyle.Text("教室来音", 14, true); label.Foreground = DesktopStyle.Brush("#424242");
        label.VerticalAlignment = _time.VerticalAlignment = VerticalAlignment.Center;
        heading.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8,
            Children = { label, _time } });
        var close = Dialogs.Button(""); close.Classes.Add("native-flyout-action");
        close.Width = close.Height = close.MinHeight = 28; close.Padding = new Thickness(0);
        close.HorizontalContentAlignment = HorizontalAlignment.Center;
        close.Content = new PathIcon { Width = 12, Height = 12,
            Data = Geometry.Parse("M1.4,0 L6,4.6 10.6,0 12,1.4 7.4,6 12,10.6 10.6,12 6,7.4 1.4,12 0,10.6 4.6,6 0,1.4 Z") };
        AutomationProperties.SetName(close, "关闭来音提醒"); ToolTip.SetTip(close, "关闭提醒");
        close.Click += (_, _) => Close(); Grid.SetColumn(close, 1); heading.Children.Add(close);
        foreach (var button in new[] { _previous, _next })
        {
            button.Classes.Add("native-flyout-action"); button.MinHeight = 28; button.Padding = new Thickness(8, 3);
            button.VerticalAlignment = VerticalAlignment.Center;
        }
        _previous.Click += (_, _) => MoveMessage(-1);
        _next.Click += (_, _) => MoveMessage(1);
        _position.VerticalAlignment = VerticalAlignment.Center;
        _navigation = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto,4,Auto") };
        _navigation.Children.Add(_position);
        Grid.SetColumn(_previous, 1); _navigation.Children.Add(_previous);
        Grid.SetColumn(_next, 3); _navigation.Children.Add(_next);
        _listen.Click += async (_, _) => await ListenAsync();
        _listen.MinHeight = _transcribe.MinHeight = 44;
        var actions = new Grid { ColumnDefinitions = new ColumnDefinitions("*,10,*") };
        actions.Children.Add(_transcribe); Grid.SetColumn(_listen, 2); actions.Children.Add(_listen);
        var audioIcon = new PathIcon { Width = 22, Height = 22, Foreground = DesktopStyle.Blue,
            Data = Geometry.Parse("M2,9 L5,9 9,5 9,19 5,15 2,15 Z M12,8 C16,10 16,14 12,16 L11,14 C13,13 13,11 11,10 Z M15,4 C23,8 23,16 15,20 L14,18 C20,15 20,9 14,6 Z") };
        var audioRow = new Grid { ColumnDefinitions = new ColumnDefinitions("24,8,*,Auto"), MinHeight = 24 };
        audioIcon.VerticalAlignment = VerticalAlignment.Center; audioRow.Children.Add(audioIcon);
        var audioLabel = DesktopStyle.Text("语音留言", 14, true); audioLabel.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(audioLabel, 2); audioRow.Children.Add(audioLabel);
        _duration.VerticalAlignment = VerticalAlignment.Center; _duration.Foreground = DesktopStyle.Brush("#41688F");
        Grid.SetColumn(_duration, 3); audioRow.Children.Add(_duration);
        var recording = new Border { Background = DesktopStyle.Brush("#0A0071E3"), CornerRadius = new CornerRadius(6),
            Padding = new Thickness(12), Child = audioRow };
        _class.LineHeight = 28;
        var source = new StackPanel { Spacing = 4, Children = { _class, _navigation } };
        _download.IsVisible = false; _download.MinHeight = 40;
        _download.Click += async (_, _) => await TranscribeAsync(download: true);
        _transcript.IsVisible = false;
        var transcriptBody = new StackPanel { Spacing = 6, Children = { _transcriptionStatus,
            new ScrollViewer { MaxHeight = 120, VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto, Content = _transcript }, _download } };
        _transcriptionPanel = new Border { IsVisible = false,
            BorderBrush = DesktopStyle.Brush("#10000000"), BorderThickness = new Thickness(0, 1, 0, 0),
            Padding = new Thickness(0, 8, 0, 0), Child = transcriptBody };
        _transcribe.Click += async (_, _) =>
        {
            if (_transcribing) { _transcriptionCancellation?.Cancel(); return; }
            if (_transcriptionPanel.IsVisible && (!string.IsNullOrEmpty(_transcript.Text) || _download.IsVisible))
            { _transcriptionPanel.IsVisible = false; _transcribe.Content = "转文字"; return; }
            if (!string.IsNullOrEmpty(_transcript.Text) || _download.IsVisible)
            { _transcriptionPanel.IsVisible = true; _transcribe.Content = "收起文字"; return; }
            await TranscribeAsync();
        };
        var content = new StackPanel { Spacing = 12, Children = { heading, source, recording, _status, actions, _transcriptionPanel } };
        Content = new Border { Classes = { "native-flyout-surface" },
            Margin = new Thickness(16, 12, 16, 20), Padding = new Thickness(18, 20, 18, 22),
            Child = new ScrollViewer { VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto, Content = content } };
        AutomationProperties.SetLiveSetting(_status, AutomationLiveSetting.Polite);
        AutomationProperties.SetLiveSetting(_transcriptionStatus, AutomationLiveSetting.Polite);
        AutomationProperties.SetName(_transcript, "语音识别结果");
        KeyDown += (_, args) => { if (args.Key == Key.Escape) { args.Handled = true; Close(); } };
        Opened += (_, _) => Place();
        SizeChanged += (_, _) => { if (IsVisible) Place(); };
        _progress.Tick += (_, _) =>
        {
            if (_reader is not null) SetStatus($"正在播放  {_reader.CurrentTime:m\\:ss} / {_reader.TotalTime:m\\:ss}");
        };
        Closed += (_, _) =>
        {
            _closed = true; _lifetime.Cancel(); ReleaseAudio(); _audio = null; _transcript.Text = ""; _lifetime.Dispose();
            _messages.Clear(); _transcripts.Clear(); _current = null;
            _inbox.DismissAll();
        };
        UpdateMessages();
    }

    internal void UpdateMessages()
    {
        if (_closed) return;
        if (_inbox.AccountVersion != _accountVersion) { Close(); return; }
        foreach (var message in _inbox.Pending)
        {
            if (_messages.All(item => item.Id != message.Id)) _messages.Add(message);
        }
        if (_current is null)
        {
            if (_messages.Count == 0) { Close(); return; }
            SelectMessage(0);
        }
        UpdateNavigation();
    }

    private void SelectMessage(int index)
    {
        ReleaseAudio(); _audio = null;
        _messageIndex = index; _current = _messages[index];
        _class.Text = _current.ClassName;
        var time = DateTimeOffset.FromUnixTimeMilliseconds(_current.CreatedAt).ToLocalTime();
        _time.Text = time.ToString("HH:mm");
        _duration.Text = $"{Math.Max(0, _current.DurationMs) / 1000d:0.#} 秒";
        SetStatus("");
        _listen.Content = "收听"; _listen.IsEnabled = true;
        _download.IsVisible = false; _transcribe.IsEnabled = true;
        _transcript.Text = _transcripts.GetValueOrDefault(_current.Id, "");
        _transcript.IsVisible = _transcriptionPanel.IsVisible = !string.IsNullOrEmpty(_transcript.Text);
        _transcriptionStatus.Foreground = DesktopStyle.Muted;
        _transcriptionStatus.Text = _transcript.IsVisible ? "识别结果，请以原音为准" : "";
        _transcribe.Content = _transcript.IsVisible ? "收起文字" : "转文字";
    }

    private void UpdateNavigation()
    {
        _navigation.IsVisible = _messages.Count > 1;
        _position.Text = $"{_messageIndex + 1} / {_messages.Count} 条留言";
        AutomationProperties.SetName(_position, $"第 {_messageIndex + 1} 条，共 {_messages.Count} 条留言");
        _previous.IsEnabled = !_busy && !_transcribing && _messageIndex > 0;
        _next.IsEnabled = !_busy && !_transcribing && _messageIndex < _messages.Count - 1;
    }

    private void Place()
    {
        var screen = Screens.ScreenFromWindow(_anchor) ?? Screens.Primary;
        if (screen is null) return;
        var work = screen.WorkingArea;
        var scale = screen.Scaling;
        Width = Math.Min(416, work.Width / scale - 24);
        MaxHeight = work.Height / scale - 16;
        var height = (int)Math.Ceiling(Bounds.Height * scale);
        Position = new PixelPoint(work.Right - (int)Math.Ceiling(Width * scale) - 8,
            Math.Max(work.Y, work.Bottom - height - 8));
    }

    private async Task ListenAsync()
    {
        if (_busy) { _output?.Stop(); return; }
        if (_current is not { } message || _closed || _transcribing) return;
        _busy = true; UpdateNavigation();
        _listen.IsEnabled = _transcribe.IsEnabled = false; _listen.Content = "正在加载…";
        SetStatus("正在加载语音…");
        try
        {
            await _inbox.EnsureCurrentAccountAsync(_accountVersion);
            _audio ??= await _inbox.ReadAudioAsync(message, _lifetime.Token);
            if (_closed) return;
            _reader = new WaveFileReader(new MemoryStream(_audio, writable: false));
            if (_reader.TotalTime.TotalSeconds is < .5 or > 30 || _reader.WaveFormat.Channels is < 1 or > 2)
                throw new InvalidDataException("语音格式不正确，请回工作台检查。");
            _output = new WaveOutEvent();
            var playback = _output;
            _output.PlaybackStopped += (_, args) => Dispatcher.UIThread.Post(() =>
            {
                if (_closed || _output != playback) return;
                ReleaseAudio(); _busy = false; _transcribe.IsEnabled = true;
                if (args.Exception is not null) { ShowPlaybackError("无法播放声音，请检查扬声器后重试。"); return; }
                _listen.Content = "重新收听"; _listen.IsEnabled = true;
                SetStatus("播放已结束");
                UpdateMessages();
            });
            _output.Init(_reader);
            _listen.Content = "停止播放"; _listen.IsEnabled = true;
            SetStatus("正在播放…");
            _progress.Start(); _output.Play();
        }
        catch (OperationCanceledException) when (_closed) { }
        catch (Exception error)
        {
            if (_closed) return;
            ReleaseAudio(); _busy = false; _transcribe.IsEnabled = true;
            ShowPlaybackError(error is InvalidOperationException or InvalidDataException ? error.Message
                : "语音暂时无法播放，请检查网络与扬声器后重试。");
        }
    }

    private void ShowPlaybackError(string message)
    {
        SetStatus(message, error: true);
        _listen.Content = "重试收听"; _listen.IsEnabled = true;
        UpdateMessages();
    }
    private void SetStatus(string text, bool error = false)
    {
        _status.Text = text; _status.IsVisible = text.Length > 0;
        _status.Foreground = error ? DesktopStyle.Brush("#AC3D32") : DesktopStyle.Muted;
    }
    private async Task TranscribeAsync(bool download = false)
    {
        if (_closed || _busy || _transcribing || _current is not { } message) return;
        _transcribing = true; UpdateNavigation(); _transcriptionPanel.IsVisible = true;
        _transcribe.Content = "取消转写"; _download.IsVisible = false; _listen.IsEnabled = false;
        SetStatus(""); _transcript.Text = ""; _transcript.IsVisible = false; _transcriptionStatus.Foreground = DesktopStyle.Muted;
        _transcriptionStatus.Text = "正在检查本机识别模型…";
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        _transcriptionCancellation = cancellation;
        try
        {
            await _inbox.EnsureCurrentAccountAsync(_accountVersion);
            if (download)
                await ClassroomVoiceTranscriber.EnsureModelsAsync(new Progress<int>(value =>
                {
                    if (!_closed && !cancellation.IsCancellationRequested)
                        _transcriptionStatus.Text = $"正在下载识别模型 {value}% · 仅首次需要";
                }), cancellation.Token);
            else if (!await ClassroomVoiceTranscriber.ModelsReadyAsync(cancellation.Token))
            {
                _transcriptionStatus.Text = "首次需下载约 230 MB 模型，以后可离线识别。语音只在本机处理，不会自动播放。";
                _download.IsVisible = true;
                return;
            }
            cancellation.Token.ThrowIfCancellationRequested();
            _transcriptionStatus.Text = "正在加载语音…";
            _audio ??= await _inbox.ReadAudioAsync(message, cancellation.Token);
            if (_closed) return;
            _transcriptionStatus.Text = "正在转文字…";
            var text = await ClassroomVoiceTranscriber.TranscribeAsync(_audio, cancellation.Token);
            if (_closed) return;
            await _inbox.EnsureCurrentAccountAsync(_accountVersion);
            if (_closed) return;
            _transcript.Text = text;
            _transcript.IsVisible = !string.IsNullOrWhiteSpace(text);
            if (_transcript.IsVisible) _transcripts[message.Id] = text;
            _transcriptionStatus.Text = string.IsNullOrWhiteSpace(text) ? "没有识别到清晰语音，可以收听原音或重试。" : "识别结果，请以原音为准";
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        { if (!_closed) _transcriptionStatus.Text = "已取消转文字"; }
        catch (Exception error)
        {
            if (_closed) return;
            _transcriptionStatus.Foreground = DesktopStyle.Brush("#AC3D32");
            _transcriptionStatus.Text = error is InvalidOperationException or InvalidDataException ? error.Message
                : "转文字未完成，请检查网络或稍后重试。仍可收听原音。";
            _download.IsVisible = download;
        }
        finally
        {
            _transcriptionCancellation = null; _transcribing = false;
            if (!_closed)
            {
                _listen.IsEnabled = true;
                _transcribe.Content = string.IsNullOrEmpty(_transcript.Text) && !_download.IsVisible ? "重试转文字" : "收起文字";
                UpdateMessages();
            }
        }
    }

    private void MoveMessage(int offset)
    {
        if (_closed || _busy || _transcribing) return;
        var index = _messageIndex + offset;
        if (index < 0 || index >= _messages.Count) return;
        SelectMessage(index); UpdateNavigation();
    }
    private void ReleaseAudio()
    {
        _progress.Stop();
        var output = _output; _output = null; output?.Dispose();
        _reader?.Dispose(); _reader = null;
    }
}
