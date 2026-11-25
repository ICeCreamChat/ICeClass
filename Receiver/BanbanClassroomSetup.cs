using System.Globalization;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using static ICeClass.Receiver.BanbanClassroomStyle;

namespace ICeClass.Receiver;

internal sealed record CardQuizWheelOption(string Value, string Label);
internal sealed record CardQuizWheelSelection(string Publication, string Subject, string Template, string CardMode = "scanned");
internal sealed record CardQuizWheelSetup(string Roster, CardQuizWheelOption[] Publications, CardQuizWheelOption[] Subjects,
    CardQuizWheelOption[] Templates, CardQuizWheelSelection Selection, CardQuizWheelOption? Recovery,
    bool CanCreate, bool CanRefresh, bool Busy, string Notice, int? CardCount = null, bool Refreshed = false,
    CardQuizWheelOption[]? CardModes = null, int? AssignedCardCount = null);
internal sealed record CardQuizWheelCommand(string Action, CardQuizWheelSelection? Selection = null, string? SessionId = null, string? Key = null, int? CardNumber = null, string? PageKey = null, int? QuestionIndex = null);

/// <summary>Classroom setup and its pickers stay inside the mascot's wheel.</summary>
internal sealed class BanbanClassroomSetup : Border
{
    private const int OptionsPerPage = 5;
    private readonly Canvas _home = new(), _picker = new();
    private readonly BanbanTextReader _reader = new();
    private readonly Canvas _radialOptions = new() { Width = BanbanClassroomWheel.Diameter, Height = BanbanClassroomWheel.Diameter };
    private readonly TextBlock _title = BanbanClassroomStyle.Text("", 15, true);
    private readonly TextBlock _roster = BanbanClassroomStyle.Text("", 30, true);
    private readonly TextBlock _unit = BanbanClassroomStyle.Text("张卡", 13, muted: true);
    private readonly TextBlock _hint = BanbanClassroomStyle.Text("", 13, true);
    private readonly TextBlock _statusTitle = BanbanClassroomStyle.Text("", 15, true);
    private readonly TextBlock _statusText = BanbanClassroomStyle.Text("", 15);
    private readonly TextBlock _pickerTitle = BanbanClassroomStyle.Text("", 15, true);
    private readonly TextBlock _pickerPage = BanbanClassroomStyle.Text("", 13, muted: true);
    private readonly Grid _hub = new();
    private readonly StackPanel _status;
    private readonly Button _info = MakeButton("查看提示"), _pickerBack = MakeButton("返回");
    private readonly BanbanToolSector _submit, _back, _refresh, _statusDetails;
    private readonly BanbanToolSector _names, _previous, _next;
    private readonly Choice _publication, _subject, _template, _cards;
    private readonly bool _contrast = DesktopStyle.HighContrastEnabled();
    private readonly IBrush _accent;
    private CardQuizWheelSetup? _state;
    private Choice? _choosing;
    private Button? _readerSource;
    private bool _showFields, _error;
    private int _page, _pageSize;
    private string _notice = "";
    internal bool Busy => _state?.Busy == true;
    internal event Action? BackRequested;
    internal event Action<CardQuizWheelCommand>? ActionRequested;

    internal BanbanClassroomSetup()
    {
        Name = "ClassroomSetup";
        IsVisible = false;
        _accent = _contrast ? Brushes.Black : DesktopStyle.Brush("#005DBF");
        _publication = Field("出题方式", "monitor", 0, option => option.Value.Length == 0 ? "课件" : "题单");
        _cards = Field("发卡方式", "scan-line", 0, option => option.Value == "scanned" ? "通用卡" : "个人卡");
        _template = Field("首题题型", "list-checks", 1, Kind, Range);
        _refresh = HomeAction("联网刷新", "刷新", "rotate-ccw", 2, () => ActionRequested?.Invoke(new("setup-refresh")));
        _submit = HomeAction("开始课堂", "开课", "play", 3, Submit, primary: true);
        _back = HomeAction("返回", "返回", "arrow-left", 4, () => BackRequested?.Invoke());
        _subject = Field("学科", "book-open", 5, option => option.Label);
        _statusDetails = HomeAction("名单详情", "名单", "list-checks", 0, OpenStatus);

        RoundButton(_info, 96);
        _info.TabIndex = 6;
        _info.Content = null;
        _title.MaxWidth = 80;
        _title.TextWrapping = TextWrapping.NoWrap;
        _title.TextTrimming = TextTrimming.CharacterEllipsis;
        _title.TextAlignment = _hint.TextAlignment = TextAlignment.Center;
        _title.LineHeight = 19;
        _roster.LineHeight = 36;
        _unit.FontSize = _hint.FontSize = 13;
        _unit.LineHeight = 17;
        _unit.VerticalAlignment = VerticalAlignment.Bottom;
        _unit.Margin = new Thickness(0, 0, 0, 4);
        var count = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2,
            HorizontalAlignment = HorizontalAlignment.Center, Children = { _roster, _unit } };
        _hint.LineHeight = 17;
        var summary = new StackPanel { IsHitTestVisible = false, HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center, Children = { _title, count, _hint } };
        _hub.Children.Add(_info);
        _hub.Children.Add(summary);
        Place(_home, _hub, 72, 72, 96, 96);

        _statusTitle.TextAlignment = _statusText.TextAlignment = TextAlignment.Center;
        _statusTitle.LineHeight = 20;
        _statusText.LineHeight = 18;
        _statusText.MaxLines = 3;
        _statusText.TextTrimming = TextTrimming.CharacterEllipsis;
        _status = new StackPanel { Spacing = 3, IsHitTestVisible = false,
            VerticalAlignment = VerticalAlignment.Center, Children = { _statusTitle, _statusText } };
        Place(_home, new Grid { IsHitTestVisible = false, Children = { _status } }, 79, 81, 82, 78);
        RoundButton(_pickerBack, 96);
        var backLabel = BanbanClassroomStyle.Text("返回", 14, true);
        var backRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 3, HorizontalAlignment = HorizontalAlignment.Center,
            Children = { Glyph("arrow-right", 15, _accent, 180), backLabel } };
        _pickerTitle.TextAlignment = TextAlignment.Center;
        _pickerTitle.LineHeight = 19;
        _pickerPage.FontSize = 13;
        _pickerPage.LineHeight = 16;
        _pickerPage.TextAlignment = TextAlignment.Center;
        _pickerBack.Content = new StackPanel { Spacing = 2, Children = { _pickerTitle, _pickerPage, backRow } };
        _pickerBack.Click += (_, _) => ReturnToSettings();
        _picker.Children.Add(_radialOptions);
        Place(_picker, _pickerBack, 72, 72, 96, 96);
        _names = PickerAction("查看本页完整名称", "全名", "book-open", ShowNames);
        _next = PickerAction("下一页选项", "下页", "arrow-right", () => TurnPicker(1));
        _previous = PickerAction("上一页选项", "上页", "arrow-left", () => TurnPicker(-1));
        _reader.BackRequested += () => ReturnToSettings();
        _info.Click += (_, _) => OpenReader(_info);
        foreach (var live in new[] { _hint, _statusText })
            AutomationProperties.SetLiveSetting(live, AutomationLiveSetting.Polite);
        Child = new Grid { Width = BanbanClassroomWheel.Diameter, Height = BanbanClassroomWheel.Diameter,
            Children = { _home, _picker, _reader } };
        KeyDown += Navigate;
    }

    private static void Place(Canvas parent, Control child, double left, double top, double width, double height)
    {
        child.Width = width; child.Height = height;
        Canvas.SetLeft(child, left); Canvas.SetTop(child, top);
        parent.Children.Add(child);
    }

    private BanbanToolSector HomeSector(string id, int index)
    {
        var button = new BanbanToolSector(id, _contrast, _accent, BanbanToolSector.Band.Setup) { IsVisible = true, TabIndex = index };
        button.Place(index, 6);
        _home.Children.Add(button);
        return button;
    }

    private Choice Field(string label, string glyph, int index, Func<CardQuizWheelOption, string> caption, Func<CardQuizWheelOption, string>? range = null)
    {
        var choice = new Choice(label, glyph, HomeSector(label, index), caption, range);
        choice.Button.Click += (_, _) => Choose(choice);
        return choice;
    }

    private BanbanToolSector HomeAction(string name, string caption, string icon, int index, Action action, bool primary = false)
    {
        var button = HomeSector(primary ? "primary" : name, index);
        button.SetFace(name, caption, icon);
        button.Click += (_, _) => action();
        return button;
    }

    private BanbanToolSector PickerAction(string name, string caption, string icon, Action action)
    {
        var button = new BanbanToolSector(name, _contrast, _accent, BanbanToolSector.Band.Setup);
        button.SetFace(name, caption, icon);
        button.Click += (_, _) => action();
        return button;
    }

    private void Submit()
    {
        if (_state is not { Busy: false } setup) return;
        if (setup.Recovery is { } recovery) ActionRequested?.Invoke(new("setup-restore", SessionId: recovery.Value));
        else if (setup.CanCreate) ActionRequested?.Invoke(new("setup-start", new(_publication.Value, _subject.Value, _template.Value,
            _cards.Selected?.Value ?? setup.Selection.CardMode)));
    }

    internal void Open(CardQuizWheelState state)
    {
        _state = null;
        IsVisible = true;
        Update(state);
    }

    internal void FocusFirst() => MoveFocus(_publication.Button.IsVisible && _publication.Button.IsEnabled
        ? _publication.Button : _submit.IsEnabled ? _submit : _refresh.IsEnabled ? _refresh : _back);

    internal void Close()
    {
        IsVisible = false;
        ClearPicker();
        _readerSource = null;
        _reader.IsVisible = false;
    }

    internal void Update(CardQuizWheelState state)
    {
        if (!IsVisible || state.Setup is not { } setup) return;
        var reset = _state is null;
        var previousOptions = _choosing?.Options;
        var wasBusy = Busy;
        _showFields = setup.Recovery is null && (setup.CanCreate || !reset && setup.Busy && _showFields);
        _state = setup;
        _publication.Update(setup.Publications, setup.Selection.Publication, reset);
        _subject.Update(setup.Subjects, setup.Selection.Subject, reset);
        _template.Update(setup.Templates, setup.Selection.Template, reset);
        _cards.Update(setup.CardModes ?? [], setup.Selection.CardMode, reset);
        _error = state.Error && !string.IsNullOrEmpty(state.Feedback);
        _notice = Paragraphs(_error ? state.Feedback : null, setup.Notice == setup.Roster ? null : setup.Notice);
        if (_choosing is { } choice && (!setup.CanCreate || setup.Recovery is not null || !choice.Options.SequenceEqual(previousOptions!)))
        {
            ClearPicker();
            _readerSource = null;
            Paint();
            if (choice.Button.IsEffectivelyVisible && choice.Button.IsEnabled) MoveFocus(choice.Button);
            else FocusFirst();
        }
        else Paint();
        if (wasBusy && !setup.Busy && TopLevel.GetTopLevel(this) is Window { IsActive: true } window &&
            window.FocusManager?.GetFocusedElement() is null) FocusFirst();
    }

    private void Paint()
    {
        if (_state is not { } setup) return;
        var recovering = setup.Recovery is not null;
        var usingDeck = _publication.Value.Length > 0;
        var sixFields = _showFields && !usingDeck;
        _publication.Button.IsVisible = _showFields;
        _subject.Button.IsVisible = _template.Button.IsVisible = sixFields;
        _statusDetails.IsVisible = _status.IsVisible = !_showFields;
        _hub.IsVisible = _showFields;
        // Both layouts keep the primary at six o'clock. The four-sector face uses the two
        // sides for refresh and return, even when no subject or first question is editable.
        var chooseCards = _showFields && _cards.Options.Length > 1;
        _cards.Button.IsVisible = chooseCards;
        var count = (sixFields ? 6 : 4) + (chooseCards ? 1 : 0);
        var offset = chooseCards ? 0.5 : 0;
        _publication.Button.Place(chooseCards ? count - 0.5 : 0, count);
        _cards.Button.Place(offset, count);
        _template.Button.Place(1 + offset, count);
        _subject.Button.Place(5 + offset, count);
        _statusDetails.Place(0, 4);
        _refresh.Place((sixFields ? 2 : 1) + offset, count);
        _submit.Place(count / 2d, count);
        _back.Place((sixFields ? 4 : 3) + offset, count);
        foreach (var field in new[] { _publication, _subject, _template, _cards })
            field.Button.IsEnabled = setup.CanCreate && !setup.Busy && field.Options.Length > 0;
        var warning = _notice.Length > 0 && (_error || !setup.Refreshed);
        _statusTitle.Text = recovering ? "恢复课堂" : "开课设置";
        _statusText.Text = setup.Busy ? "正在处理…" : setup.Recovery?.Label ?? setup.Roster;
        _statusText.Foreground = _error && !_contrast ? DesktopStyle.Brush("#933D2D") : _statusTitle.Foreground;
        _statusDetails.SetFace(_error ? "查看错误" : warning ? "查看提示" : recovering ? "查看上次课堂" : "查看名单详情",
            _error ? "错误" : warning ? "提示" : recovering ? "记录" : "名单", recovering ? "book-open" : "list-checks");
        _statusDetails.IsEnabled = !setup.Busy;
        _title.Text = usingDeck ? _publication.Selected?.Label : "开课设置";
        ToolTip.SetTip(_title, _title.Text);
        var cardCount = chooseCards ? (_cards.Value == "assigned" ? setup.AssignedCardCount : null) : setup.CardCount;
        _roster.Text = setup.Busy ? "处理中" : cardCount?.ToString() ?? (chooseCards ? "举卡即计人数" : setup.Roster);
        _roster.FontSize = !setup.Busy && cardCount.HasValue ? 30 : 14;
        _unit.IsVisible = !setup.Busy && cardCount.HasValue;
        _hint.IsVisible = (_notice.Length > 0 || usingDeck) && !setup.Busy;
        _info.IsVisible = !setup.Busy && (warning || usingDeck);
        _hint.Text = _error ? "查看错误" : warning ? "查看提示" : setup.Refreshed ? "已刷新" : "看全名";
        _hint.Foreground = _error && !_contrast ? DesktopStyle.Brush("#933D2D") : _accent;
        AutomationProperties.SetName(_info, warning ? _hint.Text : "查看题单全名");
        AutomationProperties.SetHelpText(_info, Paragraphs(usingDeck ? _publication.Selected?.Label : null, _notice));
        _back.IsEnabled = !setup.Busy;
        _refresh.IsEnabled = setup.CanRefresh && !setup.Busy;
        _submit.SetFace(recovering ? "恢复课堂" : "开始课堂", recovering ? "恢复" : "开课", "play");
        _submit.IsEnabled = !setup.Busy && (recovering || setup.CanCreate);
        var lostSource = _readerSource == _info && (!_showFields || !_info.IsVisible) ||
            _readerSource == _statusDetails && (!_statusDetails.IsVisible || setup.Busy);
        if (lostSource) _readerSource = null;
        _home.IsVisible = _readerSource is null && _choosing is null;
        _picker.IsVisible = _readerSource is null && _choosing is not null;
        if (_readerSource is null) _reader.IsVisible = false;
        else if (_readerSource == _statusDetails)
            _reader.Open(_error ? "开课错误" : recovering ? "上次课堂" : "名单详情",
                Paragraphs(setup.Roster, setup.Recovery?.Label, _notice));
        else if (_readerSource == _info)
            _reader.Open(_error ? "开课错误" : warning ? "课堂提示" : "题单全名",
                Paragraphs(warning ? _notice : null, usingDeck ? _publication.Selected?.Label : null, !warning ? _notice : null));
        if (lostSource && IsVisible) FocusFirst();
    }

    private static string Paragraphs(params string?[] parts) =>
        string.Join("\n", parts.Where(s => !string.IsNullOrWhiteSpace(s)).Distinct());

    private void OpenStatus() => OpenReader(_statusDetails);

    private void OpenReader(Button source)
    {
        _readerSource = source;
        Paint();
        _reader.FocusFirst();
    }

    private void ClearPicker()
    {
        _choosing = null;
        _radialOptions.Children.Clear();
    }

    internal bool ReturnToSettings()
    {
        Button? source = _readerSource;
        if (source is not null) _readerSource = null;
        else if (_choosing is { } choice) { source = choice.Button; ClearPicker(); }
        else return false;
        Paint();
        if (IsVisible)
        {
            if (source.IsEffectivelyVisible && source.IsEnabled) MoveFocus(source);
            else FocusFirst();
        }
        return true;
    }

    private static string Kind(CardQuizWheelOption option) => option.Label.Split('·', 2)[0].Trim();
    private static string Range(CardQuizWheelOption option) => option.Value == "boolean:2" ? "对错" :
        option.Label.Split('·', 2).ElementAtOrDefault(1)?.Trim() ?? "";

    private void Choose(Choice choice)
    {
        if (!choice.Button.IsEnabled || choice.Options.Length == 0) return;
        _choosing = choice;
        // The short subject and template sets still fit in a single ring.
        _pageSize = choice != _publication && choice.Options.Length <= 9 &&
            choice.Options.All(o => choice.Caption(o).Length <= 2 && (choice != _template || Range(o).Length <= 3))
            ? choice.Options.Length : OptionsPerPage;
        _page = Math.Max(0, Array.IndexOf(choice.Options, choice.Selected)) / _pageSize;
        _pickerTitle.Text = choice.Label;
        Paint();
        DrawPicker(0);
    }

    private int PickerPages => (_choosing!.Options.Length + _pageSize - 1) / _pageSize;

    private void TurnPicker(int delta)
    {
        if (_choosing is null || _page + delta < 0 || _page + delta >= PickerPages) return;
        _page += delta;
        DrawPicker(delta);
    }

    private static string ShortName(string label)
    {
        var starts = StringInfo.ParseCombiningCharacters(label);
        return starts.Length <= 2 ? label : label[..starts[2]];
    }

    private static int SharedTitlePrefix(CardQuizWheelOption[] options)
    {
        var titles = options.Where(o => o.Value.Length > 0).Select(o => o.Label).Distinct().ToArray();
        if (titles.Length < 2) return 0;
        var offset = 0;
        // Show the differing part of names such as “高一数学第 1 课” and “高一数学第 2 课”.
        while (offset < titles[0].Length)
        {
            var element = StringInfo.GetNextTextElement(titles[0], offset);
            if (titles.Any(title => offset >= title.Length || StringInfo.GetNextTextElement(title, offset) != element)) break;
            offset += element.Length;
        }
        return offset;
    }

    private void DrawPicker(int direction)
    {
        if (_choosing is not { } choice) return;
        _radialOptions.Children.Clear();
        var first = _page * _pageSize;
        var end = Math.Min(first + _pageSize, choice.Options.Length);
        var options = choice.Options[first..end];
        BanbanToolSector? selected = null;
        bool showNames = choice == _publication || options.Any(o => ShortName(choice.Caption(o)) != choice.Caption(o));
        var prefix = choice == _publication ? SharedTitlePrefix(options) : 0;
        for (var i = 0; i < options.Length; i++)
        {
            var option = options[i];
            var active = choice.Selected == option;
            var sector = new BanbanToolSector(active ? "primary" : "option", _contrast, _accent, BanbanToolSector.Band.Setup) { IsVisible = true };
            var caption = choice.Caption(option);
            if (choice == _publication && option.Value.Length > 0)
            {
                var suffix = option.Label[prefix..].TrimStart();
                caption = suffix.Length == 0 ? option.Label : suffix;
            }
            var mark = showNames ? (first + i + 1).ToString() : choice == _template ? Range(option) : "";
            sector.SetOption(option.Label, ShortName(caption), mark);
            sector.Click += (_, _) =>
            {
                if (Busy || _choosing != choice || !_picker.IsVisible || sector.Parent != _radialOptions) return;
                choice.Select(option);
                ReturnToSettings();
            };
            if (active) selected = sector;
            _radialOptions.Children.Add(sector);
        }
        if (showNames) _radialOptions.Children.Add(_names);
        if (_page + 1 < PickerPages) _radialOptions.Children.Add(_next);
        if (_page > 0) _radialOptions.Children.Add(_previous);
        var sectors = _radialOptions.Children.Cast<BanbanToolSector>().ToArray();
        for (var i = 0; i < sectors.Length; i++)
        {
            sectors[i].IsVisible = true;
            sectors[i].TabIndex = i;
            sectors[i].Place(i, sectors.Length);
        }
        _pickerBack.TabIndex = sectors.Length;
        _pickerPage.IsVisible = PickerPages > 1;
        _pickerPage.Text = $"{_page + 1} / {PickerPages}";
        AutomationProperties.SetHelpText(_pickerBack, $"{choice.Label}，第 {_page + 1} 页，共 {PickerPages} 页");
        var focus = direction switch
        {
            > 0 => _page + 1 < PickerPages ? _next : sectors[0],
            < 0 => _page > 0 ? _previous : sectors[end - first - 1],
            _ => selected ?? sectors[0]
        };
        MoveFocus(focus);
    }

    private void ShowNames()
    {
        if (_choosing is not { } choice) return;
        var first = _page * _pageSize;
        var names = choice.Options.Skip(first).Take(_pageSize).Select((o, i) => $"{first + i + 1}  {o.Label}");
        _readerSource = _names;
        Paint();
        _reader.Open(choice == _publication ? "课件与题单" : choice.Label, string.Join("\n", names));
        _reader.FocusFirst();
    }

    private void Navigate(object? sender, KeyEventArgs e)
    {
        if (e.Handled || _reader.IsVisible) return;
        if (_choosing is not null && e.Key is Key.PageUp or Key.PageDown)
        {
            TurnPicker(e.Key == Key.PageUp ? -1 : 1);
            e.Handled = true;
            return;
        }
        if (e.Key is not (Key.Left or Key.Right or Key.Up or Key.Down or Key.Home or Key.End)) return;
        IEnumerable<Button> buttons = _picker.IsVisible ? _radialOptions.Children.OfType<Button>().Append(_pickerBack)
            : [_publication.Button, _statusDetails, _cards.Button, _template.Button, _refresh, _submit, _back, _subject.Button, _info];
        StepFocus(buttons, buttons.FirstOrDefault(b => b.IsKeyboardFocusWithin), e.Key);
        e.Handled = true;
    }

    private void MoveFocus(Control control)
    {
        TopLevel.GetTopLevel(this)?.UpdateLayout();
        control.Focus();
    }

    private sealed class Choice(string label, string glyph, BanbanToolSector button, Func<CardQuizWheelOption, string> caption,
        Func<CardQuizWheelOption, string>? range)
    {
        internal string Label => label;
        internal BanbanToolSector Button => button;
        internal Func<CardQuizWheelOption, string> Caption => caption;
        internal CardQuizWheelOption[] Options { get; private set; } = [];
        internal CardQuizWheelOption? Selected { get; private set; }
        internal string Value => Selected?.Value ?? "";
        internal void Update(CardQuizWheelOption[] options, string fallback, bool reset)
        {
            var value = reset ? fallback : Value;
            Options = options;
            Select(options.FirstOrDefault(item => item.Value == value) ?? options.FirstOrDefault(item => item.Value == fallback) ?? options.FirstOrDefault());
        }
        internal void Select(CardQuizWheelOption? option)
        {
            if (option is not null && option == Selected) return;
            Selected = option;
            var name = option is null ? label : $"{label}，{option.Label}";
            if (option is not null && range?.Invoke(option) is { Length: > 0 and <= 3 } mark)
                button.SetOption(name, caption(option), mark);
            else button.SetFace(name, option is null ? label : caption(option), glyph);
        }
    }
}
