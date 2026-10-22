using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Markup.Xaml.Styling;
using Avalonia.Media;

namespace ICeClass.Receiver;

internal sealed class ClassroomIslandWindow : Window
{
    private readonly ClassroomIslandRibbon _ribbon = new();
    private ClassroomIslandView? _view;
    private IslandAttentionPulseWindow? _pulse;
    private readonly TextBlock _readingTitle = Text("早读陪伴", 16);
    private readonly TextBlock _readingDetail = Text("", 14, muted: true);
    private readonly TextBlock _readingUnavailable = Text("", 13, muted: true);
    private readonly TextBlock _connection = Text("", 14, muted: true);
    private readonly TextBlock _noticeSender = Text("", 14);
    private readonly TextBlock _noticeText = Text("", 15);
    private readonly Button _expand = new();
    private readonly Button _reading = Button("打开早读", primary: true);
    private readonly Button _dim = Button("淡化", quiet: true);
    private readonly Border _notice;
    private readonly Border _details;
    private readonly ScrollViewer _detailsScroll;
    private readonly ClassroomIslandReveal _reveal;
    private readonly IslandShoutCard _shoutCard;
    private readonly ClassroomIslandReveal _shoutReveal;
    private readonly IslandBanbanMascot _mascot = new();
    private readonly IslandShoutCompanion _companion;
    private readonly IslandImportantMessage _importantBody = new();
    private readonly Button _importantExpand = new();
    private readonly ClassroomIslandReveal _importantReveal;
    private readonly Button _dismissShout = Button("已知晓", quiet: true);
    private readonly Border _surface;
    private readonly Action _hide;
    private readonly StackPanel _lessonList = new() { Spacing = 6 };
    private readonly Border _lessonPanel;
    private readonly TextBlock _component = Text("", 14, muted: true);
    private IslandAppearance _appearance = new();
    private bool _interactiveOverride;
    private bool _isConnected;
    private string _noticeLevel = "info";
    private bool _expanded, _dimmed, _hasNotice, _closing, _opening;
    private bool _shoutShown, _shoutExpanded;
    private long _shoutSequence = -1;

    public ClassroomIslandWindow(Func<Task> openReading, Action openHome, Action toggleDim, Action hide, Action dismissNotice)
        : this(openReading, openHome, toggleDim, hide, dismissNotice, null) { }

    public ClassroomIslandWindow(Func<Task> openReading, Action openHome, Action toggleDim, Action hide, Action dismissNotice, Action? settings, Action? dismissWithoutAcknowledging = null)
    {
        _hide = hide;
        ClassroomStyle.Apply(this);
        Styles.Add(new StyleInclude(new Uri("avares://ICeClass/")) { Source = new Uri("avares://ICeClass/ClassroomIslandStyles.axaml") });
        Title = "顶部悬浮岛 · ICeClass 班伴";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        SystemDecorations = SystemDecorations.None;
        TransparencyLevelHint = [WindowTransparencyLevel.Transparent];
        Background = Brushes.Transparent;
        ShowInTaskbar = false; ShowActivated = false; Topmost = true; CanResize = false;
        WindowStartupLocation = WindowStartupLocation.Manual;
        SizeToContent = SizeToContent.Height; Width = 560;

        _expand.Classes.Add("island-ribbon-button");
        _expand.Content = _ribbon; _expand.Padding = new Thickness(0);
        _expand.BorderThickness = new Thickness(0); _expand.Background = Brushes.Transparent;
        _expand.HorizontalAlignment = HorizontalAlignment.Stretch;
        _expand.HorizontalContentAlignment = HorizontalAlignment.Stretch;
        _expand.VerticalContentAlignment = VerticalAlignment.Stretch;
        _expand.MinHeight = ClassroomIslandRibbon.RibbonHeight;
        _expand.Click += (_, _) => { if (_shoutShown) SetShoutExpanded(!_shoutExpanded); else SetExpanded(!_expanded); };
        ToolTip.SetTip(_expand, "点击查看早读、今日课表与操作；Esc 收起");
        AutomationProperties.SetName(_expand, "展开教室岛操作");
        _ribbon.Attention += color =>
        {
            _pulse ??= new IslandAttentionPulseWindow();
            _pulse.Play(this, color);
        };

        _readingDetail.TextWrapping = TextWrapping.Wrap; _readingDetail.MaxLines = 2;
        var readingInfo = new StackPanel { Spacing = 2, VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 12, 0), Children = { _readingTitle, _readingDetail } };
        var readingRow = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        readingRow.Children.Add(readingInfo); Grid.SetColumn(_reading, 1); readingRow.Children.Add(_reading);
        _reading.Click += async (_, _) =>
        {
            if (_opening || !_canOpenReading) return;
            _opening = true; UpdateReadingAction();
            try { await openReading(); SetExpanded(false); }
            catch (Exception error)
            {
                AppLog.Error("Open reading from classroom island failed", error);
                _readingDetail.Text = "暂时无法打开早读，请稍后重试或打开教室首页。";
                ToolTip.SetTip(_readingDetail, error.Message);
            }
            finally { _opening = false; UpdateReadingAction(); }
        };
        _readingUnavailable.TextWrapping = TextWrapping.Wrap;
        _readingUnavailable.IsVisible = false;
        var dismiss = Button("知道了", quiet: true);
        dismiss.Click += (_, _) => dismissNotice();
        var noticeHeading = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        _noticeSender.VerticalAlignment = VerticalAlignment.Center;
        noticeHeading.Children.Add(_noticeSender); Grid.SetColumn(dismiss, 1); noticeHeading.Children.Add(dismiss);
        _noticeText.TextWrapping = TextWrapping.Wrap; _noticeText.MaxLines = 2;
        _notice = new Border { IsVisible = false, Padding = new Thickness(12, 8, 12, 12), CornerRadius = new CornerRadius(10),
            Background = DesktopStyle.Brush("#24364C"),
            Child = new StackPanel { Spacing = 8, Children = { noticeHeading, _noticeText } } };
        var home = Button("首页", quiet: true); home.Click += (_, _) => { SetExpanded(false); openHome(); };
        _dim.Click += (_, _) => toggleDim();
        ToolTip.SetTip(_dim, "淡化后，移开鼠标降低透明度；移入或键盘操作时恢复清晰。");
        var close = Button("隐藏", quiet: true); close.Click += (_, _) => hide();
        ToolTip.SetTip(close, "隐藏悬浮岛；右击系统托盘图标可重新显示。");
        var timetable = Button("课表", quiet: true);
        _lessonPanel = new Border { IsVisible = false, Child = _lessonList, Padding = new Thickness(0, 4) };
        timetable.Click += (_, _) => { _lessonPanel.IsVisible = !_lessonPanel.IsVisible; SetExpanded(true); };
        var settingsButton = Button("设置", quiet: true); settingsButton.Click += (_, _) => settings?.Invoke();
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { home, timetable, settingsButton, _dim, close } };
        foreach (var action in actions.Children.OfType<Button>()) { action.MinWidth = 44; action.Padding = new Thickness(8, 5); }
        var footer = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto"), RowDefinitions = new RowDefinitions("Auto,Auto"), Margin = new Thickness(0, 4, 0, 0) };
        _connection.VerticalAlignment = VerticalAlignment.Center; _connection.Margin = new Thickness(0, 0, 8, 0);
        footer.Children.Add(_connection); Grid.SetColumn(actions, 1); footer.Children.Add(actions);
        void ArrangeFooter()
        {
            var narrow = footer.Bounds.Width < 420;
            footer.ColumnDefinitions = new ColumnDefinitions(narrow ? "*" : "*,Auto");
            Grid.SetColumn(actions, narrow ? 0 : 1); Grid.SetRow(actions, narrow ? 1 : 0);
            actions.HorizontalAlignment = narrow ? HorizontalAlignment.Left : HorizontalAlignment.Right;
            _connection.Margin = narrow ? new Thickness(0, 0, 0, 8) : new Thickness(0, 0, 12, 0);
        }
        footer.SizeChanged += (_, _) => ArrangeFooter(); ArrangeFooter();
        _detailsScroll = new ScrollViewer {
            HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled,
            Content = new StackPanel { Spacing = 14, Children = { readingRow, _readingUnavailable, _component, _lessonPanel, _notice, footer } } };
        _component.IsVisible = false;
        _details = new Border { IsVisible = false, BorderThickness = new Thickness(0, 1, 0, 0),
            BorderBrush = DesktopStyle.Brush("#334257"), Padding = new Thickness(16, 12, 16, 12),
            Child = _detailsScroll };
        _reveal = new ClassroomIslandReveal(_details);
        _shoutCard = new IslandShoutCard(dismissNotice);
        _shoutReveal = new ClassroomIslandReveal(_shoutCard);
        _dismissShout.IsVisible = false; _dismissShout.HorizontalAlignment = HorizontalAlignment.Right;
        _dismissShout.Margin = new Thickness(0, 6, 10, 6); _dismissShout.MinHeight = 36;
        _dismissShout.MinWidth = 50; _dismissShout.Padding = new Thickness(8, 4); _dismissShout.FontSize = 13;
        _dismissShout.Click += (_, _) => dismissNotice();
        AutomationProperties.SetName(_dismissShout, "已知晓，向老师确认并收起喊话");
        ToolTip.SetTip(_dismissShout, "向老师确认已知晓，并停止声音；Esc 仅收起。");
        var ribbonHost = new Grid { Children = { _expand, _dismissShout } };
        _importantExpand.Classes.Add("island-ribbon-button");
        _importantExpand.Content = _importantBody; _importantExpand.Padding = new Thickness(0);
        _importantExpand.BorderThickness = new Thickness(0); _importantExpand.Background = Brushes.Transparent;
        _importantExpand.HorizontalAlignment = HorizontalAlignment.Stretch;
        _importantExpand.HorizontalContentAlignment = HorizontalAlignment.Stretch;
        _importantExpand.VerticalContentAlignment = VerticalAlignment.Stretch;
        _importantExpand.Click += (_, _) => SetShoutExpanded(true);
        AutomationProperties.SetName(_importantExpand, "展开喊话全文");
        ToolTip.SetTip(_importantExpand, "点击查看完整内容；Esc 结束喊话");
        _importantReveal = new ClassroomIslandReveal(_importantExpand);
        var rows = new StackPanel { Children = { ribbonHost, _importantReveal, _shoutReveal, _reveal } };
        _surface = new Border { Background = Brushes.Transparent, CornerRadius = new CornerRadius(24), Child = rows };
        _companion = new IslandShoutCompanion(_surface, _mascot);
        _companion.GeometryChanged += DockToPrimaryScreen;
        Content = new Border { Padding = new Thickness(6, 0, 6, 6), Child = _companion, VerticalAlignment = VerticalAlignment.Top };
        KeyDown += (_, args) => { if (args.Key == Key.Escape) { if (_shoutShown) (dismissWithoutAcknowledging ?? dismissNotice)(); else SetExpanded(false); args.Handled = true; } };
        PointerEntered += (_, _) => UpdateOpacity(); PointerExited += (_, _) => UpdateOpacity();
        GotFocus += (_, _) => UpdateOpacity(); LostFocus += (_, _) => UpdateOpacity();
        Deactivated += (_, _) => { if (!_shoutShown) SetExpanded(false); };
        Opened += (_, _) => { DockToPrimaryScreen(); _companion.ResumeAnimation(); _mascot.ResumeAnimation(); IslandPlatform.SetClickThrough(this, _appearance.ClickThrough && !_interactiveOverride && !_shoutShown); };
        SizeChanged += (_, _) => { if (_appearance.Position == "bottom-center") DockToPrimaryScreen(); };
        PropertyChanged += (_, args) =>
        {
            if (args.Property == IsVisibleProperty && !IsVisible) { CollapseImmediately(); _pulse?.Stop(); }
        };
        Closing += (_, args) =>
        {
            if (_closing || args.CloseReason is WindowCloseReason.ApplicationShutdown or WindowCloseReason.OSShutdown) return;
            args.Cancel = true; if (_shoutShown) (dismissWithoutAcknowledging ?? dismissNotice)(); else _hide();
        };
    }

    private bool _canOpenReading;
    public bool IsExpanded => _expanded;
    public bool HasShout => _shoutShown;
    internal bool IsShoutExpanded => _shoutExpanded;
    internal bool IsUrgent => _shoutShown && _noticeLevel == "urgent";
    public bool PointerOrFocusWithin => IsPointerOver || IsKeyboardFocusWithin;
    public void AllowInteraction() { _interactiveOverride = true; IslandPlatform.SetClickThrough(this, false); }
    public void ApplyProfile(IslandAppearance appearance, IslandProfile? profile, DateTimeOffset now, string component, string connection, bool progressRunning = true)
    {
        _appearance = appearance;
        UpdateImportantBody();
        var light = appearance.Theme == "light" || appearance.Theme == "system" && ActualThemeVariant == Avalonia.Styling.ThemeVariant.Light;
        Classes.Set("island-light", light);
        UpdateSurface();
        _surface.BorderBrush = DesktopStyle.Brush(light ? "#C2CDDC" : "#3B4A5E");
        _details.BorderBrush = _surface.BorderBrush;
        _notice.Background = DesktopStyle.Brush(light ? "#E1EEFF" : "#24364C");
        _shoutCard.ApplyTheme(light);
        _importantBody.Light = light;
        foreach (var text in new[] { _readingTitle, _noticeText })
            text.Foreground = DesktopStyle.Brush(light ? "#172A44" : "#F3F7FD");
        foreach (var text in new[] { _readingDetail, _readingUnavailable, _component }) text.Foreground = DesktopStyle.Brush(light ? "#36516E" : "#C4D1E3");
        _dim.Foreground = DesktopStyle.Brush(light ? "#29486D" : "#D4E2F6");
        _noticeSender.Foreground = DesktopStyle.Brush(light ? _noticeLevel == "urgent" ? "#9C332C" : _noticeLevel == "warning" ? "#84521C" : "#005BB5" : NoticeColor(_noticeLevel));
        _connection.Foreground = DesktopStyle.Brush(light ? _isConnected ? "#1D7555" : "#8B561C" : _isConnected ? "#8CDDC3" : "#F0C480");
        _component.Text = component; ToolTip.SetTip(_component, component); _component.IsVisible = !string.IsNullOrEmpty(component);
        ToolTip.SetTip(_connection, connection);
        if (profile?.Slots.Count > 0)
        {
            var today = IslandSchedule.On(profile, DateOnly.FromDateTime(now.ToOffset(TimeSpan.FromHours(8)).DateTime));
            var signature = light + ":" + string.Join("\n", today.Select(l => l.Summary));
            if (signature != _lessonSignature)
            {
                _lessonSignature = signature; _lessonList.Children.Clear();
                var heading = Text("今日课表", 15); heading.Foreground = DesktopStyle.Brush(light ? "#172A44" : "#F3F7FD"); _lessonList.Children.Add(heading);
                foreach (var lesson in today) { var row = Text(lesson.Summary, 14); row.Foreground = DesktopStyle.Brush(light ? "#29486D" : "#D4E2F6"); ToolTip.SetTip(row, lesson.Summary); _lessonList.Children.Add(row); }
                if (today.Count == 0) { var empty = Text("今天没有课程", 14); empty.Foreground = heading.Foreground; _lessonList.Children.Add(empty); }
            }
        }
        else if (_lessonSignature != "empty")
        {
            _lessonSignature = "empty"; _lessonList.Children.Clear(); _lessonList.Children.Add(Text("教师尚未设置课表", 14));
        }
        foreach (var line in _lessonList.Children.OfType<TextBlock>()) line.Foreground = DesktopStyle.Brush(light ? "#172A44" : "#D4E2F6");
        IslandPlatform.SetClickThrough(this, appearance.ClickThrough && !_interactiveOverride && !_shoutShown);
        _ribbon.Light = light;
        if (_view is not null)
        {
            var frame = IslandRibbonPresentation.Build(profile, now, _view, component);
            _ribbon.Present(progressRunning ? frame : frame with { ProgressPerSecond = 0 });
        }
        DockToPrimaryScreen(); UpdateOpacity();
    }
    private string? _lessonSignature;
    public void Update(ClassroomIslandView view, bool dimmed)
    {
        _view = view;
        _readingTitle.Text = view.ReadingTitle; _readingDetail.Text = view.ReadingDetail;
        ToolTip.SetTip(_readingDetail, view.ReadingDetail);
        _canOpenReading = view.CanOpenReading; UpdateReadingAction();
        _isConnected = view.Connected; _connection.Text = view.Connected ? "已连接" : "未连接";
        _connection.Foreground = DesktopStyle.Brush(view.Connected ? "#8CDDC3" : "#F0C480");
        ToolTip.SetTip(_connection, view.ConnectionText);
        _hasNotice = view.Notice is not null;
        _notice.IsVisible = view.Notice is { Category: not "班级通知" };
        if (view.Notice is { } notice)
        {
            _noticeLevel = notice.Level;
            _noticeSender.Text = notice.Sender + (notice.Level == "urgent" ? " · 紧急通知" : notice.Level == "warning" ? " · 重要通知" : " · " + notice.Category);
            _noticeSender.Foreground = DesktopStyle.Brush(NoticeColor(notice.Level));
            _noticeText.Text = notice.Text; ToolTip.SetTip(_noticeText, notice.Text);
        }
        var shout = view.Notice is { Category: "班级通知" };
        var newShout = shout && _shoutSequence != view.Notice!.Sequence;
        if (shout)
        {
            _shoutCard.Update(view.Notice!, view.ClassName);
            _mascot.Begin(view.Notice!);
            _importantBody.Update(view.Notice!);
            if (newShout)
            { _shoutSequence = view.Notice!.Sequence; SetShoutExpanded(false); }
        }
        if (shout != _shoutShown)
        {
            _shoutShown = shout;
            _dismissShout.IsVisible = shout;
            if (!shout) { _mascot.Stop(); SetShoutExpanded(false); }
        }
        _companion.PullEnabled = view.Notice?.Level is "warning" or "urgent";
        _companion.SetActive(shout, ClassroomIslandReveal.AnimationsEnabled(), newShout);
        UpdateImportantBody();
        UpdateExpandName();
        ToolTip.SetTip(_expand, shout ? "点击在岛内展开或收起全文；Esc 结束喊话" : "点击查看早读、今日课表与操作；Esc 收起");
        _dimmed = dimmed; _dim.Content = dimmed ? "恢复清晰" : "淡化";
        UpdateOpacity();
    }

    public void SetExpanded(bool expanded)
    {
        if (_closing) return;
        if (_shoutShown && expanded) { SetShoutExpanded(true); return; }
        _expanded = expanded;
        UpdateSurface();
        if (!expanded) { _interactiveOverride = false; IslandPlatform.SetClickThrough(this, _appearance.ClickThrough && !_shoutShown); }
        UpdateExpandName();
        _reveal.SetExpanded(expanded, IsVisible && ClassroomIslandReveal.AnimationsEnabled());
        UpdateOpacity();
    }

    internal void SetShoutExpanded(bool expanded)
    {
        _shoutExpanded = expanded && _shoutShown;
        _shoutReveal.SetExpanded(_shoutExpanded, IsVisible && ClassroomIslandReveal.AnimationsEnabled());
        UpdateImportantBody();
        UpdateSurface();
        UpdateExpandName();
    }

    private void UpdateExpandName() => AutomationProperties.SetName(_expand, _shoutShown
        ? _shoutExpanded ? "收起喊话全文，Esc 结束喊话" : "展开喊话全文，Esc 结束喊话"
        : (_view is { } view ? view.ClassName + "，" + view.Date + "，" + view.Status + "，" : "") + (_expanded ? "收起悬浮岛操作" : "展开悬浮岛操作"));

    private void UpdateImportantBody()
    {
        var notice = _view?.Notice;
        var expanded = !_shoutExpanded && _shoutShown && notice is { Level: "warning" or "urgent" }
            && notice.AgeSeconds >= IslandShoutText.CueSecondsFor(notice.Level)
            && _importantBody.NeedsExpansion(_appearance.Width + IslandShoutCompanion.ExpansionWidth - 12 - IslandShoutCompanion.SideWidth);
        _ribbon.ImportantExpanded = expanded;
        _ribbon.FullTextExpanded = _shoutExpanded;
        _ribbon.InvalidateVisual();
        _importantReveal.SetExpanded(expanded,
            IsVisible && ClassroomIslandReveal.AnimationsEnabled());
        UpdateSurface();
    }

    private void UpdateSurface() => _surface.Background = _shoutShown
        ? DesktopStyle.Brush(Classes.Contains("island-light") ? _view?.Notice?.Level switch { "urgent" => "#FFF0F1", "warning" => "#FFF7E5", _ => "#EDF6FF" }
            : _view?.Notice?.Level switch { "urgent" => "#352025", "warning" => "#29261F", _ => "#172638" })
        : _expanded || _shoutExpanded ? DesktopStyle.Brush(Classes.Contains("island-light") ? "#FCFDFF" : "#131E2D") : Brushes.Transparent;

    private void CollapseImmediately()
    {
        _expanded = false; _surface.Background = Brushes.Transparent;
        _shoutShown = _shoutExpanded = false; _dismissShout.IsVisible = false;
        _shoutReveal.SetExpanded(false, false); _companion.SetActive(false, false); _mascot.Stop();
        _importantReveal.SetExpanded(false, false);
        AutomationProperties.SetName(_expand, "展开悬浮岛");
        _reveal.SetExpanded(false, false); UpdateOpacity();
    }

    private void UpdateOpacity()
    {
        var reading = _shoutShown || _expanded || IsPointerOver || IsKeyboardFocusWithin;
        _surface.Opacity = reading ? 1 : _appearance.Opacity / 100.0 * (_dimmed && !_hasNotice ? .45 : 1);
    }

    private void UpdateReadingAction()
    {
        _reading.IsEnabled = !_opening && _canOpenReading;
        _reading.Content = _opening ? "正在打开…" : _canOpenReading ? "打开早读" : _view?.ReadingUnavailableReason is not null ? "仅演示" : "暂不可用";
        var reason = _view?.ReadingUnavailableReason ?? "请在教室首页检查绑定状态后再打开早读。";
        _readingUnavailable.Text = reason;
        _readingUnavailable.IsVisible = !_canOpenReading;
        ToolTip.SetTip(_reading, _canOpenReading ? "打开本机早读陪伴" : reason);
    }

    public async Task WaitForShoutAsync()
    {
        var sequence = _shoutSequence;
        var shown = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        RequestAnimationFrame(_ =>
        {
            if (IsVisible && _shoutShown && _shoutSequence == sequence) shown.TrySetResult();
            else shown.TrySetException(new InvalidOperationException("喊话窗口未能显示。"));
        });
        await shown.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    public void DockToPrimaryScreen()
    {
        var screen = Screens.Primary ?? Screens.ScreenFromWindow(this);
        if (screen is null) return;
        var work = screen.WorkingArea; var scale = screen.Scaling;
        var wantedWidth = _appearance.Width + _companion.Expansion;
        Width = Math.Max(1, Math.Min(wantedWidth, work.Width / scale - 12));
        MaxHeight = Math.Max(1, work.Height / scale);
        _shoutCard.SetAvailableHeight(Math.Max(32, work.Height / scale - 76));
        var detailsChrome = ClassroomIslandRibbon.RibbonHeight + _details.Padding.Top + _details.Padding.Bottom
            + _details.BorderThickness.Top + _details.BorderThickness.Bottom + 6;
        _detailsScroll.MaxHeight = Math.Max(32, work.Height / scale - detailsChrome);
        var nativeWidth = (int)Math.Round(Width * scale);
        var nativeHeight = (int)Math.Round(Bounds.Height * scale);
        var x = _appearance.Position == "top-left" ? work.X : _appearance.Position == "top-right" ? work.Right - nativeWidth : work.X + (work.Width - nativeWidth) / 2;
        var y = _appearance.Position == "bottom-center" ? work.Bottom - nativeHeight : work.Y;
        x = Math.Clamp(x + (int)(_appearance.OffsetX * scale), work.X, Math.Max(work.X, work.Right - nativeWidth));
        y = Math.Clamp(y + (int)(_appearance.OffsetY * scale), work.Y, Math.Max(work.Y, work.Bottom - nativeHeight));
        var position = new PixelPoint(x, y);
        if (Position != position) Position = position;
    }

    public void DisposeWindow() { _closing = true; _reveal.Dispose(); _shoutReveal.Dispose(); _importantReveal.Dispose(); _companion.Dispose(); _mascot.Dispose(); _shoutCard.Dispose(); _ribbon.Dispose(); _pulse?.Dispose(); Close(); }
    private static string NoticeColor(string level) => level == "urgent" ? "#FFB8B2" : level == "warning" ? "#FFDA9B" : "#91C7FF";
    private static TextBlock Text(string text, double size, bool muted = false) => new()
    {
        Text = text, FontFamily = ClassroomStyle.Font, FontSize = size, FontWeight = FontWeight.Bold,
        Foreground = DesktopStyle.Brush(muted ? "#B2C1D5" : "#F3F7FD"), TextTrimming = TextTrimming.CharacterEllipsis,
        TextWrapping = TextWrapping.NoWrap, LineHeight = Math.Ceiling(size * 1.5), VerticalAlignment = VerticalAlignment.Center,
    };
    private static Button Button(string text, bool primary = false, bool quiet = false)
    {
        var button = DesktopStyle.Button(text);
        button.Classes.Add("island-button");
        if (primary) button.Classes.Add("island-primary");
        if (quiet) button.Classes.Add("island-quiet");
        button.VerticalAlignment = VerticalAlignment.Center;
        return button;
    }
}
