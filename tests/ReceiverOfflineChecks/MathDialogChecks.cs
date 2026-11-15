using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal static class MathDialogChecks
{
    internal static void Run() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = CheckAsync()))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);
    private static async Task CheckAsync()
    {
        var desktop = (IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!;
        var count = 0;
        void Check(bool value, string label) { if (!value) throw new Exception(label); count++; Console.WriteLine("PASS " + label); }
        try
        {
            using var bitmap = new WriteableBitmap(new PixelSize(320, 180), new Vector(96, 96), PixelFormat.Bgra8888, AlphaFormat.Opaque);
            using var png = new MemoryStream(); bitmap.Save(png);
            var image = new ClassroomMathImage("data:image/png;base64," + Convert.ToBase64String(png.ToArray()), 320, 180, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            var selection = ClassroomMathDialogs.SelectQuestionAsync(image, CancellationToken.None);
            var window = desktop.Windows.Single();
            await Task.Delay(150);
            var fields = window.GetVisualDescendants().OfType<NumericUpDown>().ToArray();
            Check(fields.Length == 4 && fields[2].Value == 320 && fields[3].Value == 180, "question selection starts with the complete original image");
            fields[0].Value = 300; fields[1].Value = 170; fields[2].Value = 80;
            Check(fields[0].Value == 300 && fields[1].Value == 170 && fields[2].Value == 20 && fields[3].Value == 10, "numeric coordinates clamp the crop to original pixels");
            var surface = window.GetVisualDescendants().OfType<Control>().Single(control => control.GetType().Name == "QuestionSelectionSurface");
            surface.Focus();
            surface.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Left });
            surface.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Right, KeyModifiers = KeyModifiers.Shift });
            surface.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Up, KeyModifiers = KeyModifiers.Control });
            Check(fields[0].Value == 299 && fields[2].Value == 21 && fields[1].Value == 160, "keyboard movement and resize update original crop coordinates");
            foreach (var size in new[] { new Size(980, 720), new Size(620, 420) })
            {
                window.Width = size.Width; window.Height = size.Height; await Task.Delay(100);
                var buttons = window.GetVisualDescendants().OfType<Button>().Where(button => button.Content is string).ToArray();
                Check(buttons.All(button => button.TranslatePoint(default, window) is { } point && point.X >= 0 && point.Y >= 0 && point.X + button.Bounds.Width <= window.ClientSize.Width + 1 && point.Y + button.Bounds.Height <= window.ClientSize.Height + 1), "question actions remain inside " + size.Width + "px window");
                Check(surface.Bounds.Height > 20 && fields.All(field => field.Bounds.Width >= 80), "crop and coordinate controls remain usable at " + size.Width + "px");
            }
            var submit = window.GetVisualDescendants().OfType<Button>().Single(button => Equals(button.Content, "点评所选题目"));
            submit.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            var selected = await selection;
            Check(selected is { X: 299, Y: 160, Width: 21, Height: 10 }, "submit preserves the displayed crop exactly");
            using var cancelled = new CancellationTokenSource();
            var viewing = ClassroomMathDialogs.ShowQuestionAsync(image, cancelled.Token); cancelled.Cancel(); await viewing;
            Check(desktop.Windows.Count == 0, "review invalidation closes the retained question window");
            Console.WriteLine($"PASS {count} native math dialog checks");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally { foreach (var window in desktop.Windows.ToArray()) window.Close(); desktop.Shutdown(Environment.ExitCode); }
    }
}
