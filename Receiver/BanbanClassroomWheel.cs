using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Controls.Shapes;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Styling;
using static ICeClass.Receiver.BanbanClassroomStyle;

namespace ICeClass.Receiver;

internal sealed record CardQuizWheelAction(string Id, string Label, string Icon, bool Enabled);
internal sealed record CardQuizBar(string Label, int Count);
internal sealed record CardQuizRecord(string Kind, CardQuizBar[]? Bars, int Received, int Expected, int Unanswered, int Incomplete, int Abstained = 0);
internal sealed record CardQuizLesson(string Phase, string Heading, string Caption, string Primary, string Label, bool Enabled,
    int Number, string Kind, string Option, int Received, int Expected, int[] Missing, CardQuizBar[] Bars,
    bool CanChooseType, bool Busy, int QuestionCount, bool Phone, bool NeedsSync, CardQuizRecord[] Records, string Key, int Incomplete = 0,
    int Abstained = 0, string? NoCardPolicy = null);
internal sealed record CardQuizWheelState(bool HasSession, CardQuizWheelAction[] Actions, string Progress,
    string Status, string Feedback, bool Error, bool Multiple, bool MultiEnabled, bool CameraRunning, CardQuizWheelSetup? Setup,
    string Panel, string MultiLabel, bool Retry, CardQuizLesson Lesson, string PanelTitle = "", string PanelHint = "", CardQuizCardPanel? CardPanel = null,
    CardQuizCameraPreview? Preview = null, CardQuizDiscPage? DiscPage = null);

/// <summary>The lesson panel displays only confirmed classroom state. The original pet remains beside it.</summary>
internal sealed class BanbanClassroomWheel : Canvas
{
    internal const double Diameter = 240;
    private const int VisibleBars = 4;
    private const double BarWidth = 92, ChartWidth = 172;
    private static ColumnDefinitions ChartColumns() => new($"49,{BarWidth},*");
    private readonly Grid _disc = new() { Width = Diameter, Height = Diameter };
    private readonly Grid _face = new() { Margin = new Thickness(20), RowDefinitions = new RowDefinitions("44,*,44") };
    internal BanbanClassroomProgress Progress { get; } = new();
    private readonly StackPanel _body = new() { VerticalAlignment = VerticalAlignment.Center };
    private readonly ScrollViewer _bodyScroll;
    private readonly TextBlock _heading = Label("", 17, true), _caption = Label("", 15);
    private readonly TextBlock _emptyCount = Label("", 34, true), _emptyResult = Label("", 16, true);
    private readonly StackPanel _cardDirections = Row();
    private readonly StackPanel _negativeDirection;
    private readonly TextBlock _raiseHint = Label("选才举卡", 12);
    private readonly TextBlock _answered = Label("", 17, true);
    private readonly Button _chartDetails = MakeButton("查看作答分布");
    private readonly Viewbox _chartCue;
    private readonly TextBlock _currentOption = Label("", 18, true);
    private readonly TextBlock _number = Label("", 42, true), _total = Label("", 16), _directions = Label("", 15);
    private readonly StackPanel _count = Row();
    private readonly Border _optionBadge;
    private readonly BanbanClassroomReady _ready = new();
    private readonly BanbanTextReader _messageReader = new();
    private readonly Button _readMessage = MakeButton("详情");
    private string _messageTitle = "";
    private readonly StackPanel _bars = new() { Width = ChartWidth, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly Grid _barScale = new() { Width = ChartWidth, ColumnDefinitions = ChartColumns(), HorizontalAlignment = HorizontalAlignment.Center };
    private readonly TextBlock _barMax = Label("", 12);
    private readonly Grid _toolSurface = new();
    private readonly Canvas _tools = new();
    private readonly BanbanToolSector _main, _skipEmpty;
    private readonly BanbanToolSector _settings, _footerTools, _finish, _records, _sync, _previous, _recordBack, _voiceBack;
    private readonly Canvas _lessonActions = new();
    private readonly BanbanToolSector _lessonPrimary, _lessonTools, _lessonSide, _lessonMenu, _toolsMenu;
    private readonly Canvas _footer = new();
    private readonly BanbanToolSector _footerPrimary, _footerCancel, _homeVoice;
    private readonly List<Button> _navigation = [];
    private readonly List<BanbanToolSector> _toolButtons = [];
    private readonly List<(TextBlock Label, Border Fill, TextBlock Count)> _barRows = [];
    private readonly BanbanClassroomDetail _detail = new();
    private readonly Border _surface;
    private readonly IBrush _classroomTint, _pageTint;
    private readonly BanbanCardOverview _cardRing = new();
    private readonly BanbanClassroomSetup _setup = new();
    private CardQuizWheelState? _state;
    private Button? _returnTo;
    private string _view = "", _loadError = "", _voice = "";
    private bool _focusPending, _voiceFromTools;
    private int _recordIndex;
    private readonly IBrush _ink, _sub, _mark, _accentInk, _otherBar, _track, _paper, _error;
    internal bool SetupVisible => _setup.IsVisible;
    internal bool DetailVisible => _detail.IsVisible || _cardRing.IsVisible;
    internal bool BrowserDetailVisible => _detail.IsVisible && _detail.Reading;
    internal Rect BrowserDetailBounds => _detail.BrowserBounds;
    internal Button ActivePrimary => _ready.IsVisible ? _ready.Start : _footerPrimary.IsVisible ? _footerPrimary : _lessonActions.IsVisible ? _lessonPrimary : _main;
    internal event Action? SurfaceChanged;
    internal event Action<Button>? MenuRequested;
    internal event Action<CardQuizWheelCommand>? ActionRequested;
    internal bool HasPendingHistory => _state is { Lesson.Phase: "home" } state &&
        state.Actions.Any(a => a.Id == "end-session" && a.Enabled);
    internal void OpenPendingHistory() { if (HasPendingHistory) Send("end-session"); }
    internal string DockLabel => _state?.Retry == true || _loadError.Length>0 ? "待核对" : _state?.Lesson is { } lesson ? lesson.Phase switch
        { "paused" or "collect" => "已暂停", "ready" or "result" => $"第 {lesson.Number} 题", "done" => "已结课", _ => "课堂" } : "课堂";

    internal BanbanClassroomWheel()
    {
        Width = Height = Diameter; IsVisible = false;
        var contrast = DesktopStyle.HighContrastEnabled();
        _ink = contrast ? Brushes.Black : DesktopStyle.Brush("#193C59");
        _sub = contrast ? Brushes.Black : SecondaryInk;
        _mark = contrast ? Brushes.Black : DesktopStyle.Brush("#0B6DCC");
        _accentInk = contrast ? Brushes.Black : ActionBlue;
        _otherBar = contrast ? Brushes.Black : DesktopStyle.Brush("#52768E");
        _track = contrast ? DesktopStyle.Brush("#AAA") : DesktopStyle.Brush("#B6CBDD");
        _paper = contrast ? Brushes.White : DesktopStyle.Brush("#DCF8FDFF");
        _error = contrast ? Brushes.Black : DesktopStyle.Brush("#933D2D");
        _classroomTint = ClassroomGlassHost.FloatingTint(contrast);
        _pageTint = contrast ? Brushes.White : DesktopStyle.Brush("#E4F1F9");
        _surface = DiscSurface(_classroomTint, contrast);
        var railBrush = contrast ? _track : DesktopStyle.Brush("#CCDDE9");
        var shell = new Grid { Width = Diameter, Height = Diameter, Children = { _surface, _disc } };
        Children.Add(shell);
        _disc.Children.Add(Progress);
        // String button content is rendered by a TextBlock in the shared control template.
        Styles.Add(new Style(s => s.Is<TextBlock>()) { Setters = { new Setter(TextBlock.FontFamilyProperty, BanbanClassroomStyle.Font) } });
        var header = new Canvas();
        _disc.Children.Add(header);
        var contentInset = RimInset + BanbanClassroomProgress.RingThickness + 2;
        var contentSize = Diameter - 2 * contentInset;
        _disc.Children.Add(new Grid { Clip = new EllipseGeometry(new Rect(contentInset, contentInset, contentSize, contentSize)), Children = { _face } });
        _main = new("primary", contrast, _accentInk, BanbanToolSector.Band.Header) { Name = "ClassroomPrimary" };
        _main.Place(0, 1);
        _main.Click += (_, _) => Primary();
        _navigation.Add(_main);
        header.Children.Add(_main);
        _skipEmpty = new("skip", contrast, _accentInk, BanbanToolSector.Band.Header);
        _skipEmpty.SetFace("跳过本题", "跳过", "skip-forward");
        _skipEmpty.Place(0, 1);
        Add(header, _skipEmpty, () => Send("advance"));
        ToolTip.SetTip(_skipEmpty, "保留本题记录，进入下一题");
        _heading.Foreground = _emptyCount.Foreground = _number.Foreground = _ink;
        _emptyResult.Foreground = _sub;
        _caption.Foreground = _directions.Foreground = _total.Foreground = _sub;
        _heading.TextWrapping = TextWrapping.NoWrap; _heading.TextTrimming = TextTrimming.CharacterEllipsis;
        _caption.LineHeight = 18;
        _answered.Foreground = _accentInk;
        _answered.LineHeight = 21;
        _answered.TextWrapping = TextWrapping.NoWrap;
        ToolTip.SetTip(_answered, "已答人数 / 应答人数");
        ToolTip.SetTip(_emptyCount, "已答人数 / 应答人数");
        _currentOption.Foreground = Brushes.White;
        _currentOption.LineHeight = 22;
        AutomationProperties.SetLiveSetting(_currentOption, AutomationLiveSetting.Polite);
        _optionBadge = new Border { Child = _currentOption, Background = _accentInk, HorizontalAlignment = HorizontalAlignment.Center,
            CornerRadius = new CornerRadius(7), Padding = new Thickness(6, 0) };
        _heading.MaxWidth = 184;
        _heading.HorizontalAlignment = HorizontalAlignment.Center;
        _count.Spacing = 5;
        _number.LineHeight = 48;
        _total.VerticalAlignment = VerticalAlignment.Bottom;
        _total.Margin = new Thickness(0, 0, 0, 3);
        _number.TextAlignment = TextAlignment.Right;
        _count.Children.Add(_number); _count.Children.Add(_total);
        _readMessage.HorizontalAlignment = HorizontalAlignment.Center;
        _readMessage.Click += (_, _) => OpenMessage();
        _navigation.Add(_readMessage);
        _messageReader.BackRequested += () => CloseMessage();
        _messageReader.RetryRequested += () =>
        {
            if (_loadError.Length > 0 || _state?.Retry == true) Primary();
            else if (_state?.Lesson is { Phase:"done", NeedsSync:true, Busy:false }) Send("sync-now");
        };
        _ready.Activated += (id, button) =>
        {
            _returnTo = button;
            switch (id)
            {
                case "start": Primary(); break;
                case "tools": OpenView("tools"); break;
                case "finish": OpenView("confirm"); break;
                case "more": MenuRequested?.Invoke(button); break;
                default: Send(id); break;
            }
        };
        BanbanToolSector FooterAction(string name, string caption, string glyph, Action action, bool primary = false)
        {
            var sector = new BanbanToolSector(primary ? "primary" : name, contrast, _accentInk, BanbanToolSector.Band.Footer);
            sector.SetFace(name, caption, glyph);
            Add(_footer, sector, action);
            return sector;
        }
        BanbanToolSector LessonAction(string name, string caption, string glyph, Action action)
        {
            var sector = new BanbanToolSector(name, contrast, _accentInk, BanbanToolSector.Band.Collection);
            sector.SetFace(name, caption, glyph);
            Add(_lessonActions, sector, action);
            return sector;
        }
        BanbanToolSector MenuEntry(Canvas parent, BanbanToolSector.Band band)
        {
            var sector = new BanbanToolSector("pet-menu", contrast, _accentInk, band);
            sector.SetFace("更多操作", "更多", "ellipsis");
            Add(parent, sector, () => MenuRequested?.Invoke(sector));
            return sector;
        }
        _toolSurface.Children.Add(_tools);
        AutomationProperties.SetName(_toolSurface, "课堂工具");
        _disc.Children.Add(_toolSurface);
        foreach (var id in new[] { "pause", "options", "source", "edit", "collect", "next", "seal", "voice", "exempt" })
        {
            var sector = new BanbanToolSector(id, contrast, _accentInk);
            Add(_tools, sector, () => { if (id == "voice") OpenView(id); else Send(id); });
            _toolButtons.Add(sector);
        }
        _toolsMenu = MenuEntry(_tools, BanbanToolSector.Band.Tools);
        _toolButtons.Add(_toolsMenu);
        var back = Add(_toolSurface, "返回课堂", () => BackFromSetup());
        BanbanClassroomStyle.RoundButton(back, 60);
        back.Content = new StackPanel { Spacing = 2, Children = { Glyph("arrow-right", 20, _ink, 180), Label("返回", 15, true) } };
        ToolTip.SetTip(back, "返回课堂");
        _cardDirections.Spacing = 4;
        _cardDirections.Children.Add(CardDirection("A", "check", 0));
        _negativeDirection = CardDirection("B", "plus", 45);
        _cardDirections.Children.Add(_negativeDirection);
        _cardDirections.Children.Add(_raiseHint);
        var barZero = Label("0", 12);
        barZero.HorizontalAlignment = HorizontalAlignment.Left;
        _barMax.HorizontalAlignment = HorizontalAlignment.Right;
        barZero.LineHeight = _barMax.LineHeight = 14;
        barZero.Foreground = _barMax.Foreground = _sub;
        foreach (var tick in new[] { barZero, _barMax }) { Grid.SetColumn(tick, 1); _barScale.Children.Add(tick); }
        for (var i = 0; i < VisibleBars; i++)
        {
            var letter = Label("", 15); var amount = Label("", 15);
            letter.LineHeight = amount.LineHeight = 16;
            letter.TextAlignment = TextAlignment.Left; amount.TextAlignment = TextAlignment.Right;
            letter.TextWrapping = amount.TextWrapping = TextWrapping.NoWrap;
            var fill = new Border { Height = 6, CornerRadius = new CornerRadius(3), HorizontalAlignment = HorizontalAlignment.Left };
            var rail = new Border { Width = BarWidth, Height = 6, CornerRadius = new CornerRadius(3), Background = railBrush, Child = fill };
            var row = new Grid { ColumnDefinitions = ChartColumns(), Children = { letter, rail, amount } };
            Grid.SetColumn(rail, 1); Grid.SetColumn(amount, 2);
            _bars.Children.Add(row); _barRows.Add((letter, fill, amount));
        }
        var summary = new Grid();
        _chartDetails.Content = null;
        _chartDetails.Background = Brushes.Transparent;
        _chartDetails.Padding = _chartDetails.BorderThickness = new Thickness(0);
        _chartDetails.MinHeight = 44;
        _chartDetails.VerticalAlignment = VerticalAlignment.Stretch;
        _chartDetails.Cursor = new Cursor(StandardCursorType.Hand);
        ToolTip.SetTip(_chartDetails, "查看作答分布");
        Add(summary, _chartDetails, () =>
        {
            if (_view == "record")
                ActionRequested?.Invoke(new("record-chart", Key: _state?.Lesson.Key, QuestionIndex: _recordIndex));
            else Send("distribution");
        });
        _chartCue = Glyph("maximize-2", 12, _accentInk);
        var summaryHeading = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto"), HorizontalAlignment = HorizontalAlignment.Center };
        _chartCue.Margin = new Thickness(4, 0, 0, 0);
        Grid.SetColumn(_chartCue, 1);
        summaryHeading.Children.Add(_heading);
        summaryHeading.Children.Add(_chartCue);
        summary.Children.Add(new StackPanel { IsHitTestVisible = false, VerticalAlignment = VerticalAlignment.Center,
            Children = { summaryHeading, _answered, _emptyCount, _emptyResult, _barScale, _bars } });
        foreach (var child in new Control[] { summary, _optionBadge, _count, _caption, _readMessage, _cardDirections, _directions })
            _body.Children.Add(child);
        _bodyScroll = new ScrollViewer { Content = _body, VerticalContentAlignment = VerticalAlignment.Center,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Grid.SetRow(_bodyScroll, 1); _face.Children.Add(_bodyScroll);
        _footerTools = FooterAction("课堂工具", "工具", "layout-grid", () => OpenView("tools"));
        _lessonPrimary = new("primary", contrast, _accentInk, BanbanToolSector.Band.Collection);
        _lessonSide = new("side", contrast, _accentInk, BanbanToolSector.Band.Collection);
        _lessonTools = new("tools", contrast, _accentInk, BanbanToolSector.Band.Collection);
        Add(_lessonActions, _lessonPrimary, Primary);
        Add(_lessonActions, _lessonSide, () => Send("missing"));
        _settings = LessonAction("开课设置", "设置", "settings-2", OpenSetup);
        _lessonMenu = MenuEntry(_lessonActions, BanbanToolSector.Band.Collection);
        Add(_lessonActions, _lessonTools, () => OpenView("tools"));
        _homeVoice = LessonAction("说话", "说话", "mic", () => OpenView("voice"));
        _lessonTools.SetFace("课堂工具", "工具", "layout-grid");
        _lessonPrimary.IsVisible = _lessonMenu.IsVisible = true;
        _lessonPrimary.Place(0, 4);
        _lessonSide.Place(1, 4); _settings.Place(1, 4);
        _lessonMenu.Place(2, 4);
        _lessonTools.Place(3, 4); _homeVoice.Place(3, 4);
        _disc.Children.Add(_lessonActions);
        _records = FooterAction("课堂记录", "记录", "book-open", () => { _recordIndex = 0; OpenView("record"); });
        _sync = FooterAction("重试同步", "重试", "rotate-ccw", () => Send("sync-now"));
        _voiceBack = FooterAction("返回课堂", "返回", "arrow-left", () => BackFromSetup());
        _footerCancel = FooterAction("取消", "取消", "arrow-left", () => BackFromSetup());
        _previous = FooterAction("上一题", "上一题", "arrow-left", () => MoveRecord(-1));
        _footerPrimary = FooterAction("下一题", "下一题", "arrow-right", Primary, primary: true);
        _finish = FooterAction("结课", "结课", "check", () => OpenView("confirm"));
        _recordBack = FooterAction("返回汇总", "返回", "arrow-left", () => BackFromSetup());
        _disc.Children.Add(_footer);
        _disc.Children.Add(_ready);
        _setup.BackRequested += () => CloseSetup(true);
        _setup.ActionRequested += command => ActionRequested?.Invoke(command);
        _detail.BackRequested += page => ActionRequested?.Invoke(new("back", Key:_state?.Lesson.Key, PageKey:_state?.DiscPage is null ? null : page));
        _detail.ActionRequested += (page, id) => ActionRequested?.Invoke(new("disc-" + id, Key:_state?.Lesson.Key, PageKey:page));
        _cardRing.ActionRequested += (action, number) => ActionRequested?.Invoke(new(action, Key:_state?.Lesson.Key, CardNumber:number));
        shell.Children.Add(_setup); shell.Children.Add(_detail); shell.Children.Add(_cardRing); shell.Children.Add(_messageReader);
        AutomationProperties.SetName(this,"班班课堂");
        AutomationProperties.SetLiveSetting(_heading, AutomationLiveSetting.Polite);
        AutomationProperties.SetLiveSetting(_answered, AutomationLiveSetting.Polite);
        AutomationProperties.SetLiveSetting(_emptyResult, AutomationLiveSetting.Polite);
        AutomationProperties.SetLiveSetting(_number, AutomationLiveSetting.Polite);
        AutomationProperties.SetLiveSetting(_caption, AutomationLiveSetting.Polite);
        KeyDown += (_, e) =>
        {
            if (SetupVisible || DetailVisible || _messageReader.IsVisible || e.Handled) return;
            if (e.Key is not (Key.Left or Key.Right or Key.Home or Key.End) && !((_toolSurface.IsVisible || _ready.IsVisible) && e.Key is (Key.Up or Key.Down))) return;
            var focused = TopLevel.GetTopLevel(this)?.FocusManager?.GetFocusedElement() as Control;
            FocusAction(focused,e.Key); e.Handled = true;
        };
        Paint();
    }

    private static TextBlock Label(string text, double size, bool bold = false)
    {
        var label = BanbanClassroomStyle.Text(text, size, bold);
        label.FontSize = size;
        label.TextAlignment = TextAlignment.Center; label.VerticalAlignment = VerticalAlignment.Center;
        label.LineHeight = size * 1.24;
        return label;
    }
    private static StackPanel Row() => new() { Orientation = Orientation.Horizontal, Spacing = 5,
        HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private StackPanel CardDirection(string letter, string symbol, double rotation)
    {
        var face = Row();
        face.Spacing = 1;
        face.Children.Add(Label(letter, 15, true));
        face.Children.Add(Glyph("arrow-right", 10, _ink, -90));
        var cue = Row();
        cue.Spacing = 2;
        cue.Children.Add(new Border { Width = 24, Height = 20, Child = face, CornerRadius = new CornerRadius(4),
            Background = _paper, BorderBrush = _track, BorderThickness = new Thickness(1) });
        cue.Children.Add(Glyph(symbol, 12, _ink, rotation));
        return cue;
    }
    private Button Add(Panel parent, string label, Action run) => Add(parent, MakeButton(label), run);
    private Button Add(Panel parent, Button button, Action run)
    {
        button.Click += (_,_) => { if (button.IsEnabled) { _returnTo = button; run(); } };
        parent.Children.Add(button); _navigation.Add(button); return button;
    }
    private Button ToolsEntry => _state?.Lesson.Phase switch { "ready" => _ready.Tools, "result" => _footerTools, _ => _lessonTools };
    private void Send(string id)
    {
        if (_state is not { } state) return;
        ActionRequested?.Invoke(new(id, id == "setup-start" ? state.Setup?.Selection : null,
            id == "setup-restore" ? state.Setup?.Recovery?.Value : null, state.Lesson.Key));
    }
    private void Primary()
    {
        if (!_main.IsEnabled) return;
        if (_loadError.Length > 0 || _state?.Retry == true) { _main.IsEnabled = false; ActionRequested?.Invoke(new("reload")); return; }
        switch (_view)
        {
            case "confirm": Send("finish-confirmed"); break;
            case "voice": ActionRequested?.Invoke(new("voice")); break;
            case "record": MoveRecord(1); break;
            default:
                _returnTo = null;
                if (_state?.Lesson.Primary == "finish") OpenView("confirm");
                else if (_state is { } state) Send(state.Lesson.Primary);
                break;
        }
    }
    private void MoveRecord(int offset)
    {
        int next = _recordIndex + offset;
        if (_view != "record" || _state is null || next < 0 || next >= _state.Lesson.Records.Length) return;
        var source = offset > 0 ? _footerPrimary : _previous;
        var focused = source.IsFocused;
        _recordIndex = next;
        _bodyScroll.Offset = default;
        Paint();
        if (focused && !source.IsEnabled) (_footerPrimary.IsEnabled ? _footerPrimary : _recordBack).Focus();
    }
    private void OpenView(string name)
    {
        _voiceFromTools = name == "voice" && _view == "tools";
        _view = name; _bodyScroll.Offset = default;
        if (name == "voice") _voice = "";
        Paint(); FocusAction(null, Key.Home);
    }
    internal void SetVoiceText(string text)
    {
        if (_view != "voice" || string.IsNullOrWhiteSpace(text) || _voice == text) return;
        _voice = text; Paint();
    }
    private void OpenMessage()
    {
        if (string.IsNullOrWhiteSpace(_caption.Text)) return;
        _messageReader.Open(_messageTitle, _caption.Text);
        ChangeSurface();
        _messageReader.FocusFirst();
    }
    private void CloseMessage()
    {
        if (!_messageReader.IsVisible) return;
        _messageReader.IsVisible = false;
        ChangeSurface();
        if (_readMessage.IsEffectivelyVisible) _readMessage.Focus();
        else RestoreFocus();
    }
    private void PaintTools(CardQuizWheelState state)
    {
        var lesson = state.Lesson;
        // A save briefly disables the web actions. Preserve the ring and the position of each tool until it finishes.
        foreach (var tool in _toolButtons)
        {
            tool.IsEnabled = !lesson.Busy;
            if (lesson.Busy) continue;
            if (tool == _toolsMenu) { tool.IsVisible = lesson.Phase == "result"; continue; }
            var action = Array.Find(state.Actions, item => item.Id == tool.ActionId);
            var belongsInTools = tool.ActionId switch {
                "collect" => lesson.Phase == "result" && lesson.Primary != "collect",
                "edit" => lesson.Phase != "ready" || lesson.CanChooseType,
                "exempt" => lesson.Phase == "result",
                _ => true
            };
            tool.IsVisible = tool.ActionId == "voice" || belongsInTools && action?.Enabled == true;
            if (tool.IsVisible) tool.SetAction(action);
        }
        if (lesson.Busy) return;
        var visible = _toolButtons.Where(tool => tool.IsVisible).ToArray();
        for (var i = 0; i < visible.Length; i++) visible[i].Place(i, visible.Length);
    }

    internal void Update(CardQuizWheelState state)
    {
        var phaseChanged = _state?.Lesson.Phase != state.Lesson.Phase;
        var returnToLesson = phaseChanged || (_state?.Panel == "options" && state.Panel.Length == 0 &&
            _state.Lesson.Option != state.Lesson.Option);
        var toolError = _view == "tools" && state.Panel.Length == 0 && state.Error && state.Feedback.Length > 0 &&
            (_state?.Error != true || _state.Feedback != state.Feedback);
        if (state.Retry && _state?.Retry != true) _bodyScroll.Offset = default;
        var previousPrimary = ActivePrimary;
        var wasPrimary = previousPrimary.IsFocused;
        var wasDetail = DetailVisible;
        var hadDetailFocus = _detail.IsKeyboardFocusWithin || _cardRing.IsKeyboardFocusWithin;
        var wasRing = _cardRing.IsVisible;
        var wasReader = BrowserDetailVisible;
        var previousBounds = BrowserDetailBounds;
        var readyError = state is { Error:true, Feedback.Length:>0, Lesson.Phase:"ready", Panel.Length:0 } &&
            (_state?.Error != true || state.Feedback != _state.Feedback);
        if (_messageReader.IsVisible && (phaseChanged || state.Panel.Length != 0))
        {
            _messageReader.IsVisible = false;
            ChangeSurface();
        }
        _state = state; _loadError = "";
        if (returnToLesson && _view == "tools") { _returnTo = null; _focusPending = true; }
        if (returnToLesson && _view != "voice" || toolError)
        {
            _view = "";
            _bodyScroll.Offset = default;
        }
        if (toolError) { _returnTo = ToolsEntry; _focusPending = true; }
        if (state.Lesson.Phase == "home" && phaseChanged) _recordIndex = 0;
        if (SetupVisible)
        {
            if (state.Setup is null) CloseSetup(false);
            else _setup.Update(state);
        }
        var detail = state.Panel.Length != 0;
        var card = state.CardPanel;
        var radial = card is { Radial:true };
        if (radial) _cardRing.Update(card!, state.Lesson);
        _cardRing.IsVisible = radial;
        _detail.IsVisible = detail && !radial;
        if (_detail.IsVisible) _detail.Update(state.DiscPage ?? new(state.Panel, "reader", state.PanelTitle, []));
        if (!detail && wasDetail) _detail.Clear();
        if (detail != wasDetail || radial != wasRing || wasReader != BrowserDetailVisible || previousBounds != BrowserDetailBounds)
        {
            ChangeSurface();
            if (radial && IsVisible) _cardRing.FocusCard(card!.Located);
            else if (detail && !BrowserDetailVisible && IsVisible) _detail.FocusPage();
            if (!detail) _focusPending = true;
        }
        Paint();
        if (readyError && _ready.IsEffectivelyVisible) { OpenMessage(); return; }
        if (wasPrimary && (previousPrimary != ActivePrimary || !ActivePrimary.IsEnabled)) { _returnTo = null; _focusPending = true; }
        // The overlay can keep logical focus while PPT owns the foreground. Replace a dismissed
        // control's focus in the same wheel, even on systems that leave the overlay inactive.
        RestorePendingFocus(wasDetail && !detail && hadDetailFocus);
    }
    private void Paint()
    {
        var state = _state; var lesson = state?.Lesson; var phase = lesson?.Phase ?? "loading";
        var view = _view.Length == 0 ? phase : _view;
        var failed = _loadError.Length != 0 || state?.Retry == true;
        if (failed) view = "error";
        var collecting = view is "collect" or "paused";
        var multi = lesson?.Kind == "multiple";
        var record = view == "record" ? lesson?.Records.ElementAtOrDefault(_recordIndex) : null;
        var hasResult = view == "result" || record?.Bars != null;
        var bars = record?.Bars ?? lesson?.Bars ?? [];
        var moreBars = hasResult && bars.Length > VisibleBars;
        var answered = record?.Received ?? lesson?.Received ?? 0;
        var expected = record?.Expected ?? lesson?.Expected ?? 0;
        var incomplete = record?.Incomplete ?? lesson?.Incomplete ?? 0;
        var abstained = record?.Abstained ?? lesson?.Abstained ?? 0;
        var mainText = view switch {
            "error" => "重读记录", "confirm" => "确认结课",
            "voice" => "开始说话", "record" => "下一题", _ => lesson?.Label ?? "正在读取" };
        _main.IsEnabled = failed || (view == phase ? lesson?.Enabled == true : view != "confirm" || lesson?.Busy == false);
        _heading.Text = view switch { "error" => "记录待核对", "confirm" => "结束这堂课？",
            "voice" => "和班班说话", "done" => "已结课",
            "record" => $"第 {_recordIndex+1} 题",
            "collect" or "paused" when multi => $"第{lesson!.Number}题", _ => lesson?.Heading ?? "班班课堂" };
        if (moreBars) _heading.Text += $" · {bars.Length} 组";
        var headingTip = view == "home" ? _heading.Text : null;
        if (!Equals(ToolTip.GetTip(_heading), headingTip)) ToolTip.SetTip(_heading, headingTip);
        string caption = view switch {
            "error" => _loadError.Length > 0 ? _loadError : state!.Feedback,
            "confirm" => $"将保存 {lesson!.QuestionCount} 道题",
            "home" or "ready" or "result" or "done" => lesson!.Caption,
            "record" => record?.Bars != null
                ? string.Join(" · ", new[] { record.Incomplete > 0 ? $"未完成 {record.Incomplete}" : null,
                    record.Unanswered > 0 ? $"未答 {record.Unanswered}" : null,
                    record.Abstained > 0 ? $"弃权 {record.Abstained}" : null }.OfType<string>())
                : "暂无正式收答",
            "voice" => _voice, _ => "" };
        _emptyResult.IsVisible = hasResult && answered == 0;
        _emptyCount.IsVisible = _emptyResult.IsVisible && expected > 0;
        if (_emptyCount.IsVisible)
        {
            _emptyCount.Text = $"0 / {expected}";
            AutomationProperties.SetName(_emptyCount, $"已答 0 人，应答 {expected} 人");
        }
        if (_emptyResult.IsVisible)
        {
            _emptyResult.Text = expected == 0 ? "全员免答" : abstained > 0 ? $"弃权 {abstained} 人" : incomplete > 0 ? "暂无完整作答" : "无人作答";
            if (incomplete == 0) caption = "";
        }
        if (!failed && _view.Length == 0 && state is { Feedback.Length: >0 } &&
            (state.Error || state.Status == state.Feedback || phase == "home" && state.Setup?.Notice.Length > 0))
            caption = state.Feedback;
        _caption.Text = caption;
        _messageTitle = view switch { "error" => "记录待核对", "voice" => "班班回复", "done" => "同步状态", _ => state?.Error == true ? "课堂提示" : "课堂状态" };
        _readMessage.IsVisible = view != "ready" && (caption.Length > 22 || caption.Contains('\n'));
        _readMessage.Content = view switch { "voice" => "看回复", "error" => "看原因", _ => "看详情" };
        AutomationProperties.SetName(_readMessage, _messageTitle + "详情");
        _messageReader.SetRetry(failed ? "重读记录" : view == "done" && lesson?.NeedsSync == true ? "重试同步" : null,
            failed || lesson?.Busy == false);
        _heading.IsVisible = view != "done" || !_readMessage.IsVisible;
        _caption.IsVisible = caption.Length > 0 && !_readMessage.IsVisible;
        _caption.Foreground = state?.Error == true || failed ? _error : _sub;
        if (_messageReader.IsVisible && caption.Length > 0) _messageReader.Open(_messageTitle, caption);
        _ready.IsVisible = view == "ready";
        if (_ready.IsVisible) _ready.Update(lesson!, state!.Actions.Any(a => a.Id == "edit" && a.Enabled));
        _toolSurface.IsVisible = view == "tools";
        _lessonActions.IsVisible = collecting || view == "home";
        _footerPrimary.IsVisible = view is "result" or "confirm" or "record";
        _footer.IsVisible = _footerPrimary.IsVisible || view is "done" or "voice";
        _skipEmpty.IsVisible = view == "result" && lesson!.Primary == "collect" && lesson.QuestionCount < 100;
        _skipEmpty.IsEnabled = _skipEmpty.IsVisible && !lesson!.Busy && state!.Actions.Any(action => action.Id == "next" && action.Enabled);
        var showChart = hasResult && answered > 0;
        _caption.FontSize = showChart ? 14 : 15;
        _caption.LineHeight = showChart ? 16 : 18;
        var topSpace = showChart ? 0 : _footerPrimary.IsVisible && !_skipEmpty.IsVisible ? 20 : 44;
        var bottomSpace = showChart || view == "done" ? 67 : _footer.IsVisible ? 58 : 44;
        _face.Margin = new Thickness(20, showChart ? 17 : 20, 20, 20);
        _face.RowDefinitions[0].Height = new GridLength(topSpace);
        _face.RowDefinitions[2].Height = new GridLength(bottomSpace);
        _bodyScroll.IsVisible = !_toolSurface.IsVisible && !_ready.IsVisible;
        _main.IsVisible = _bodyScroll.IsVisible && !_lessonActions.IsVisible && !_footerPrimary.IsVisible;
        if (_main.IsVisible)
        {
            var glyph = view switch { "error" => "rotate-ccw", "voice" => "mic", "done" => "arrow-left",
                "loading" => "loader-circle", _ => "play" };
            _main.SetFace(mainText, mainText, glyph);
        }
        _bodyScroll.Width = collecting ? 122 : view == "home" ? 110 : double.NaN;
        _bodyScroll.Height = _lessonActions.IsVisible ? 96 : double.NaN;
        _bodyScroll.VerticalAlignment = _lessonActions.IsVisible ? VerticalAlignment.Center : VerticalAlignment.Stretch;
        if (_toolSurface.IsVisible) PaintTools(state!);
        _count.IsVisible = collecting || view == "done";
        _number.FontSize = collecting ? (multi ? 28 : 32) : 38;
        _number.LineHeight = collecting ? (multi ? 32 : 36) : 40;
        _number.Text = (view == "done" ? lesson!.QuestionCount : lesson?.Received ?? 0).ToString();
        _total.Text = view == "done" ? "道题" : $"/ {lesson?.Expected ?? 0} 人";
        AutomationProperties.SetName(_number,view == "done" ? $"{_number.Text} 道题" : $"已收 {_number.Text}，应收 {lesson?.Expected ?? 0} 人");
        _optionBadge.IsVisible = collecting && multi;
        if (_optionBadge.IsVisible) _currentOption.Text = $"收 {lesson!.Option} 项";
        var presentAgain = multi && lesson!.Option != "A" && lesson.Received == 0;
        _cardDirections.IsVisible = view == "collect" && (multi || lesson?.Kind == "boolean") && !presentAgain;
        var raiseToSelect = multi && lesson?.NoCardPolicy == "abstain";
        _negativeDirection.IsVisible = !raiseToSelect;
        _raiseHint.IsVisible = raiseToSelect;
        var cardMeaning = raiseToSelect ? "选才举卡，A 朝上。改为不选时举 B。" :
            multi ? "A 朝上表示选，B 朝上表示不选" : "A 朝上表示对，B 朝上表示错";
        AutomationProperties.SetName(_cardDirections, cardMeaning);
        ToolTip.SetTip(_cardDirections, cardMeaning);
        _directions.Text = view == "paused" ? "已暂停 · 已保存" : presentAgain ? "放下再举" : lesson?.Phone == true ? "手机收答" : "";
        _directions.IsVisible = collecting && !_cardDirections.IsVisible && _directions.Text.Length > 0;
        AutomationProperties.SetHelpText(_currentOption, _optionBadge.IsVisible ? cardMeaning.TrimEnd('。') + "。换项时放下再举卡。" : "");
        _bars.IsVisible = _barScale.IsVisible = _answered.IsVisible = showChart;
        _chartDetails.IsVisible = _chartCue.IsVisible = view == "result" || view == "record" && moreBars;
        _chartDetails.IsEnabled = _chartDetails.IsVisible && lesson?.Busy == false &&
            (view == "record" || state!.Actions.Any(a => a.Id == "distribution" && a.Enabled));
        var chartAction = moreBars ? $"查看全部 {bars.Length} 种作答组合" : "查看作答分布";
        AutomationProperties.SetName(_chartDetails, chartAction);
        if (!Equals(ToolTip.GetTip(_chartDetails), chartAction)) ToolTip.SetTip(_chartDetails, chartAction);
        if (showChart)
        {
            _answered.Text = $"已答 {answered} / {expected}";
            _barMax.Text = $"{answered} 人";
            AutomationProperties.SetName(_barScale, $"条形刻度，0 到 {answered} 人，按完整作答人数统计");
            AutomationProperties.SetName(_answered, $"已答 {answered} 人，应答 {expected} 人");
        }
        _heading.FontSize = _bars.IsVisible || collecting && multi ? 13 : collecting || view == "done" ? 15 : hasResult ? 16 : 17;
        _heading.LineHeight = _bars.IsVisible || collecting && multi ? 16 : collecting || hasResult || view == "done" ? 20 : 22;
        _heading.Foreground = _bars.IsVisible || collecting && multi ? _sub : _ink;
        _body.Spacing = _bars.IsVisible || collecting && multi ? 0 : collecting ? 1 : view == "done" ? 2 : 4;
        if (_bars.IsVisible)
        {
            var most = bars.Length > 0 ? bars.Max(bar => bar.Count) : 0;
            AutomationProperties.SetName(_bars, (record?.Kind ?? lesson!.Kind) == "multiple" ? "各作答组合的人数" : "各选项的人数");
            for (int i = 0; i < _barRows.Count; i++)
            {
                var row = _bars.Children[i];
                row.IsVisible = i < bars.Length;
                if (!row.IsVisible) continue;
                var (letter, fill, count) = _barRows[i];
                var bar = bars[i];
                var leading = most > 0 && bar.Count == most;
                letter.Text = bar.Label;
                count.Text = bar.Count.ToString();
                fill.Width = BarWidth * Math.Clamp((double)bar.Count / answered, 0, 1);
                fill.Background = leading ? _mark : _otherBar;
                letter.Foreground = count.Foreground = leading ? _accentInk : _sub;
                letter.FontWeight = count.FontWeight = leading ? FontWeight.Bold : FontWeight.Normal;
                AutomationProperties.SetName(row, $"{letter.Text}，{count.Text} 人" + (leading ? "，人数最多" : ""));
            }
        }
        // The shortcut menu also reads this fraction when a tool covers the classroom face.
        Progress.IsVisible = collecting || hasResult;
        var hasParticipation = phase is "collect" or "paused" or "result" || hasResult;
        Progress.Fraction = !failed && hasParticipation && expected > 0 ? Math.Clamp((double)answered / expected, 0, 1) : null;
        if (_lessonActions.IsVisible)
        {
            _homeVoice.IsVisible = _settings.IsVisible = !collecting;
            _lessonTools.IsVisible = _lessonSide.IsVisible = collecting;
            if (collecting) PaintCollectionActions(lesson!, view);
            else
            {
                _lessonPrimary.IsEnabled = _main.IsEnabled;
                _lessonPrimary.SetFace(mainText, mainText, "play");
                _settings.IsEnabled = state!.Setup is not null && !lesson!.Busy;
            }
            AutomationProperties.SetItemStatus(_lessonMenu, HasPendingHistory ? "有待同步课堂" : "");
        }
        if (_footer.IsVisible) PaintFooter(state!, view);
    }

    private void PaintFooter(CardQuizWheelState state, string view)
    {
        var lesson = state.Lesson;
        _footerTools.IsVisible = view == "result";
        _finish.IsVisible = view == "result" && lesson.Primary != "finish";
        _footerTools.IsEnabled = _finish.IsEnabled = _footerCancel.IsEnabled = !lesson.Busy;
        _records.IsVisible = view == "done" && lesson.Records.Length > 0;
        _sync.IsVisible = view == "done" && lesson.NeedsSync;
        _sync.IsEnabled = !lesson.Busy;
        _voiceBack.IsVisible = view == "voice";
        if (_voiceBack.IsVisible) _voiceBack.SetFace(_voiceFromTools ? "返回工具" : "返回课堂", "返回", "arrow-left");
        _footerPrimary.IsEnabled = _main.IsEnabled && (view != "record" || _recordIndex + 1 < lesson.Records.Length);
        _footerCancel.IsVisible = view == "confirm";
        _previous.IsVisible = _recordBack.IsVisible = view == "record";
        _previous.IsEnabled = _recordIndex > 0;
        switch (view)
        {
            case "confirm": _footerPrimary.SetFace("确认结课", "结课", "check"); break;
            case "record": _footerPrimary.SetFace("下一题", "下一题", "arrow-right"); break;
            case "result":
                _footerPrimary.SetFace(lesson.Label, lesson.Label, lesson.Primary switch {
                    "collect" => "rotate-ccw", "finish" => "check", _ => "arrow-right" });
                break;
        }
        int count = _footer.Children.Count(b => b.IsVisible), index = 0;
        foreach (BanbanToolSector sector in _footer.Children)
            if (sector.IsVisible) sector.Place(index++, count);
    }

    private void PaintCollectionActions(CardQuizLesson lesson, string view)
    {
        _lessonPrimary.IsEnabled = _main.IsEnabled && !lesson.Busy;
        _lessonTools.IsEnabled = _lessonSide.IsEnabled = !lesson.Busy;
        string glyph = view == "paused" ? "play" : lesson.Primary switch { "multi" => "skip-forward", "open-camera" => "camera", _ => "square" };
        var changingOption = lesson.Primary == "multi";
        _lessonPrimary.SetFace(lesson.Label, changingOption ? "下一项" : lesson.Label, glyph, quiet: changingOption);
        ToolTip.SetTip(_lessonPrimary, lesson.Label);
        int pending = lesson.Missing.Length;
        string status = lesson.Expected == 0 ? "全员免答" : pending > 0 ? $"待收 {pending} 人" : "已收齐";
        _lessonSide.SetFace(status + "，查看卡号", pending > 0 ? "待收" : lesson.Expected == 0 ? "免答" : "收齐",
            pending > 0 ? "list-checks" : "check", tally: pending > 0 ? pending : null);
        ToolTip.SetTip(_lessonSide, status);
    }

    internal void ShowError(string message)
    {
        _loadError = message; _state = null; _view = ""; _bodyScroll.Offset = default;
        _messageReader.IsVisible = false;
        _detail.IsVisible = _cardRing.IsVisible = false; CloseSetup(false); ChangeSurface();
        Paint(); if (IsVisible) _main.Focus();
    }
    internal bool BackFromSetup()
    {
        if (_messageReader.IsVisible) { CloseMessage(); return true; }
        if (SetupVisible && _setup.Busy) return true;
        if (_setup.ReturnToSettings() || CloseSetup(true)) return true;
        if (_view.Length == 0) return false;
        var toTools = _view == "voice" && _voiceFromTools && _state?.Lesson.Phase is ("ready" or "collect" or "paused" or "result");
        _returnTo = _view switch { "tools" => ToolsEntry,
            "voice" when toTools => _toolButtons.First(t => t.ActionId == "voice"),
            "voice" => _homeVoice, "confirm" => _state?.Lesson.Phase == "ready" ? _ready.Finish :
                _state?.Lesson is { Phase:"result", Primary:"finish" } ? _footerPrimary : _finish,
            "record" => _records, _ => _returnTo };
        _view = toTools ? "tools" : ""; _bodyScroll.Offset = default; Paint(); RestoreFocus(); return true;
    }
    internal void OpenSetup()
    {
        if (_state?.Setup is null || SetupVisible) return;
        _returnTo = _settings;
        _setup.Open(_state); ChangeSurface(); _setup.FocusFirst();
    }

    internal bool CloseSetup(bool restoreFocus)
    {
        if (!SetupVisible) return false;
        _setup.Close(); ChangeSurface(); if (restoreFocus) RestoreFocus(); return true;
    }
    internal void ResetView()
    {
        _messageReader.IsVisible = false; CloseSetup(false); ChangeSurface(); _view = ""; _returnTo = null; _bodyScroll.Offset = default; Paint();
    }
    private void ChangeSurface()
    {
        _disc.IsVisible = !DetailVisible && !SetupVisible && !_messageReader.IsVisible;
        _surface.Background = _disc.IsVisible ? _classroomTint : _pageTint;
        SurfaceChanged?.Invoke();
    }
    private void RestoreFocus()
    {
        _focusPending = false;
        if (_returnTo is { IsEffectivelyVisible:true, IsEnabled:true }) _returnTo.Focus();
        else if (ActivePrimary is { IsEffectivelyVisible:true, IsEnabled:true } primary) primary.Focus();
        else FocusAction(null,Key.Home);
    }
    internal void RestorePendingFocus(bool replacingDetail = false)
    {
        if (_focusPending && _main.IsEnabled && IsEffectivelyVisible && !SetupVisible && !DetailVisible &&
            !_messageReader.IsVisible && (replacingDetail || TopLevel.GetTopLevel(this) is Window { IsActive:true }))
            RestoreFocus();
    }
    internal void FocusFirstWhenReady() { _returnTo = null; _focusPending = !ActivePrimary.IsEnabled; if (!_focusPending) ActivePrimary.Focus(); }
    internal void FocusDetailBack()
    {
        if (_cardRing.IsVisible) _cardRing.FocusCard(null);
        else _detail.FocusPage();
    }
    internal void FocusAction(Control? current,Key key)
    {
        if (_ready.IsVisible) _ready.FocusAction(current, key);
        else BanbanClassroomStyle.StepFocus(_navigation, current, key);
    }
    internal bool ContainsInteractive(Point p) => DiscContains(p);
}
