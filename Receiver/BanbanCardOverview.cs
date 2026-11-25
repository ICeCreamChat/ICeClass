using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using static ICeClass.Receiver.BanbanClassroomStyle;

namespace ICeClass.Receiver;

internal sealed record CardQuizCardMark(int Number, string State);
internal sealed record CardQuizCardPanel(bool Overview, bool Radial, bool Grouped, bool PendingOnly, int Page, int Pages, CardQuizCardMark[] Cards, bool ReadOnly, int? Located);

/// <summary>Printed numbers stay clockwise. Only the detail face can exempt a card.</summary>
internal sealed class BanbanCardOverview : Canvas
{
    private const int GroupsPerPage = 6;
    private readonly Canvas _ring = new() { Width = BanbanClassroomWheel.Diameter, Height = BanbanClassroomWheel.Diameter };
    private readonly Button _back = MakeButton("返回");
    private readonly Button _scope = MakeButton("查看全班卡号");
    private readonly TextBlock _scopeLabel = Text("", 13, true);
    private readonly Border _scopeIcon = new();
    private readonly Border _hubFooter = new();
    private readonly StackPanel _backRow = new() { Orientation = Orientation.Horizontal, Spacing = 3, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly BanbanToolSector _previous, _next;
    private readonly TextBlock _title = Text("", 14, true), _count = Text("", 26, true), _total = Text("", 13);
    private readonly TextBlock _pageLabel = Text("", 12, muted: true);
    private readonly StackPanel _key = new() { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Spacing = 4 };
    private readonly List<(int Number, BanbanToolSector Button)> _cards = [];
    private readonly bool _contrast = DesktopStyle.HighContrastEnabled();
    private readonly IBrush _accent;
    private CardQuizCardPanel? _panel;
    private CardQuizLesson? _lesson;
    private int _groupPage;
    private int[] _visibleNumbers = [];
    internal event Action<string,int?>? ActionRequested;

    internal BanbanCardOverview()
    {
        Width = Height = BanbanClassroomWheel.Diameter;
        IsVisible = false;
        _accent = _contrast ? Brushes.Black : DesktopStyle.Brush("#005DBF");
        RoundButton(_back, 108);
        _title.LineHeight = 17;
        _count.LineHeight = 27;
        _total.FontSize = 13;
        _total.LineHeight = 16;
        _count.Foreground = _accent;
        _total.VerticalAlignment = VerticalAlignment.Bottom; _total.Margin = new Thickness(0, 0, 0, 4);
        var tally = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2, HorizontalAlignment = HorizontalAlignment.Center,
            Children = { _count, _total } };
        _pageLabel.FontSize = 12;
        _pageLabel.LineHeight = 16;
        _pageLabel.HorizontalAlignment = HorizontalAlignment.Center;
        _pageLabel.VerticalAlignment = VerticalAlignment.Center;
        var backLabel = Text("返回", 13, true);
        backLabel.FontSize = 13;
        backLabel.LineHeight = 16;
        var back = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 3, HorizontalAlignment = HorizontalAlignment.Center,
            Children = { Glyph("arrow-right", 13, _accent, 180), backLabel } };
        _backRow.Children.Add(back);
        _backRow.Children.Add(_pageLabel);
        _hubFooter.Child = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Children = { _key, _backRow } };
        _title.TextAlignment = TextAlignment.Center;
        _back.Content = new StackPanel { Width = _back.Width, Children = { _title, tally, _hubFooter } };
        SetLeft(_back, (Width - _back.Width) / 2); SetTop(_back, (Height - _back.Height) / 2);
        _back.Click += (_, _) => ActionRequested?.Invoke("back", null);
        // Both hit targets stay inside the empty hub (ring sectors start at radius 56).
        RoundButton(_scope, 44);
        _scope.IsVisible = false;
        _scopeLabel.FontSize = 13;
        _scopeLabel.LineHeight = 16;
        _scopeLabel.Foreground = _accent;
        _scopeLabel.TextAlignment = TextAlignment.Center;
        _scope.Content = new StackPanel { Spacing = 1, Children = { _scopeIcon, _scopeLabel } };
        SetLeft(_scope, Width / 2 + 1); SetTop(_scope, Height / 2 - 1);
        _scope.Click += (_, _) => {
            if (_scope.IsEffectivelyVisible && _scope.IsEnabled) ActionRequested?.Invoke("card-scope", null);
        };
        BanbanToolSector Page(string action, string label, string icon) {
            var button = new BanbanToolSector(action, _contrast, _accent, BanbanToolSector.Band.Setup);
            button.SetFace(label + "卡号", action == "card-prev" ? "上页" : "下页", icon);
            button.Click += (_, _) => TurnPage(action == "card-prev" ? -1 : 1);
            return button;
        }
        _previous = Page("card-prev", "上一页", "arrow-left");
        _next = Page("card-next", "下一页", "arrow-right");
        Children.Add(_ring); Children.Add(_previous); Children.Add(_next); Children.Add(_back); Children.Add(_scope);
        AutomationProperties.SetLiveSetting(tally, AutomationLiveSetting.Polite);
        KeyDown += (_, e) => {
            if (e.Handled) return;
            if (e.Key is Key.PageDown or Key.PageUp)
            {
                TurnPage(e.Key == Key.PageDown ? 1 : -1);
                e.Handled = true;
                return;
            }
            if (e.Key is not (Key.Home or Key.End or Key.Left or Key.Right or Key.Up or Key.Down)) return;
            var buttons = _cards.Select(entry => (Button)entry.Button).Append(_next).Append(_previous).Append(_scope).Append(_back);
            StepFocus(buttons, buttons.FirstOrDefault(b => b.IsKeyboardFocusWithin), e.Key);
            e.Handled = true;
        };
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property == IsVisibleProperty && !IsVisible)
        {
            _panel = null;
            _lesson = null;
            _groupPage = 0;
        }
    }

    private void TurnPage(int delta)
    {
        if (_panel is null || _lesson is null || !(delta > 0 ? _next : _previous).IsVisible) return;
        if (_panel.Overview) ShowPage(_panel, _lesson, delta);
        else ActionRequested?.Invoke(delta > 0 ? "card-next" : "card-prev", null);
    }

    internal void Update(CardQuizCardPanel panel, CardQuizLesson lesson) => ShowPage(panel, lesson, 0);

    private void ShowPage(CardQuizCardPanel panel, CardQuizLesson lesson, int delta)
    {
        static int Start(int n) => (n - 1) / 10 * 10 + 1;
        var entered = !IsVisible || _panel?.Overview != panel.Overview;
        var detailDelta = !entered && !panel.Overview ? panel.Page - _panel!.Page : 0;
        var focused = _cards.FirstOrDefault(entry => entry.Button.IsFocused).Number;
        var hadCardFocus = focused > 0;
        if (_panel?.Grouped == true && !panel.Grouped && focused > 0)
        {
            // A pending-only map can shrink from decades to individual cards mid-scan.
            var remaining = panel.Cards.Where(mark => Start(mark.Number) == focused);
            focused = (remaining.FirstOrDefault(mark => mark.Number == panel.Located) ?? remaining.FirstOrDefault())?.Number ?? 0;
        }
        var wasNext = _next.IsFocused;
        var wasPrevious = _previous.IsFocused;
        var wasScope = _scope.IsFocused;
        // The bridge sends all overview marks, already sorted by the printed number.
        // Skip empty decades. Missing cards within an occupied decade keep their dot slots.
        var groups = panel.Grouped ? panel.Cards.GroupBy(mark => Start(mark.Number)).Select(g => g.ToArray()).ToArray() : [];
        var pages = panel.Overview ? 1 : Math.Max(1, panel.Pages);
        var page = panel.Overview ? 0 : panel.Page;
        if (groups.Length > 8)
        {
            pages = (groups.Length + GroupsPerPage - 1) / GroupsPerPage;
            var anchor = entered ? panel.Located : delta == 0 && focused > 0 ? focused : (int?)null;
            var index = anchor is int number ? Array.FindIndex(groups, g => Start(g[0].Number) == Start(number)) : -1;
            page = Math.Clamp(index >= 0 ? index / GroupsPerPage : entered ? 0 : _groupPage + delta, 0, pages - 1);
            groups = groups.Skip(page * GroupsPerPage).Take(GroupsPerPage).ToArray();
        }
        if (panel.Overview) _groupPage = page;
        var visibleNumbers = panel.Grouped ? groups.SelectMany(g => g).Select(m => m.Number).ToArray() :
            panel.Cards.Select(m => m.Number).ToArray();
        bool rebuild = entered || _panel?.Grouped != panel.Grouped || !_visibleNumbers.SequenceEqual(visibleNumbers);
        _visibleNumbers = visibleNumbers;
        _panel = panel;
        _lesson = lesson;
        if (rebuild)
        {
            _ring.Children.Clear(); _cards.Clear();
            var numbers = panel.Grouped ? groups.Select(g => Start(g[0].Number)).ToArray() : visibleNumbers;
            for (var i = 0; i < numbers.Length; i++)
            {
                var sector = new BanbanToolSector("card", _contrast, _accent, BanbanToolSector.Band.Setup) { IsVisible = true };
                var firstCard = panel.Grouped ? groups[i][0].Number : numbers[i];
                sector.Click += (_, _) => {
                    var number = sector.ClickedCard ?? firstCard;
                    if (number == 0 || !IsEffectivelyVisible || sector.Parent != _ring) return;
                    if (_panel is { Overview:true }) ActionRequested?.Invoke("card-locate", number);
                    else if (_panel is { Overview:false, PendingOnly:false, ReadOnly:false } &&
                        _lesson is { Busy:false, Phase:"collect" or "paused" }) ActionRequested?.Invoke("card-toggle", number);
                };
                _cards.Add((numbers[i], sector)); _ring.Children.Add(sector);
            }
        }
        _previous.IsEnabled = _previous.IsVisible = page > 0;
        _next.IsEnabled = _next.IsVisible = page + 1 < pages;
        var slots = _cards.Count + (_previous.IsVisible ? 1 : 0) + (_next.IsVisible ? 1 : 0);
        for (var i = 0; i < _cards.Count; i++)
        {
            var (number, sector) = _cards[i];
            sector.Place(i, slots);
            sector.TabIndex = i;
            if (panel.Grouped) sector.SetCardGroup(number, groups[i]);
            else sector.SetCard(number, panel.Cards[i].State);
            AutomationProperties.SetHelpText(sector, panel.Overview ? "查看卡号" : panel.ReadOnly ? "只读" : lesson.Busy ? "正在处理" : "切换本轮免答");
        }
        if (_next.IsVisible) _next.Place(_cards.Count, slots);
        if (_previous.IsVisible) _previous.Place(slots - 1, slots);
        _next.TabIndex = _cards.Count;
        _previous.TabIndex = _cards.Count + 1;
        _scope.TabIndex = _cards.Count + 2;
        _back.TabIndex = _cards.Count + 3;
        UpdateHub(panel, lesson, page, pages);
        if (!IsEffectivelyVisible) return;
        if (entered) FocusCard(panel.Located);
        else if (wasScope && (!_scope.IsVisible || !_scope.IsEnabled)) _back.Focus();
        else if (wasNext && !_next.IsVisible) FocusCard(_cards.FirstOrDefault().Number);
        else if (wasPrevious && !_previous.IsVisible) FocusCard(_cards.LastOrDefault().Number);
        else if (!wasNext && !wasPrevious && (delta != 0 || detailDelta != 0))
            FocusCard(delta > 0 || detailDelta > 0 ? _cards.FirstOrDefault().Number : _cards.LastOrDefault().Number);
        else if (rebuild && hadCardFocus) FocusCard(focused);
    }

    private void UpdateHub(CardQuizCardPanel panel, CardQuizLesson lesson, int page, int pages)
    {
        var showScope = panel.Overview && lesson.Phase is ("collect" or "paused");
        if (_scope.IsVisible != showScope)
        {
            _scope.IsVisible = showScope;
            _hubFooter.MinHeight = showScope ? 44 : 0;
            _hubFooter.Margin = showScope ? new Thickness(0, 0, 46, 0) : default;
            _backRow.Orientation = showScope ? Orientation.Vertical : Orientation.Horizontal;
            _backRow.Spacing = showScope ? 0 : 3;
        }
        _scope.IsEnabled = showScope && !lesson.Busy;
        if (showScope)
        {
            var label = panel.PendingOnly ? "全班" : "待收";
            if (_scopeLabel.Text != label)
            {
                _scopeLabel.Text = label;
                _scopeIcon.Child = Glyph(panel.PendingOnly ? "layout-grid" : "list-checks", 15, _accent);
                var name = panel.PendingOnly ? "查看全班卡号" : "只看待收卡号";
                AutomationProperties.SetName(_scope, name);
                ToolTip.SetTip(_scope, name);
            }
        }
        var status = panel.PendingOnly ? "待收" : lesson.Phase == "result" ? "已答" : "已收";
        var option = lesson.Kind == "multiple" && lesson.Phase != "result" ? lesson.Option + " 项" : "";
        _title.Text = panel.Overview ? option + (lesson.ParticipantCount == 0 ? (lesson.Phase == "result" ? "本轮未收到卡" : "等待举卡") : lesson.Expected == 0 ? "全员免答" :
            panel.PendingOnly && lesson.Missing.Length == 0 ? (lesson.ParticipantCount.HasValue ? "暂无待收" : "已收齐") : status) :
            option + (lesson.Phase == "result" ? "已封存" : panel.ReadOnly ? "只读" : "点卡免答");
        _title.FontSize = _title.Text.Length >= 7 ? 13 : 14;
        var count = panel.PendingOnly ? lesson.Missing.Length : lesson.Received;
        _count.Text = panel.Overview ? count.ToString() : pages > 1 ? (page + 1).ToString() : "卡号";
        _total.Text = panel.Overview ? (lesson.ParticipantCount.HasValue ? "人" : "/ " + lesson.Expected) : pages > 1 ? "/ " + pages + " 页" : "";
        _total.IsVisible = _total.Text.Length > 0 && (!panel.Overview || lesson.Expected > 0);
        _pageLabel.IsVisible = panel.Overview && pages > 1;
        _pageLabel.Text = _pageLabel.IsVisible ? $"{page + 1}/{pages}" : "";
        // Common states already read from the tally. Explain the exceptional symbols once, at the hub.
        var partial = panel.Cards.Any(mark => mark.State == "partial");
        var abstained = panel.Cards.Any(mark => mark.State == "abstained");
        var exempt = panel.Cards.Any(mark => mark.State == "exempt");
        if (!Equals(_key.Tag,(partial,abstained,exempt)))
        {
            _key.Tag = (partial,abstained,exempt); _key.Children.Clear();
            void Legend(string state, string label)
            {
                var text = Text(label, 12);
                text.FontSize = 12;
                text.LineHeight = 15;
                _key.Children.Add(BanbanToolSector.CardMark(state, 7, _accent));
                _key.Children.Add(text);
            }
            if (partial) Legend("partial","未完");
            if (abstained) Legend("abstained","弃权");
            if (exempt) Legend("exempt","免答");
            _key.IsVisible = partial || abstained || exempt;
        }
        AutomationProperties.SetName(_back, "返回");
        var pageHint = $"第 {page + 1} 页，共 {pages} 页";
        var population = lesson.ParticipantCount is int members ? $"截至本轮已参与 {members} 人" : $"应答 {lesson.Expected} 人";
        AutomationProperties.SetHelpText(_back, panel.Overview ? $"{_title.Text} {count}，{population}，{pageHint}" : $"{pageHint}，{_title.Text}");
    }

    internal void FocusCard(int? number)
    {
        var target = _cards.FirstOrDefault(entry => entry.Number == number ||
            _panel?.Grouped == true && number >= entry.Number && number < entry.Number + 10).Button;
        ((Button?)target ?? _back).Focus();
    }
}
