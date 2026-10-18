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
    private readonly Button _recordButton = ClassroomStyle.Button("开始留言", true);
    private readonly TextBlock _status = ClassroomStyle.Caption("");
    private readonly TextBlock _duration = ClassroomStyle.Text("最长 30 秒", 16, true);
    private readonly TextBlock _connection = ClassroomStyle.Text("正在连接…", 14);
    private readonly Border _connectionPill = new();
    private readonly TextBlock _className = ClassroomStyle.Title("");
    private readonly TextBlock _computerCaption = ClassroomStyle.Text("", 14, muted: true);
    private readonly TextBlock _readingStatus = ClassroomStyle.Caption("离线可用 · 联网后自动同步早读记录");
    private readonly ReceiverConfig _config;
    private readonly DispatcherTimer _timer;
    private WaveInEvent? _waveIn;
    private WaveFileWriter? _writer;
    private MemoryStream? _buffer;
    private DateTimeOffset _startedAt;
    private bool _recording, _sending, _closing;

    public StudentVoiceWindow(ReceiverConfig config, Func<byte[], Task> send, Func<Task>? openReading = null, Action? openSettings = null, Action? openAbout = null)
    {
        ClassroomStyle.Apply(this);
        _send = send; _config = config; Title = $"ICeClass 班伴 · {config.ClassName}";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 1000; Height = 760; MinWidth = 720; MinHeight = 520;
        SystemDecorations = SystemDecorations.Full; CanResize = true; ShowInTaskbar = true;
        DesktopStyle.KeepWindowInWorkingArea(this);
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = DesktopStyle.Brush("#F5F7FB");
        var root = new Grid { RowDefinitions = new RowDefinitions("Auto,*,Auto") };
        var toolbar = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto"), Margin = new Thickness(28, 10) };
        var brand = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,Auto") };
        brand.Children.Add(DesktopStyle.Logo(44));
        var brandText = new StackPanel { Spacing = 0, Margin = new Thickness(12, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center,
            Children = { ClassroomStyle.SectionTitle("ICeClass 班伴"), ClassroomStyle.Caption("教室端") } };
        Grid.SetColumn(brandText, 1); brand.Children.Add(brandText); toolbar.Children.Add(brand);
        var settings = ClassroomStyle.Button("教室设置"); settings.MinHeight = 44; settings.Click += (_, _) => openSettings?.Invoke();
        settings.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(settings, 2); toolbar.Children.Add(settings);
        root.Children.Add(new Border { Background = Brushes.White, BorderBrush = DesktopStyle.Brush("#E1E7EF"), BorderThickness = new Thickness(0, 0, 0, 1), Child = toolbar });

        var main = new StackPanel { Spacing = 16, MaxWidth = 1200, HorizontalAlignment = HorizontalAlignment.Stretch };
        var heading = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        _className.Text = config.ClassName;
        var classText = new StackPanel { Spacing = 4, Children = { _className } };
        heading.Children.Add(classText);
        _connectionPill.Margin = new Thickness(16, 0, 0, 0);
        _connectionPill.Padding = new Thickness(12, 6); _connectionPill.CornerRadius = new CornerRadius(10);
        _connectionPill.VerticalAlignment = VerticalAlignment.Center; _connectionPill.Child = _connection;
        Grid.SetColumn(_connectionPill, 1); heading.Children.Add(_connectionPill); main.Children.Add(heading);
        SetBinding(config);

        var reading = ClassroomStyle.Button("打开早读陪伴", true); reading.MinHeight = 48;
        reading.Click += async (_, _) =>
        {
            if (openReading is null) return; reading.IsEnabled = false; reading.Content = "正在打开…";
            try { await openReading(); _readingStatus.Text = "时段内的活动计入本班记录，联网后同步。"; }
            catch (Exception error) { _readingStatus.Text = $"暂时无法打开：{error.Message}"; }
            finally { reading.IsEnabled = true; reading.Content = "打开早读陪伴"; }
        };
        _recordButton.MinHeight = 48; _recordButton.Click += RecordButtonClicked;
        _status.Text = "再次点击即可结束录音并发送。";
        _duration.Foreground = DesktopStyle.Brush("#36516E");
        var activities = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*"), RowDefinitions = new RowDefinitions("Auto,Auto") };
        var activityNames = new[] { "兔拔萝卜", "诗词镌刻", "粒子浮雕", "火箭升空" };
        for (var i = 0; i < activityNames.Length; i++)
        {
            var name = ClassroomStyle.Text(activityNames[i], 15);
            var item = new Border { Background = Brushes.White, CornerRadius = new CornerRadius(7), Padding = new Thickness(10, 6),
                Margin = new Thickness(i % 2 == 0 ? 0 : 4, i < 2 ? 0 : 8, i % 2 == 0 ? 4 : 0, 0), Child = name };
            Grid.SetColumn(item, i % 2); Grid.SetRow(item, i / 2); activities.Children.Add(item);
        }
        var recordInfo = new StackPanel { Spacing = 5, Children = { _duration,
            ClassroomStyle.Caption("仅本班授权教师可收听"), ClassroomStyle.Caption("联网发送 · 最长保留 30 分钟") } };
        var cards = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*"), RowDefinitions = new RowDefinitions("Auto,Auto") };
        Grid.SetIsSharedSizeScope(cards, true);
        Border FeatureCard(string icon, string title, string description, Control detail, TextBlock status, Button action)
        {
            var layout = new Grid { RowDefinitions = new RowDefinitions("Auto,Auto,Auto,*,Auto") };
            // Keep both actions on the card's bottom edge when an error wraps.
            // The flexible status row absorbs the difference between captions.
            for (var row = 0; row < 3; row++) layout.RowDefinitions[row].SharedSizeGroup = "Feature" + row;
            var header = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*"), Margin = new Thickness(0, 0, 0, 10) };
            header.Children.Add(ClassroomStyle.IconBadge(icon));
            var label = ClassroomStyle.SectionTitle(title); label.VerticalAlignment = VerticalAlignment.Center; label.Margin = new Thickness(12, 0, 0, 0);
            Grid.SetColumn(label, 1); header.Children.Add(label); layout.Children.Add(header);
            var descriptionBlock = ClassroomStyle.Text(description, 15, muted: true); descriptionBlock.Margin = new Thickness(0, 0, 0, 12);
            Grid.SetRow(descriptionBlock, 1); layout.Children.Add(descriptionBlock);
            var detailBox = new Border { MinHeight = 96, Background = DesktopStyle.Brush("#F4F7FC"), CornerRadius = new CornerRadius(10),
                Padding = new Thickness(12, 8), Child = detail, Margin = new Thickness(0, 0, 0, 10) };
            detail.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetRow(detailBox, 2); layout.Children.Add(detailBox);
            status.MinHeight = 34; status.Margin = new Thickness(0, 0, 0, 8); status.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetRow(status, 3); layout.Children.Add(status);
            Grid.SetRow(action, 4); layout.Children.Add(action);
            return ClassroomStyle.Card(layout);
        }
        var readingCard = FeatureCard("book-open", "早读陪伴", "选择喜欢的活动，让朗读更有趣。", activities, _readingStatus, reading);
        var voiceCard = FeatureCard("mic", "给老师留言", "录下想说的话，发送给本班老师。", recordInfo, _status, _recordButton);
        cards.Children.Add(readingCard); Grid.SetColumn(voiceCard, 1); cards.Children.Add(voiceCard); main.Children.Add(cards);
        main.Children.Add(ClassroomStyle.Caption("早读全屏时，长按空白处 2 秒即可退出全屏。"));
        void ArrangeCards()
        {
            var stacked = Bounds.Width < 900;
            cards.ColumnDefinitions = new ColumnDefinitions(stacked ? "*" : "*,*");
            Grid.SetColumn(voiceCard, stacked ? 0 : 1); Grid.SetRow(voiceCard, stacked ? 1 : 0);
            readingCard.Margin = stacked ? new Thickness(0, 0, 0, 16) : new Thickness(0, 0, 12, 0);
            voiceCard.Margin = stacked ? new Thickness(0) : new Thickness(12, 0, 0, 0);
        }
        SizeChanged += (_, _) => ArrangeCards(); ArrangeCards();
        var scroll = new ScrollViewer { Content = new Border { Padding = new Thickness(28, 20), Child = main }, HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled };
        Grid.SetRow(scroll, 1); root.Children.Add(scroll);
        var footer = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto"), Margin = new Thickness(28, 6) };
        _computerCaption.VerticalAlignment = VerticalAlignment.Center;
        _computerCaption.MaxLines = 2; _computerCaption.TextTrimming = TextTrimming.CharacterEllipsis;
        footer.Children.Add(_computerCaption);
        var about = ClassroomStyle.Button($"关于 · {ReceiverUpdateService.CurrentVersionText}");
        about.Padding = new Thickness(12, 6); about.Classes.Add("native-quiet");
        about.Margin = new Thickness(16, 0, 0, 0); about.Click += (_, _) => openAbout?.Invoke();
        Grid.SetColumn(about, 1); footer.Children.Add(about);
        var footerBox = new Border { Background = Brushes.White, BorderBrush = DesktopStyle.Brush("#E1E7EF"), BorderThickness = new Thickness(0, 1, 0, 0), Child = footer };
        Grid.SetRow(footerBox, 2); root.Children.Add(footerBox); Content = root;
        _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
        _timer.Tick += (_, _) => { var elapsed = (DateTimeOffset.Now - _startedAt).TotalSeconds; _duration.Text = $"{elapsed:0.0} / 30.0 秒"; if (elapsed >= 30) FinishRecording(); };
        SetConnectionState(new ReceiverConnectionState(false, "正在连接…"));
        Closed += (_, _) => { _closing = true; StopRecorder(); };
    }
    public void SetBinding(ReceiverConfig binding)
    {
        if (_config.ClassId != binding.ClassId && _recording) { StopRecorder(); Reset("班级归属已更新，请重新开始留言。"); }
        _config.ClassId = binding.ClassId; _config.ClassName = binding.ClassName; _config.DeviceName = binding.DeviceName;
        Title = $"ICeClass 班伴 · {binding.ClassName}"; _className.Text = binding.ClassName;
        _computerCaption.Text = $"{binding.DeviceName} · 设备编号 {ComputerIdentity.DeviceCode(binding.DeviceId)}";
        ToolTip.SetTip(_computerCaption, $"关闭窗口后收起到托盘，仍会在后台接收通知。\n电脑名称：{Environment.MachineName}\n设备完整编号：{binding.DeviceId}\n局域网：{string.Join("、", ComputerIdentity.LocalAddresses())}");
    }
    public void MinimizeToTray()
    {
        if (_recording) { StopRecorder(); Reset("录音已取消。需要留言时，请重新点击开始。"); }
        WindowState = WindowState.Minimized; Hide();
    }
    public void SetConnectionState(ReceiverConnectionState state)
    {
        _connection.Text = state.Connected ? "已连接平台" : state.Text;
        _connection.MaxWidth = 170;
        _connection.Foreground = DesktopStyle.Brush(state.Connected ? "#35795B" : "#97591B");
        _connectionPill.Background = DesktopStyle.Brush(state.Connected ? "#EAF3EE" : "#FFF2DF");
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
            _recordButton.Content = "结束并发送";
            _recordButton.Classes.Add("classroom-recording");
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
        _recordButton.Content = "开始留言";
        _recordButton.Classes.Remove("classroom-recording");
        _duration.Text = "最长 30 秒";
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
