using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;

namespace ICeClass.Receiver;

internal sealed record CardQuizWheelOption(string Value, string Label);
internal sealed record CardQuizWheelSelection(string Publication, string Subject, string Template);
internal sealed record CardQuizWheelSetup(string Roster, CardQuizWheelOption[] Publications, CardQuizWheelOption[] Subjects,
    CardQuizWheelOption[] Templates, CardQuizWheelSelection Selection, CardQuizWheelOption? Recovery,
    bool CanCreate, bool CanRefresh, bool Busy, string Notice);
internal sealed record CardQuizWheelCommand(string Action, CardQuizWheelSelection? Selection = null, string? SessionId = null, string? Key = null);

/// <summary>Settings and their choices share the same space in the original mascot window.</summary>
internal sealed class BanbanClassroomSetup : Border
{
    internal const double Top = 8;
    private readonly TextBlock _title = ClassroomStyle.SectionTitle("开课设置");
    private readonly TextBlock _message = ClassroomStyle.Caption("");
    private readonly TextBlock _recovery = ClassroomStyle.Text("");
    private readonly Choice _publication = new("出题方式"), _subject = new("学科"), _template = new("首题题型");
    private readonly Button _back = MakeButton("返回"), _refresh = MakeButton("联网刷新"), _submit = MakeButton("开始课堂", true);
    private readonly StackPanel _form, _options = new() { Spacing = 3 };
    private readonly Border _fields, _subjectDivider, _templateDivider;
    private readonly ScrollViewer _scroll;
    private CardQuizWheelSetup? _state;
    private Choice? _choosing;
    internal event Action? BackRequested;
    internal event Action<CardQuizWheelCommand>? ActionRequested;

    internal BanbanClassroomSetup()
    {
        Name = "ClassroomSetup"; IsVisible = false;
        Width = BanbanClassroomWheel.Diameter - 24; Height = BanbanClassroomWheel.SurfaceHeight - Top - 8;
        var contrast = DesktopStyle.HighContrastEnabled();
        var edge = contrast ? Brushes.Black : DesktopStyle.Brush("#A8C1D7");
        var surface = new Border { Background = ClassroomGlassHost.FloatingTint(contrast), BorderBrush = edge,
            BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(21), IsHitTestVisible = false };
        AutomationProperties.SetLiveSetting(_message, AutomationLiveSetting.Polite);
        _subjectDivider = ClassroomStyle.SettingsDivider();
        _templateDivider = ClassroomStyle.SettingsDivider();
        var fields = new StackPanel { Children = { _publication.Button, _subjectDivider, _subject.Button, _templateDivider, _template.Button } };
        _fields = new Border { Background = contrast ? Brushes.White : DesktopStyle.Brush("#DFF8FDFF"),
            BorderBrush = edge, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(13),
            Padding = new Thickness(2), Child = fields };
        _form = new StackPanel { Spacing = 8, Children = { _message, _recovery, _fields } };
        _scroll = new ScrollViewer { Content = _form, Margin = new Thickness(0, 6, 0, 8),
            HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled };
        _back.Classes.Add("native-document");
        _back.HorizontalAlignment = HorizontalAlignment.Left;
        var actions = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto,6,Auto"), Children = { _back, _refresh, _submit } };
        Grid.SetColumn(_refresh, 1); Grid.SetColumn(_submit, 3);
        var layout = new Grid { Margin = new Thickness(14, 12), RowDefinitions = new RowDefinitions("Auto,*,Auto"),
            Children = { _title, _scroll, actions } };
        Grid.SetRow(_scroll, 1); Grid.SetRow(actions, 2);
        Child = new Grid { Children = { surface, layout } };

        _publication.Button.Click += (_, _) => Choose(_publication);
        _subject.Button.Click += (_, _) => Choose(_subject);
        _template.Button.Click += (_, _) => Choose(_template);
        _back.Click += (_, _) => { if (!ReturnToSettings()) BackRequested?.Invoke(); };
        _refresh.Click += (_, _) => ActionRequested?.Invoke(new("setup-refresh"));
        _submit.Click += (_, _) =>
        {
            if (_state?.Recovery is { } recovery && !_state.Busy) ActionRequested?.Invoke(new("setup-restore", SessionId: recovery.Value));
            else if (_state?.CanCreate == true) ActionRequested?.Invoke(new("setup-start", new(_publication.Value, _subject.Value, _template.Value)));
        };
    }

    internal void Open(CardQuizWheelState state)
    {
        _state = null;
        IsVisible = true; Update(state);
    }

    internal void FocusFirst()
    {
        if (_publication.Button.IsVisible && _publication.Button.IsEnabled) MoveFocus(_publication.Button);
        else if (_submit.IsEnabled) MoveFocus(_submit);
        else if (_refresh.IsEnabled) MoveFocus(_refresh);
        else MoveFocus(_back);
    }

    internal void Close()
    {
        IsVisible = false;
        ReturnToSettings();
    }

    internal void Update(CardQuizWheelState state)
    {
        if (!IsVisible || state.Setup is not { } setup) return;
        var reset = _state is null;
        var displayed = _choosing?.Options;
        _state = setup;
        _publication.Update(setup.Publications, setup.Selection.Publication, reset);
        _subject.Update(setup.Subjects, setup.Selection.Subject, reset);
        _template.Update(setup.Templates, setup.Selection.Template, reset);
        // A background roster refresh can withdraw an option while its list is open.
        if (_choosing is { } choice && (setup.Recovery is not null || setup.Busy || !choice.Options.SequenceEqual(displayed!)))
            ReturnToSettings();
        _message.Text = setup.Busy ? "正在处理…" : state.Error && !string.IsNullOrEmpty(state.Feedback) ? state.Feedback :
            string.IsNullOrEmpty(setup.Notice) || setup.Notice == setup.Roster ? setup.Roster : $"{setup.Roster}\n{setup.Notice}";
        _message.Foreground = DesktopStyle.Brush(state.Error ? "#9B3224" : "#4E6C83");
        _recovery.Text = setup.Recovery?.Label;
        _title.Text = _choosing?.Label ?? (setup.Recovery is null ? "开课设置" : "恢复课堂");
        UpdateControls();
    }

    internal bool ReturnToSettings()
    {
        if (_choosing is not { } choice) return false;
        _choosing = null; _options.Children.Clear(); _scroll.Content = _form; _scroll.Offset = default;
        _title.Text = _state?.Recovery is null ? "开课设置" : "恢复课堂";
        UpdateControls();
        if (IsVisible) MoveFocus(choice.Button.IsVisible && choice.Button.IsEnabled ? choice.Button : _back);
        return true;
    }

    private void Choose(Choice choice)
    {
        _choosing = choice; _title.Text = choice.Label;
        Button? selected = null;
        foreach (var option in choice.Options)
        {
            var isSelected = option.Value == choice.Value;
            var button = MakeButton(option.Label);
            button.Classes.Add("native-document");
            button.Classes.Set("selected", isSelected);
            var label = new TextBlock { Text = option.Label, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
            var row = new Grid { ColumnDefinitions = new ColumnDefinitions("*,22"), Children = { label } };
            if (isSelected)
            {
                var check = ClassroomStyle.Icon("check", 18);
                Grid.SetColumn(check, 1); row.Children.Add(check);
            }
            button.Content = row;
            button.HorizontalContentAlignment = HorizontalAlignment.Stretch;
            AutomationProperties.SetName(button, option.Label);
            AutomationProperties.SetItemStatus(button, isSelected ? "已选" : "");
            button.Click += (_, _) => { choice.Select(option); ReturnToSettings(); };
            _options.Children.Add(button);
            if (isSelected) selected = button;
        }
        _scroll.Content = _options; _scroll.Offset = default;
        UpdateControls();
        MoveFocus(selected ?? _options.Children.OfType<Button>().FirstOrDefault() ?? _back);
    }

    private void MoveFocus(Control control)
    {
        TopLevel.GetTopLevel(this)?.UpdateLayout();
        control.Focus();
    }

    private void UpdateControls()
    {
        if (_state is not { } setup) return;
        var selecting = _choosing is not null;
        var recovering = setup.Recovery is not null;
        _recovery.IsVisible = recovering;
        _fields.IsVisible = !recovering;
        _publication.Button.IsVisible = !recovering;
        _subject.Button.IsVisible = _template.Button.IsVisible = !recovering && _publication.Value.Length == 0;
        _subjectDivider.IsVisible = _templateDivider.IsVisible = _subject.Button.IsVisible;
        _publication.Button.IsEnabled = _subject.Button.IsEnabled = _template.Button.IsEnabled = setup.CanCreate;
        _back.IsEnabled = !setup.Busy;
        _refresh.IsVisible = _submit.IsVisible = !selecting;
        _refresh.IsEnabled = setup.CanRefresh;
        _submit.Content = recovering ? "恢复课堂" : "开始课堂";
        _submit.IsEnabled = !setup.Busy && (recovering || setup.CanCreate);
    }

    private static Button MakeButton(string label, bool primary = false)
    {
        var button = ClassroomStyle.Button(label, primary);
        button.Padding = new Thickness(9, 4); button.FontSize = primary ? 17 : 16;
        return button;
    }

    private sealed class Choice
    {
        private readonly TextBlock _value = new() { TextTrimming = TextTrimming.CharacterEllipsis, FontWeight = FontWeight.SemiBold,
            TextAlignment = TextAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
        internal Choice(string label)
        {
            Label = label;
            Button = MakeButton(label);
            Button.Classes.Add("native-document");
            Button.HorizontalContentAlignment = HorizontalAlignment.Stretch;
            var name = ClassroomStyle.Caption(label);
            name.VerticalAlignment = VerticalAlignment.Center;
            var chevron = new Avalonia.Controls.Shapes.Path { Data = StreamGeometry.Parse("M 1,1 L 5,5 L 1,9"),
                Width = 6, Height = 10, Stroke = name.Foreground, StrokeThickness = 1.5,
                StrokeLineCap = PenLineCap.Round, StrokeJoin = PenLineJoin.Round, VerticalAlignment = VerticalAlignment.Center };
            var row = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,8,*,8,6"), Children = { name, _value, chevron } };
            Grid.SetColumn(_value, 2); Grid.SetColumn(chevron, 4); Button.Content = row;
        }
        internal string Label { get; }
        internal Button Button { get; }
        internal CardQuizWheelOption[] Options { get; private set; } = [];
        internal string Value { get; private set; } = "";
        internal void Update(CardQuizWheelOption[] options, string fallback, bool reset)
        {
            var value = reset ? fallback : Value;
            Options = options;
            Select(options.FirstOrDefault(item => item.Value == value) ?? options.FirstOrDefault(item => item.Value == fallback) ?? options.FirstOrDefault());
        }
        internal void Select(CardQuizWheelOption? option)
        {
            Value = option?.Value ?? ""; _value.Text = option?.Label ?? "";
            AutomationProperties.SetName(Button, $"{Label}，{_value.Text}");
            ToolTip.SetTip(Button, _value.Text);
        }
    }
}
