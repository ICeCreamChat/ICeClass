using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using NAudio.Wave;

namespace CloudRemoteShouter.Receiver;

/// <summary>Classroom-side voice message window. It uploads voice to the assigned class only.</summary>
public sealed class StudentVoiceWindow : Window
{
    private readonly Func<byte[], Task> _send;
    private readonly Button _recordButton = new();
    private readonly TextBlock _status = new();
    private readonly TextBlock _duration = new();
    private readonly DispatcherTimer _timer;
    private WaveInEvent? _waveIn;
    private WaveFileWriter? _writer;
    private MemoryStream? _buffer;
    private DateTimeOffset _startedAt;
    private bool _recording;
    private bool _sending;

    public StudentVoiceWindow(ReceiverConfig config, Func<byte[], Task> send)
    {
        _send = send;
        Title = $"向老师语音留言 · {config.ClassName}";
        Width = 520;
        Height = 330;
        MinWidth = 420;
        MinHeight = 280;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = new SolidColorBrush(Color.Parse("#F5F5F7"));
        CanResize = false;

        var title = new TextBlock
        {
            Text = "向老师语音留言",
            FontSize = 26,
            FontWeight = FontWeight.Bold,
            Foreground = new SolidColorBrush(Color.Parse("#1D1D1F")),
        };
        var note = new TextBlock
        {
            Text = $"当前班级：{config.ClassName}\n点击开始录音，再次点击结束并发送给本班授权教师。",
            TextWrapping = TextWrapping.Wrap,
            Foreground = new SolidColorBrush(Color.Parse("#6E6E73")),
            LineHeight = 23,
        };
        _recordButton.Content = "点击开始录音";
        _recordButton.Height = 92;
        _recordButton.FontSize = 24;
        _recordButton.FontWeight = FontWeight.SemiBold;
        _recordButton.Background = new SolidColorBrush(Color.Parse("#0071E3"));
        _recordButton.Foreground = Brushes.White;
        _recordButton.BorderBrush = Brushes.Transparent;
        _recordButton.Click += RecordButtonClicked;
        _status.Text = "点击开始录音，再次点击结束并发送；最长 30 秒。发送后不会在教室端播放。";
        _status.Foreground = new SolidColorBrush(Color.Parse("#6E6E73"));
        _status.TextWrapping = TextWrapping.Wrap;
        _duration.Text = "";
        _duration.Foreground = new SolidColorBrush(Color.Parse("#0071E3"));
        _duration.HorizontalAlignment = HorizontalAlignment.Right;

        var footer = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        Grid.SetColumn(_status, 0);
        Grid.SetColumn(_duration, 1);
        footer.Children.Add(_status);
        footer.Children.Add(_duration);

        _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
        _timer.Tick += (_, _) =>
        {
            var elapsed = (DateTimeOffset.Now - _startedAt).TotalSeconds;
            _duration.Text = $"{elapsed:0.0} / 30.0 秒";
            if (elapsed >= 30) FinishRecording();
        };

        Content = new Border
        {
            Background = Brushes.White,
            BorderBrush = new SolidColorBrush(Color.Parse("#D9D9DE")),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(28),
            Child = new StackPanel { Spacing = 16, Children = { title, note, _recordButton, footer } },
        };
        Closed += (_, _) => StopRecorder();
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
            _waveIn.RecordingStopped += (_, _) => Dispatcher.UIThread.Post(RecordingStopped);
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
        _recordButton.Content = "点击开始录音";
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
