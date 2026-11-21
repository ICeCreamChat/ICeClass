using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Controls.Shapes;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;

namespace ICeClass.Receiver;

internal sealed record CardQuizWheelAction(string Id, string Label, string Icon, bool Enabled);
internal sealed record CardQuizRecord(string Kind,int[] Counts,int Received,int Expected,int Unanswered,int Incomplete);
internal sealed record CardQuizLesson(string Phase, string Heading, string Caption, string Primary, string Label, bool Enabled,
    int Number, string Kind, string Option, int OptionCount, int Received, int Expected, int[] Missing, int[] Counts,
    bool CanChooseType, bool Busy, int QuestionCount, bool Phone, bool NeedsSync, CardQuizRecord[] Records, string Key);
internal sealed record CardQuizWheelState(bool HasSession, CardQuizWheelAction[] Actions, string Progress,
    string Status, string Feedback, bool Error, bool Multiple, bool MultiEnabled, bool CameraRunning, CardQuizWheelSetup? Setup,
    string Panel, string MultiLabel, bool Retry, CardQuizLesson Lesson);

/// <summary>The lesson panel displays only confirmed classroom state. The original pet remains beside it.</summary>
internal sealed class BanbanClassroomWheel : Canvas
{
    internal const double Diameter = 320, SurfaceHeight = Diameter;
    private readonly Grid _disc = new() { Width = Diameter, Height = Diameter };
    private const double Sweep = 276, BarWidth = 112;
    private readonly Arc _arcRail = ProgressArc(), _arc = ProgressArc();
    private readonly StackPanel _body = new() { Spacing = 5, VerticalAlignment = VerticalAlignment.Center };
    private readonly ScrollViewer _bodyScroll;
    private readonly TextBlock _heading = Label("", 20, true), _caption = Label("", 15), _complete = Label("",15,true);
    private readonly StackPanel _steps = Row();
    private readonly TextBlock _number = Label("", 42, true), _total = Label("", 16), _directions = Label("", 15);
    private readonly TextBlock _receivedLabel = Label("已收", 16);
    private readonly StackPanel _count = Row(), _types = Row(), _links = Row(), _homeTools = Row();
    private readonly Border _typeStrip;
    private readonly StackPanel _bars = new() { Spacing = 2, Width = 202, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly WrapPanel _cards = new() { Width = 192, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly WrapPanel _tools = new() { Width = 210, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly StackPanel _schedule = new() { Spacing = 5, Width = 200, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly Button _main = MakeButton("正在读取", true);
    private readonly Button _settings, _history, _more, _finish, _missing, _records, _sync, _previous, _next, _cancel;
    private readonly List<Button> _navigation = [];
    private readonly Dictionary<string,Button> _typeButtons = [], _toolButtons = [];
    private readonly List<(TextBlock Label, Border Fill, TextBlock Count)> _barRows = [];
    private readonly Border _detail = new() { Width = Diameter - 16, Height = SurfaceHeight - 16, CornerRadius = new CornerRadius(20), IsVisible = false };
    private readonly BanbanClassroomSetup _setup = new();
    private CardQuizWheelState? _state;
    private Button? _returnTo;
    private string _view = "", _loadError = "", _voice = "", _cardKey = "";
    private bool _focusPending;
    private int _recordIndex;
    private readonly IBrush _ink, _sub, _mark, _track, _paper, _error;
    internal bool SetupVisible => _setup.IsVisible;
    internal bool DetailVisible => _detail.IsVisible;
    internal Func<ClassroomHomeSnapshot?>? Timetable { get; set; }
    internal event Action? SetupViewChanged;
    internal event Action<CardQuizWheelCommand>? ActionRequested;
    internal string DockLabel => _state?.Retry == true || _loadError.Length>0 ? "待核对" : _state?.Lesson is { } lesson ? lesson.Phase switch
        { "paused" or "collect" => "已暂停", "ready" or "result" => $"第 {lesson.Number} 题", "done" => "已结课", _ => "课堂" } : "课堂";

    internal BanbanClassroomWheel()
    {
        Width = Diameter; Height = SurfaceHeight; IsVisible = false;
        var contrast = DesktopStyle.HighContrastEnabled();
        _ink = contrast ? Brushes.Black : DesktopStyle.Brush("#193C59");
        _sub = contrast ? Brushes.Black : DesktopStyle.Brush("#4E6C83");
        _mark = contrast ? Brushes.Black : DesktopStyle.Brush("#0B6DCC");
        _track = contrast ? DesktopStyle.Brush("#AAA") : DesktopStyle.Brush("#B6CBDD");
        _paper = contrast ? Brushes.White : DesktopStyle.Brush("#DCF8FDFF");
        _error = contrast ? Brushes.Black : DesktopStyle.Brush("#933D2D");
        _detail.Background = Brushes.White;
        var surface = new Border { Margin = new Thickness(5), CornerRadius = new CornerRadius(155),
            Background = ClassroomGlassHost.FloatingTint(contrast), IsHitTestVisible = false,
            BorderThickness = new Thickness(1), BorderBrush = contrast ? Brushes.Black : DesktopStyle.Brush("#A8C1D7"),
            BoxShadow = contrast ? default : BoxShadows.Parse("0 2 4 0 #26315A7F") };
        _arc.Stroke = _mark; _arcRail.Stroke = _track; _arcRail.SweepAngle = Sweep;
        _disc.Children.Add(surface);
        _disc.Children.Add(_arcRail);
        _disc.Children.Add(_arc);
        var face = new Canvas(); _disc.Children.Add(face); Children.Add(_disc);
        _main.Name = "ClassroomPrimary"; _main.Width = 134; _main.Height = 44;
        _main.Click += (_, _) => Primary();
        _navigation.Add(_main);
        Place(face, _main, 29, 196);
        _heading.Foreground = _number.Foreground = _ink;
        _caption.Foreground = _directions.Foreground = _total.Foreground = _receivedLabel.Foreground = _sub;
        foreach (char letter in "ABCD") _steps.Children.Add(new Border {
            Width = 32, Height = 26, CornerRadius = new CornerRadius(8), BorderThickness = new Thickness(1),
            Child = Label(letter.ToString(), 15, true) });
        _count.Spacing = 7;
        _count.Children.Add(_receivedLabel); _count.Children.Add(_number); _count.Children.Add(_total);
        _types.Spacing = 2;
        foreach (var (id,title) in new[] { ("single","单选"), ("boolean","判断"), ("multiple","多选") })
        {
            var button = Add(_types, title, () => Send("kind-" + id));
            button.Classes.Add("native-document"); button.Width = 59;
            _typeButtons[id] = button;
        }
        _typeStrip = new Border { Classes = { "classroom-tab-strip" }, Background = contrast ? Brushes.White : DesktopStyle.Brush("#B8D3E5F2"),
            BorderThickness = new Thickness(1), BorderBrush = _track, CornerRadius = new CornerRadius(16),
            Padding = new Thickness(2), HorizontalAlignment = HorizontalAlignment.Center, Child = _types };
        foreach (var item in new[] { ("schedule","课表","book-open"), ("voice","说话","mic") })
        {
            var button = Add(_homeTools, item.Item2, () => OpenView(item.Item1));
            button.Width = 85;
            button.Content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 7,
                Children = { ClassroomStyle.Icon(item.Item3, 17), new TextBlock { Text = item.Item2, VerticalAlignment = VerticalAlignment.Center } } };
        }
        foreach (var item in new[] { ("schedule","课表"), ("voice","说话"), ("camera","收答控制"), ("source","手机扫码"),
            ("exempt","核对卡号"), ("edit","题目与答案"), ("distribution","分布详情"), ("collect","重新收答"), ("next","添加题目") })
        {
            var (id,label) = item;
            var button = Add(_tools,label,() => { if (id is "schedule" or "voice") OpenView(id); else Send(id); });
            button.Width = 99; button.Padding = new Thickness(4, 4); button.Margin = new Thickness(3); _toolButtons[id] = button;
        }
        for (var i = 0; i < 4; i++)
        {
            var letter = Label("", 16, true); var amount = Label("", 16, true);
            letter.TextAlignment = TextAlignment.Left; amount.TextAlignment = TextAlignment.Right;
            var fill = new Border { Background = _mark, Height = 8, CornerRadius = new CornerRadius(4), HorizontalAlignment = HorizontalAlignment.Left };
            var rail = new Border { Width = BarWidth, Height = 8, CornerRadius = new CornerRadius(4), Background = _track, Child = fill };
            var row = new Grid { ColumnDefinitions = new ColumnDefinitions($"36,{BarWidth},*"), Children = { letter, rail, amount } };
            Grid.SetColumn(rail,1); Grid.SetColumn(amount,2); _bars.Children.Add(row); _barRows.Add((letter,fill,amount));
        }
        foreach (var child in new Control[] { _heading, _typeStrip, _steps, _count, _bars, _caption, _directions, _homeTools, _cards, _schedule, _tools })
            _body.Children.Add(child);
        _bodyScroll = new ScrollViewer { Height = 158, Content = _body, VerticalContentAlignment = VerticalAlignment.Center,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Place(face, _bodyScroll, 80, 228);
        _settings = Add(_links,"开课设置",() => { if (_state?.Setup is null) return; _setup.Open(_state); ChangeSurface(); _setup.FocusFirst(); });
        _history = Add(_links,"待同步课",() => Send("end-session"));
        _more = Add(_links,"课堂工具",() => OpenView("tools"));
        _finish = Add(_links,"结束课堂",() => OpenView("confirm"));
        _missing = Add(_links,"待收卡号",() => OpenView("missing"));
        _complete.Foreground = contrast ? Brushes.Black : DesktopStyle.Brush("#246543");
        AutomationProperties.SetLiveSetting(_complete,AutomationLiveSetting.Polite); _links.Children.Add(_complete);
        _records = Add(_links,"课堂记录",() => { _recordIndex = 0; OpenView("record"); });
        _sync = Add(_links,"重试同步",() => Send("sync-now"));
        _previous = Add(_links,"上一题",() => { _recordIndex--; Paint(); });
        _next = Add(_links,"下一题",() => { _recordIndex++; Paint(); });
        _cancel = Add(_links,"取消",() => BackFromSetup());
        foreach (var button in _links.Children.OfType<Button>())
        {
            button.Classes.Add("native-document");
            button.Padding = new Thickness(8, 4);
        }
        Place(face, _links, 241, 222);
        _setup.BackRequested += () => CloseSetup(true);
        _setup.ActionRequested += command => ActionRequested?.Invoke(command);
        Children.Add(_detail); SetTop(_detail,8); SetLeft(_detail,8);
        Children.Add(_setup); SetTop(_setup,BanbanClassroomSetup.Top); SetLeft(_setup,(Diameter-_setup.Width)/2);
        AutomationProperties.SetName(this,"班班课堂");
        AutomationProperties.SetLiveSetting(_heading, AutomationLiveSetting.Polite);
        AutomationProperties.SetLiveSetting(_number, AutomationLiveSetting.Polite);
        AutomationProperties.SetLiveSetting(_caption, AutomationLiveSetting.Polite);
        KeyDown += (_, e) =>
        {
            if (SetupVisible || DetailVisible || e.Key is not (Key.Left or Key.Right or Key.Home or Key.End)) return;
            FocusAction(_navigation.Find(b=>b.IsKeyboardFocusWithin),e.Key); e.Handled = true;
        };
        Paint();
    }

    private static Arc ProgressArc() => new() { Width = 286, Height = 286, StartAngle = -48, StrokeThickness = 3,
        StrokeLineCap = PenLineCap.Round, IsHitTestVisible = false };
    private static TextBlock Label(string text, double size, bool bold = false)
    {
        var label = ClassroomStyle.Text(text, size, bold);
        label.TextAlignment = TextAlignment.Center; label.VerticalAlignment = VerticalAlignment.Center;
        label.LineHeight = size * 1.32;
        return label;
    }
    private static StackPanel Row() => new() { Orientation = Orientation.Horizontal, Spacing = 5,
        HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private static Button MakeButton(string label,bool primary=false)
    {
        var button = ClassroomStyle.Button(label, primary);
        if (!primary) button.FontSize = 16;
        button.Padding = new Thickness(9, 4);
        AutomationProperties.SetName(button,label);
        return button;
    }
    private Button Add(Panel parent,string label,Action run)
    {
        var button = MakeButton(label);
        button.Click += (_,_) => { if (button.IsEnabled) { _returnTo = button; run(); } };
        parent.Children.Add(button); _navigation.Add(button); return button;
    }
    private static void Place(Canvas parent,Control child,double y,double width)
    {
        var holder = new Grid { Width = width, Children = {child} };
        child.HorizontalAlignment = HorizontalAlignment.Center;
        if (child is ScrollViewer) child.Width = width;
        SetLeft(holder,(Diameter-width)/2); SetTop(holder,y); parent.Children.Add(holder);
    }
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
            case "tools": case "missing": case "schedule": case "record": BackFromSetup(); break;
            default:
                _returnTo = null;
                if (_state?.Lesson.Primary == "finish") OpenView("confirm");
                else if (_state is { } state) Send(state.Lesson.Primary);
                break;
        }
    }
    private void OpenView(string name)
    {
        _view = name; _bodyScroll.Offset = default;
        if (name == "schedule") RefreshSchedule();
        if (name == "voice") _voice = "点击说话后，请对着麦克风讲话。";
        Paint(); _main.Focus();
    }
    internal void SetVoiceText(string text)
    {
        if (_view != "voice" || string.IsNullOrWhiteSpace(text) || _voice == text) return;
        _voice = text; Paint();
    }
    private void RefreshSchedule()
    {
        _schedule.Children.Clear();
        var snapshot = Timetable?.Invoke();
        if (snapshot?.ScheduleKnown != true || snapshot.Lessons.Count == 0)
        { _schedule.Children.Add(Label(snapshot?.ScheduleKnown == true ? "今天没有排课" : "尚未同步课表",16)); return; }
        foreach (var lesson in snapshot.Lessons)
        {
            var name = (lesson.Current ? "此刻 · " : lesson.Next ? "下节 · " : "") + lesson.Name;
            var row = new Grid { ColumnDefinitions = new ColumnDefinitions("*,88") };
            var subject = Label(name,15,lesson.Current || lesson.Next); subject.TextAlignment = TextAlignment.Left;
            var time = Label(lesson.Start+"-"+lesson.End,14); time.Foreground = _sub;
            row.Children.Add(subject); row.Children.Add(time); Grid.SetColumn(time,1); _schedule.Children.Add(row);
        }
    }

    internal void Update(CardQuizWheelState state)
    {
        var phaseChanged = _state?.Lesson.Phase != state.Lesson.Phase;
        var wasPrimary = _main.IsFocused;
        _state = state; _loadError = "";
        if (phaseChanged && _view != "voice" && _view != "schedule") _view = "";
        if (state.Lesson.Phase == "home" && phaseChanged) _recordIndex = 0;
        if (SetupVisible)
        {
            if (state.Setup is null) CloseSetup(false);
            else _setup.Update(state);
        }
        var detail = state.Panel.Length != 0;
        if (detail != DetailVisible)
        {
            _detail.IsVisible = detail; ChangeSurface();
            if (!detail) _focusPending = true;
        }
        Paint();
        if (wasPrimary && !_main.IsEnabled) _focusPending = true;
        if (_focusPending && _main.IsEnabled && IsVisible && !SetupVisible && !detail && TopLevel.GetTopLevel(this) is Window { IsActive:true })
            RestoreFocus();
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
        var mainText = view switch {
            "error" => "重读记录", "confirm" => "确认结课", "tools" or "schedule" => "返回课堂",
            "missing" => "返回收答", "voice" => "开始说话", "record" => "返回汇总", _ => lesson?.Label ?? "正在读取" };
        _main.Content = mainText; AutomationProperties.SetName(_main,mainText);
        _main.IsEnabled = failed || (view == phase ? lesson?.Enabled == true : view != "confirm" || lesson?.Busy == false);
        _heading.Text = view switch { "error" => "课堂记录待读取", "confirm" => "结束这堂课？", "tools" => "课堂工具",
            "schedule" => "今日课表", "voice" => "和班班说话", "missing" => "待收卡号",
            "record" => $"第 {_recordIndex+1} 题 · 选择分布", _ => lesson?.Heading ?? "班班课堂" };
        _heading.FontSize = view == "home" ? 24 : 20;
        _heading.LineHeight = _heading.FontSize * 1.32;
        string caption = view switch {
            "error" => _loadError.Length > 0 ? _loadError : state!.Feedback,
            "confirm" => $"将保存 {lesson!.QuestionCount} 道题的课堂记录",
            "home" or "ready" or "result" or "done" => lesson!.Caption,
            "missing" when lesson!.Missing.Length == 0 => "已收齐",
            "record" => record is { Counts.Length: >0 } ? $"已答 {record.Received} · " + (record.Incomplete>0 ? $"未完成 {record.Incomplete} · " : "") + $"未答 {record.Unanswered}" : "本题没有正式收答",
            "voice" => _voice, "loading" => "正在读取本机名单…", _ => "" };
        if (state is { Error:true } && !failed && _view.Length == 0) caption = state.Feedback;
        else if (state is not null && _view.Length == 0 && (state.Status == state.Feedback || phase == "home" && state.Setup?.Notice.Length > 0) && state.Feedback.Length > 0)
            caption = string.IsNullOrEmpty(caption) ? state.Feedback : caption + "\n" + state.Feedback;
        _caption.Text = caption;
        _caption.IsVisible = caption.Length > 0;
        _caption.Foreground = state?.Error == true || failed ? _error : _sub;
        _typeStrip.IsVisible = view == "ready" && lesson!.CanChooseType;
        foreach (var (type,button) in _typeButtons)
        {
            button.Classes.Set("selected",type==lesson?.Kind); button.IsEnabled = lesson?.Busy == false;
            AutomationProperties.SetItemStatus(button,type==lesson?.Kind ? "已选" : "");
        }
        _homeTools.IsVisible = view == "home"; _tools.IsVisible = view == "tools"; _schedule.IsVisible = view == "schedule";
        foreach (var (id,button) in _toolButtons)
        {
            var action = state?.Actions.FirstOrDefault(a=>a.Id==id);
            button.IsVisible = id is "schedule" or "voice" || action?.Enabled == true && (id != "collect" || phase == "result");
            if (id == "source" && action is not null) { button.Content = action.Label; AutomationProperties.SetName(button,action.Label); }
        }
        _count.IsVisible = collecting || view == "done";
        _receivedLabel.IsVisible = collecting;
        _number.Text = (view == "done" ? lesson!.QuestionCount : lesson?.Received ?? 0).ToString();
        _total.Text = view == "done" ? "道题" : $"/ {lesson?.Expected ?? 0} 人";
        AutomationProperties.SetName(_number,view == "done" ? $"{_number.Text} 道题" : $"已收 {_number.Text}，应收 {lesson?.Expected ?? 0} 人");
        _number.FontSize = multi && collecting ? 34 : 42;
        _number.LineHeight = multi && collecting ? 38 : 49;
        _steps.IsVisible = collecting && multi;
        if (_steps.IsVisible)
        {
            for (int i=0;i<_steps.Children.Count;i++)
            {
                var step = (Border)_steps.Children[i]; var label = (TextBlock)step.Child!;
                step.IsVisible = i<lesson!.OptionCount; var current = label.Text==lesson.Option;
                step.Background = current ? _mark : _paper; step.BorderBrush = current ? _mark : _track;
                label.Foreground = current ? Brushes.White : _sub;
                AutomationProperties.SetName(step,label.Text+" 项"+(current ? "，当前收答" : ""));
            }
        }
        _directions.IsVisible = collecting && (multi || lesson?.Kind == "boolean" || lesson?.Phone == true);
        _directions.Text = multi ? "A 朝上选 · B 朝上不选\n换项时放下再举卡" : lesson?.Kind == "boolean" ? "A 对 · B 错" : "手机收答";
        _bars.IsVisible = view == "result" || record?.Counts.Length > 0;
        if (_bars.IsVisible)
            for (int i=0;i<_barRows.Count;i++)
            {
                var values = record?.Counts ?? lesson!.Counts;
                var show = i < values.Length; _bars.Children[i].IsVisible = show; if (!show) continue;
                var (letter,fill,count) = _barRows[i]; letter.Text = (record?.Kind ?? lesson!.Kind)=="boolean" ? (i==0 ? "A 对" : "B 错") : "ABCD"[i].ToString();
                var answered = record?.Received ?? lesson!.Received;
                count.Text = values[i]+" 人";
                fill.Width = answered <= 0 ? 0 : BarWidth * Math.Clamp((double)values[i] / answered, 0, 1);
                count.Foreground = values[i] > 0 ? _ink : _sub;
                AutomationProperties.SetName(_bars.Children[i], $"{letter.Text}，{count.Text}");
            }
        _cards.IsVisible = view == "missing";
        if (_cards.IsVisible && _cardKey != string.Join(",",lesson!.Missing))
        {
            _cards.Children.Clear(); _cardKey = string.Join(",",lesson.Missing);
            foreach (var n in lesson.Missing)
            {
                var tag = new Border { Margin = new Thickness(2), Width = 42, Padding = new Thickness(2,3),
                    CornerRadius = new CornerRadius(8), Background = _paper, BorderBrush = _track, BorderThickness = new Thickness(1),
                    Child = Label(n.ToString(),16,true) };
                AutomationProperties.SetName(tag,$"{n} 号卡"); _cards.Children.Add(tag);
            }
        }
        _arcRail.IsVisible = collecting && lesson?.Expected > 0;
        _arc.IsVisible = _arcRail.IsVisible && lesson!.Received > 0;
        if (_arc.IsVisible) _arc.SweepAngle = Sweep * Math.Clamp((double)lesson!.Received / lesson.Expected, 0, 1);
        _settings.IsVisible = view == "home" && state?.Setup is not null;
        _history.IsVisible = view == "home" && state?.Actions.Any(a=>a.Id=="end-session" && a.Enabled)==true;
        _more.IsVisible = view is "ready" or "result" or "paused" or "collect";
        _finish.IsVisible = view is "ready" or "result";
        _missing.IsVisible = collecting && lesson?.Missing.Length > 0; _missing.IsEnabled = _missing.IsVisible;
        _complete.IsVisible = collecting && lesson?.Missing.Length == 0;
        var missingText = lesson?.Expected==0 ? "无人须答" : lesson?.Missing.Length>0 ? $"待收 {lesson.Missing.Length} 人" : "已收齐";
        _missing.Content = missingText; AutomationProperties.SetName(_missing,_missing.IsEnabled ? missingText+"，查看卡号" : missingText);
        _complete.Text = missingText;
        _records.IsVisible = view=="done" && lesson!.Records.Length>0;
        _sync.IsVisible = view=="done" && lesson!.NeedsSync; _sync.IsEnabled = lesson?.Busy == false;
        _previous.IsVisible = _next.IsVisible = view=="record";
        _previous.IsEnabled = _recordIndex>0; _next.IsEnabled = _recordIndex+1 < lesson?.Records.Length;
        _cancel.IsVisible = view is "confirm" or "voice";
        _cancel.Content = view=="voice" ? "返回课堂" : "取消"; AutomationProperties.SetName(_cancel,(string)_cancel.Content);
    }

    internal void ShowError(string message)
    {
        _loadError = message; _state = null; _view = ""; _detail.IsVisible = false; CloseSetup(false); ChangeSurface();
        Paint(); if (IsVisible) _main.Focus();
    }
    internal bool BackFromSetup()
    {
        if (_setup.ReturnToSettings() || CloseSetup(true)) return true;
        if (_view.Length == 0) return false;
        _view = ""; _bodyScroll.Offset = default; Paint(); RestoreFocus(); return true;
    }
    internal bool CloseSetup(bool restoreFocus)
    {
        if (!SetupVisible) return false;
        _setup.Close(); ChangeSurface(); if (restoreFocus) RestoreFocus(); return true;
    }
    internal void ResetView()
    {
        CloseSetup(false); _view = ""; _returnTo = null; _bodyScroll.Offset = default; Paint();
    }
    private void ChangeSurface() { _disc.IsVisible = !DetailVisible && !SetupVisible; SetupViewChanged?.Invoke(); }
    private void RestoreFocus()
    {
        _focusPending = false;
        if (_returnTo is { IsEffectivelyVisible:true, IsEnabled:true }) _returnTo.Focus();
        else FocusAction(null,Key.Home);
    }
    internal void FocusFirstWhenReady() { _returnTo = null; _focusPending = !_main.IsEnabled; if (!_focusPending) _main.Focus(); }
    internal void FocusAction(Control? current,Key key)
    {
        var enabled = _navigation.Where(b=>b.IsEffectivelyVisible && b.IsEnabled).ToList();
        if (enabled.Count == 0) return;
        var i = enabled.FindIndex(b=>b==current);
        int next = key switch { Key.Home => 0, Key.End => enabled.Count-1, Key.Left or Key.Up => (i-1+enabled.Count)%enabled.Count, _ => (i+1)%enabled.Count };
        enabled[next].Focus();
    }
    internal bool ContainsInteractive(Point p)
    {
        if (DetailVisible) return _detail.Bounds.Contains(p);
        if (SetupVisible) return _setup.Bounds.Contains(p);
        var delta = p - new Point(Diameter/2,Diameter/2);
        return delta.X*delta.X + delta.Y*delta.Y <= 155*155;
    }
}
