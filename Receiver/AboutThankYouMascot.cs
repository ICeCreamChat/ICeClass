using System.Diagnostics;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;

namespace ICeClass.Receiver;

// A short, finite greeting. Hidden pages and closed/minimized windows do no animation work.
internal sealed class AboutThankYouMascot : Button
{
    private readonly BowArtwork _artwork = new();
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromMilliseconds(1000d / 30) };
    private readonly Stopwatch _playback = new();
    private Window? _owner;
    private bool _active;
    internal bool IsPlaying => _timer.IsEnabled;
    internal int CurrentFrame => _artwork.Frame;

    internal AboutThankYouMascot()
    {
        Content = _artwork;
        Width = 152; Height = 171;
        HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Center;
        HorizontalContentAlignment = Avalonia.Layout.HorizontalAlignment.Stretch;
        VerticalContentAlignment = Avalonia.Layout.VerticalAlignment.Stretch;
        Classes.Add("native-button"); Classes.Add("about-mascot");
        AutomationProperties.SetName(this, "班班鞠躬致谢，点击重播");
        ToolTip.SetTip(this, "点击班班，再鞠一躬");
        Click += (_, _) => Play();
        _timer.Tick += (_, _) => Advance();
        AttachedToVisualTree += (_, _) =>
        {
            _owner = TopLevel.GetTopLevel(this) as Window;
            if (_owner is not null) _owner.PropertyChanged += OwnerChanged;
            Play();
        };
        DetachedFromVisualTree += (_, _) =>
        {
            Stop();
            if (_owner is not null) _owner.PropertyChanged -= OwnerChanged;
            _owner = null;
        };
    }

    internal void SetActive(bool active)
    {
        if (_active == active) return;
        _active = active;
        if (active) Play(); else Stop();
    }

    private void OwnerChanged(object? sender, AvaloniaPropertyChangedEventArgs args)
    {
        if (args.Property != IsVisibleProperty && args.Property != Window.WindowStateProperty) return;
        if (_owner is { IsVisible: true, WindowState: not WindowState.Minimized }) Play(); else Stop();
    }

    private void Play()
    {
        Stop();
        if (!_active || _owner is not { IsVisible: true, WindowState: not WindowState.Minimized }
            || !DesktopStyle.AnimationsEnabled()) return;
        _playback.Restart(); _timer.Start();
    }

    private void Advance()
    {
        if (!_active || _owner is not { IsVisible: true, WindowState: not WindowState.Minimized }) { Stop(); return; }
        var seconds = _playback.Elapsed.TotalSeconds;
        if (seconds >= 2.4) { Stop(); return; }
        var progress = seconds switch {
            < .15 => 0, < 1 => (seconds - .15) / .85,
            < 1.35 => 1, < 2.2 => 1 - (seconds - 1.35) / .85, _ => 0
        };
        var eased = progress * progress * (3 - 2 * progress);
        _artwork.Frame = (int)Math.Round(eased * 7);
    }

    private void Stop()
    {
        _timer.Stop(); _playback.Reset(); _artwork.Frame = 0;
    }

    private sealed class BowArtwork : Control
    {
        private static readonly Lazy<Bitmap> Sprite = new(() =>
        {
            using var stream = typeof(AboutThankYouMascot).Assembly.GetManifestResourceStream("ICeClass.About.banban-bow.webp")
                ?? throw new InvalidOperationException("班班致谢动作资源缺失。");
            return new Bitmap(stream);
        });
        private int _frame;
        internal int Frame
        {
            get => _frame;
            set { if (_frame == value) return; _frame = value; InvalidateVisual(); }
        }
        public override void Render(DrawingContext context)
        {
            base.Render(context);
            var scale = Math.Min(Bounds.Width / 256, Bounds.Height / 288);
            var destination = new Rect((Bounds.Width - 256 * scale) / 2, (Bounds.Height - 288 * scale) / 2,
                256 * scale, 288 * scale);
            context.DrawImage(Sprite.Value, new Rect(_frame % 4 * 256, _frame / 4 * 288, 256, 288), destination);
        }
    }
}
