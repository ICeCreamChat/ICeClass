using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using NAudio.Wave;

namespace ICeClass.Receiver;

/// <summary>Classroom home with early reading and class-scoped teacher voice messages.</summary>
public sealed class StudentVoiceWindow : Window
{
    private readonly Func<byte[], Task> _send;
    private readonly Button _recordButton = DesktopStyle.Button("开始语音留言");
    private readonly TextBlock _status = DesktopStyle.Text("", 15, muted: true);
    private readonly TextBlock _duration = DesktopStyle.Text("", 15);
    private readonly TextBlock _connection = DesktopStyle.Text("正在连接…", 14);
    private readonly Border _connectionPill = new();
    private readonly TextBlock _className = DesktopStyle.Text("", 30, true);
    private readonly TextBlock _computerCaption = DesktopStyle.Text("", 14, muted: true);
    private readonly ReceiverConfig _config;
    private readonly DispatcherTimer _timer;
    private WaveInEvent? _waveIn;
    private WaveFileWriter? _writer;
    private MemoryStream? _buffer;
    private DateTimeOffset _startedAt;
    private bool _recording, _sending, _closing;

    public StudentVoiceWindow(ReceiverConfig config, Func<byte[], Task> send, Func<Task>? openReading = null, Action? openSettings = null)
    {
        _send = send; _config = config; Title = $"班伴 · {config.ClassName}";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 1000; Height = 760; MinWidth = 780; MinHeight = 520;
        SystemDecorations = SystemDecorations.Full; CanResize = true; ShowInTaskbar = true;
        DesktopStyle.KeepWindowInWorkingArea(this);
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = DesktopStyle.Brush("#F5F5F7");
        var root = new Grid { ColumnDefinitions = new ColumnDefinitions("220,*") };
        var sidebar = new Grid { RowDefinitions = new RowDefinitions("Auto,Auto,*,Auto") };
        var brand = new StackPanel { Spacing = 10, Children = { DesktopStyle.Logo(82), DesktopStyle.Text("班伴", 28, true), DesktopStyle.Text("教室陪伴空间", 15, muted: true) } };
        sidebar.Children.Add(brand);
        var selected = new Border { Margin = new Thickness(0, 26, 0, 0), Background = DesktopStyle.Brush("#DCEAFD"), CornerRadius = new CornerRadius(12), Padding = new Thickness(16, 13), Child = DesktopStyle.Text("教室首页", 17, true) };
        Grid.SetRow(selected, 1); sidebar.Children.Add(selected);
        var bottom = new StackPanel { Spacing = 14 };
        var settings = DesktopStyle.Button("教室设置"); settings.Click += (_, _) => openSettings?.Invoke();
        bottom.Children.Add(settings); bottom.Children.Add(DesktopStyle.Text("关闭窗口后，班伴仍会在后台接收通知。", 14, muted: true));
        bottom.Children.Add(DesktopStyle.Text($"ICeClass {ReceiverUpdateService.CurrentVersionText}", 14, muted: true));
        Grid.SetRow(bottom, 3); sidebar.Children.Add(bottom);
        root.Children.Add(new Border { Background = DesktopStyle.Brush("#EEF0F3"), BorderBrush = DesktopStyle.Brush("#DFE1E6"), BorderThickness = new Thickness(0, 0, 1, 0), Padding = new Thickness(24, 30), Child = sidebar });

        var main = new StackPanel { Spacing = 22 };
        var heading = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        _connectionPill.Margin = new Thickness(12, 0, 0, 0);
        _className.Text = config.ClassName;
        var classText = new StackPanel { Spacing = 4, Children = { DesktopStyle.Text("今天，也陪班级走一程。", 15, muted: true), _className } };
        heading.Children.Add(classText);
        _connectionPill.Padding = new Thickness(12, 8); _connectionPill.CornerRadius = new CornerRadius(10); _connectionPill.VerticalAlignment = VerticalAlignment.Center; _connectionPill.Child = _connection;
        Grid.SetColumn(_connectionPill, 1); heading.Children.Add(_connectionPill); main.Children.Add(heading);
        main.Children.Add(_computerCaption);
        SetBinding(config);

        var reading = DesktopStyle.Button("开始早读陪伴  →", true); reading.MinHeight = 60; reading.FontSize = 20;
        reading.Click += async (_, _) =>
        {
            if (openReading is null) return; reading.IsEnabled = false; reading.Content = "正在打开…";
            try { await openReading(); _status.Text = "早读陪伴已打开，统计时段内的活动自动归到本班。"; }
            catch (Exception error) { _status.Text = error.Message; }
            finally { reading.IsEnabled = true; reading.Content = "开始早读陪伴  →"; }
        };
        var morning = new StackPanel { Spacing = 12, Children = { DesktopStyle.Text("让朗读，变成看得见的成长。", 24, true), DesktopStyle.Text("自由选择陪伴模式，用声音完成今天的小目标。", 16, muted: true), reading, DesktopStyle.Text("全屏后，长按屏幕空白处 2 秒即可退出全屏。", 14, muted: true) } };
        main.Children.Add(DesktopStyle.Card(morning));

        _recordButton.MinHeight = 54; _recordButton.FontSize = 18; _recordButton.Click += RecordButtonClicked;
        _status.Text = "点击开始，再次点击结束并发送。最长 30 秒。";
        _duration.Foreground = DesktopStyle.Blue;
        var voice = new StackPanel { Spacing = 12, Children = { DesktopStyle.Text("有话，告诉老师。", 22, true), DesktopStyle.Text("语音留言发送给本班授权教师，不在教室播放。", 16, muted: true), _recordButton, _duration, _status } };
        main.Children.Add(DesktopStyle.Card(voice));
        var scroll = new ScrollViewer { Content = new Border { Padding = new Thickness(30), Child = main }, HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled };
        Grid.SetColumn(scroll, 1); root.Children.Add(scroll); Content = root;
        _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
        _timer.Tick += (_, _) => { var elapsed = (DateTimeOffset.Now - _startedAt).TotalSeconds; _duration.Text = $"{elapsed:0.0} / 30.0 秒"; if (elapsed >= 30) FinishRecording(); };
        SetConnectionState(new ReceiverConnectionState(false, "正在连接…"));
        Closed += (_, _) => { _closing = true; StopRecorder(); };
    }
    public void SetBinding(ReceiverConfig binding)
    {
        if (_config.ClassId != binding.ClassId && _recording) { StopRecorder(); Reset("班级归属已更新，请重新开始留言。"); }
        _config.ClassId = binding.ClassId; _config.ClassName = binding.ClassName; _config.DeviceName = binding.DeviceName;
        Title = $"班伴 · {binding.ClassName}"; _className.Text = binding.ClassName;
        _computerCaption.Text = $"{binding.DeviceName} · {Environment.MachineName}\n设备编号 {ComputerIdentity.DeviceCode(binding.DeviceId)}";
        ToolTip.SetTip(_computerCaption, $"设备完整编号：{binding.DeviceId}\n局域网：{string.Join("、", ComputerIdentity.LocalAddresses())}");
    }
    public void MinimizeToTray()
    {
        if (_recording) { StopRecorder(); Reset("录音已取消。需要留言时，请重新点击开始。"); }
        WindowState = WindowState.Minimized; Hide();
    }
    public void SetConnectionState(ReceiverConnectionState state)
    {
        _connection.Text = state.Connected ? "● 已连接教室" : state.Text;
        _connection.MaxWidth = 170;
        _connection.Foreground = DesktopStyle.Brush(state.Connected ? "#176642" : "#97591B");
        _connectionPill.Background = DesktopStyle.Brush(state.Connected ? "#E7F3EB" : "#FFF2DF");
    }
    private void RecordButtonClicked(object? sender, Avalonia.Interactivity.RoutedEventArgs args)
    {
        if (_sending) return;
        if (_recording) FinishRecording();
        else StartRecording();
    }

    private void StartRecording()
    {
        try
        {
            if (WaveInEvent.DeviceCount <= 0) throw new InvalidOperationException("没有检测到可用麦克风，请检查 Windows 麦克风连接和权限。");
            _buffer = new MemoryStream();
            _writer = new WaveFileWriter(_buffer, new WaveFormat(16_000, 16, 1));
            _waveIn = new WaveInEvent { WaveFormat = new WaveFormat(16_000, 16, 1), BufferMilliseconds = 50 };
            _waveIn.DataAvailable += (_, args) => _writer?.Write(args.Buffer, 0, args.BytesRecorded);
            _waveIn.RecordingStopped += (source, _) => Dispatcher.UIThread.Post(() => { if (ReferenceEquals(source, _waveIn)) RecordingStopped(); });
            _waveIn.StartRecording();
            _recording = true;
            _startedAt = DateTimeOffset.Now;
            _timer.Start();
            _recordButton.Content = "点击结束并发送";
            _recordButton.Background = new SolidColorBrush(Color.Parse("#C92A2A"));
            _status.Text = "正在录音…再次点击按钮结束并发送。";
        }
        catch (Exception exception)
        {
            StopRecorder();
            _status.Text = $"无法使用麦克风：{exception.Message}";
            AppLog.Error("Student voice recording failed", exception);
        }
    }

    private void FinishRecording()
    {
        if (!_recording) return;
        _recording = false;
        _timer.Stop();
        _recordButton.IsEnabled = false;
        _recordButton.Content = "正在发送…";
        _status.Text = "正在发送给本班教师，请稍候…";
        _waveIn?.StopRecording();
    }

    private async void RecordingStopped()
    {
        if (_closing) return;
        var writer = _writer;
        var buffer = _buffer;
        _writer = null;
        _buffer = null;
        _waveIn?.Dispose();
        _waveIn = null;
        writer?.Dispose();
        var bytes = buffer?.ToArray() ?? Array.Empty<byte>();
        buffer?.Dispose();
        if (bytes.Length < 44)
        {
            Reset("录音太短，请至少录音 0.5 秒。");
            return;
        }
        _sending = true;
        try
        {
            await _send(bytes);
            Reset("已发送给本班教师。可以再次点击开始录音。", true);
        }
        catch (Exception exception)
        {
            AppLog.Error("Student voice upload failed", exception);
            Reset($"发送失败：{exception.Message}");
        }
        finally { _sending = false; }
    }

    private void Reset(string text, bool success = false)
    {
        _recordButton.IsEnabled = true;
        _recordButton.Content = "开始语音留言";
        _recordButton.Background = new SolidColorBrush(Color.Parse("#0071E3"));
        _duration.Text = "";
        _status.Text = text;
        _status.Foreground = new SolidColorBrush(Color.Parse(success ? "#14804A" : "#6E6E73"));
    }

    private void StopRecorder()
    {
        _timer.Stop();
        try { _waveIn?.StopRecording(); } catch { }
        _waveIn?.Dispose();
        _waveIn = null;
        _writer?.Dispose();
        _writer = null;
        _buffer?.Dispose();
        _buffer = null;
        _recording = false;
    }
}
