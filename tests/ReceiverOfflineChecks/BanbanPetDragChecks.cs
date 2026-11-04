using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Input;
using Avalonia.Input.Raw;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using ICeClass.Receiver;
using SkiaSharp;
using Pointer = Avalonia.Input.Pointer;

internal static class BanbanPetDragChecks
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static T Field<T>(object target, string name) => (T)target.GetType().GetField(name, Private)!.GetValue(target)!;
    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Review(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Review(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        BanbanPetWindow? pet = null;
        void Check(bool condition, string name)
        {
            if (!condition) throw new InvalidOperationException(name);
            checks.Add(name); Console.WriteLine("PASS " + name);
        }
        try
        {
            foreach (var size in new[] { 25, 100, 150 }) foreach (var side in new[] { Key.Left, Key.Right })
            {
                var talks = 0;
                pet = new BanbanPetWindow(() => { }, () => talks++, () => { }, _ => { },
                    Path.Combine(output, $"preferences-{size}-{side}.json")) { Opacity = 0 };
                pet.ShowPet(true); await Task.Delay(60);
                var mascot = Field<BanbanPetMascot>(pet, "_mascot"); mascot.Animate = false;
                Field<Slider>(pet, "_sizeSlider").Value = size;
                var talk = Field<Button>(pet, "_talk"); talk.Focus();
                talk.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = side });
                pet.UpdateLayout();
                var screen = pet.Screens.Primary!;
                var restWidth = pet.Width;
                using var pointer = new Pointer(Pointer.GetNextFreeId(), PointerType.Mouse, true);
                var down = new PointerPointProperties(RawInputModifiers.LeftMouseButton, PointerUpdateKind.LeftButtonPressed);
                var moving = new PointerPointProperties(RawInputModifiers.LeftMouseButton, PointerUpdateKind.Other);
                var up = new PointerPointProperties(RawInputModifiers.None, PointerUpdateKind.LeftButtonReleased);
                Point Center() => mascot.TranslatePoint(new Point(mascot.Bounds.Width / 2, mascot.Bounds.Height / 2), pet)!.Value;
                var start = new Point(side == Key.Right ? pet.Width - 12 : 12, pet.Height - 36 - 65 * size / 100d);
                var pointerStart = pet.PointToScreen(start);
                var characterStart = pet.PointToScreen(Center());
                talk.RaiseEvent(new PointerPressedEventArgs(talk, pointer, pet, start, 1, down, KeyModifiers.None));
                // Synthetic routed events do not pass through the platform mouse device.
                pointer.Capture(talk);
                var originalPosition = pet.Position;
                talk.RaiseEvent(new PointerEventArgs(InputElement.PointerMovedEvent, talk, pointer, pet,
                    pet.PointToClient(new PixelPoint(pointerStart.X + 1, pointerStart.Y)), 2, moving, KeyModifiers.None));
                Check(pet.Position == originalPosition && pet.Width == restWidth,
                    $"{side}/{size}% a tiny pointer movement preserves normal click behavior");
                var dx = (int)(screen.WorkingArea.Width * .19) * (side == Key.Right ? -1 : 1);
                var dy = -80;
                void Move(int x, int y, ulong time) => talk.RaiseEvent(new PointerEventArgs(InputElement.PointerMovedEvent,
                    talk, pointer, pet, pet.PointToClient(new PixelPoint(pointerStart.X + x, pointerStart.Y + y)), time, moving, KeyModifiers.None));
                Move(dx, dy, 3); await Task.Delay(50); pet.UpdateLayout();
                var bounds = new Rect(mascot.TranslatePoint(default, pet)!.Value, mascot.Bounds.Size);
                Check(bounds.Left >= 0 && bounds.Right <= pet.Width && bounds.Top >= 0 && bounds.Bottom <= pet.Height,
                    $"{side}/{size}% dragging out of the edge reveals the entire character inside its native canvas ({bounds}, {pet.ClientSize})");
                var character = pet.PointToScreen(Center());
                Check(Math.Abs(character.X - characterStart.X - dx) <= 1 && Math.Abs(character.Y - characterStart.Y - dy) <= 1,
                    $"{side}/{size}% expanding the canvas preserves the grabbed character position");
                foreach (var dpi in new[] { 96, 144, 192 })
                {
                    using var bitmap = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(pet.Width * dpi / 96),
                        (int)Math.Ceiling(pet.Height * dpi / 96)), new Vector(dpi, dpi));
                    bitmap.Render((Visual)pet.Content!); bitmap.Save(Path.Combine(output, $"drag-{side}-{size}-{dpi}.png"));
                    using var stream = new MemoryStream(); bitmap.Save(stream); stream.Position = 0;
                    using var pixels = SKBitmap.Decode(stream);
                    Check(Enumerable.Range(0, pixels.Height).All(y => pixels.GetPixel(0, y).Alpha < 10 && pixels.GetPixel(pixels.Width - 1, y).Alpha < 10),
                        $"{side}/{size}%/{dpi}dpi neither side of the dragged artwork is cut by the window");
                }
                Move(dx * 2, dy - 20, 4); await Task.Delay(30);
                var continued = pet.PointToScreen(Center());
                Check(Math.Abs(continued.X - characterStart.X - dx * 2) <= 1 && Math.Abs(continued.Y - characterStart.Y - dy + 20) <= 1,
                    $"{side}/{size}% continued dragging follows the same pointer anchor (start {characterStart}, current {continued}, delta {dx * 2},{dy - 20}, scale {pet.RenderScaling})");
                var position = pet.Position;
                pet.Present(new("state", State: "standby", Enabled: false));
                Check(pet.Position == position && pet.Width > restWidth,
                    $"{side}/{size}% voice state refresh cannot re-dock a character held by the user");
                var targetX = side == Key.Right ? screen.WorkingArea.X + screen.WorkingArea.Width / 4
                    : screen.WorkingArea.Right - screen.WorkingArea.Width / 4;
                Move(targetX - characterStart.X, dy, 5); await Task.Delay(30);
                talk.RaiseEvent(new PointerReleasedEventArgs(talk, pointer, pet,
                    pet.PointToClient(new PixelPoint(pointerStart.X + targetX - characterStart.X, pointerStart.Y + dy)), 6, up, KeyModifiers.None, MouseButton.Left));
                await Task.Delay(50);
                Check(pet.Width == restWidth && (side == Key.Right ? pet.Position.X == screen.WorkingArea.X
                    : pet.Position.X + (int)Math.Ceiling(pet.Width * screen.Scaling) == screen.WorkingArea.Right),
                    $"{side}/{size}% release snaps to the edge nearest the character after crossing the desktop");
                Check(talks == 0, $"{side}/{size}% dragging never starts a voice conversation");
                Check(talk.ContextMenu!.Items.OfType<MenuItem>().Any(i => Equals(i.Header, "大小"))
                    && !talk.ContextMenu.Items.OfType<MenuItem>().Any(i => Equals(i.Header, "大小…")),
                    "the size menu label has no trailing ellipsis");
                if (size == 100 && side == Key.Right)
                {
                    var grab = talk.Bounds.Intersect(new Rect(pet.ClientSize)).Center;
                    talk.RaiseEvent(new PointerPressedEventArgs(talk, pointer, pet, grab, 7, down, KeyModifiers.None));
                    pointer.Capture(talk);
                    talk.RaiseEvent(new PointerEventArgs(InputElement.PointerMovedEvent, talk, pointer, pet,
                        new Point(grab.X + 240, grab.Y), 8, moving, KeyModifiers.None));
                    Check(pet.Width > restWidth && pointer.Captured == talk,
                        $"a dragged character retains pointer capture after its canvas expands (width {pet.Width}, captured {pointer.Captured?.GetType().Name ?? "none"}, pressed {Field<bool>(pet, "_pressed")}, dragged {Field<bool>(pet, "_dragged")}, grab {grab})");
                    pointer.Capture(null); await Task.Delay(50);
                    Check(!Field<bool>(pet, "_pressed") && pet.Width == restWidth && talks == 0,
                        "losing pointer capture finishes docking without leaving a full-width dragging window or starting voice");
                    mascot.Animate = true; pet.Present(new("state", State: "standby", Enabled: true));
                    grab = talk.Bounds.Intersect(new Rect(pet.ClientSize)).Center;
                    talk.RaiseEvent(new PointerPressedEventArgs(talk, pointer, pet, grab, 9, down, KeyModifiers.None));
                    pointer.Capture(talk);
                    talk.RaiseEvent(new PointerEventArgs(InputElement.PointerMovedEvent, talk, pointer, pet,
                        new Point(grab.X + 240, grab.Y), 10, moving, KeyModifiers.None));
                    talk.RaiseEvent(new PointerReleasedEventArgs(talk, pointer, pet, default, 11, up, KeyModifiers.None, MouseButton.Left));
                    await Task.Delay(1800);
                    Check(pet.Width == restWidth && !Field<DispatcherTimer>(pet, "_dockFrames").IsEnabled && talks == 0,
                        "animated drag release completes the edge transition and stops its drawing timer");
                }
                pet.Shutdown(); pet = null;
            }
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = true, checks }));
            Console.WriteLine($"PASS {checks.Count} desktop drag checks");
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = false, checks, error = error.ToString() }));
            Console.Error.WriteLine(error); Environment.ExitCode = 1;
        }
        finally { pet?.Shutdown(); ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode); }
    }
}
