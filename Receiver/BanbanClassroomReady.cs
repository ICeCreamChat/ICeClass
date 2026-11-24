using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using static ICeClass.Receiver.BanbanClassroomStyle;

namespace ICeClass.Receiver;

/// <summary>The current question starts from the hub. All other preparation actions surround it.</summary>
internal sealed class BanbanClassroomReady : Canvas
{
    private readonly (string Kind, string Label, string Icon)[] _kinds =
        [("single", "单选", "circle-dot"), ("boolean", "判断", "check"), ("multiple", "多选", "list-checks")];
    private readonly BanbanToolSector[] _choices;
    private readonly BanbanToolSector _question, _more;
    internal BanbanToolSector Tools { get; }
    internal BanbanToolSector Finish { get; }
    internal Button Start { get; } = MakeButton("开始收答", primary: true);
    private readonly TextBlock _number = Text("", 14, true), _label = Text("", 16, true);
    private BanbanToolSector[] _ring = [];
    internal event Action<string, Button>? Activated;

    internal BanbanClassroomReady()
    {
        Width = Height = BanbanClassroomWheel.Diameter;
        IsVisible = false;
        var contrast = DesktopStyle.HighContrastEnabled();
        var accent = contrast ? Brushes.Black : DesktopStyle.Brush("#005DBF");
        BanbanToolSector Action(string id, string name, string label, string icon)
        {
            var sector = new BanbanToolSector(id, contrast, accent, BanbanToolSector.Band.Setup) { IsVisible = true };
            sector.SetFace(name, label, icon);
            sector.Click += (_, _) => Activated?.Invoke(id, sector);
            Children.Add(sector);
            return sector;
        }
        _choices = _kinds.Select(k => Action("kind-" + k.Kind, k.Label, k.Label, k.Icon)).ToArray();
        _question = Action("edit", "查看题目", "看题", "book-open");
        _more = Action("more", "更多操作", "更多", "ellipsis");
        Finish = Action("finish", "结课", "结课", "check");
        Tools = Action("tools", "课堂工具", "工具", "layout-grid");
        RoundButton(Start, 102);
        Start.TabIndex = 0;
        Start.Background = contrast ? Brushes.Black : DesktopStyle.Blue;
        Start.BorderBrush = accent;
        _number.Foreground = _label.Foreground = Brushes.White;
        foreach (var text in new[] { _number, _label }) text.TextAlignment = TextAlignment.Center;
        Start.Content = new StackPanel { Spacing = 2, VerticalAlignment = VerticalAlignment.Center, Children = {
            _number, ClassroomStyle.ResourceIcon("ICeClass.Local/card-quiz/icons/play.svg", 18, Brushes.White), _label } };
        Start.Click += (_, _) => Activated?.Invoke("start", Start);
        SetLeft(Start, 69); SetTop(Start, 69); Children.Add(Start);
    }

    internal void Update(CardQuizLesson lesson, bool canRead)
    {
        for (var i = 0; i < _choices.Length; i++)
        {
            var (kind, label, icon) = _kinds[i];
            var sector = _choices[i];
            sector.IsVisible = lesson.CanChooseType;
            sector.IsEnabled = !lesson.Busy;
            sector.SetChoice(label, label, icon, null, kind == lesson.Kind);
        }
        _question.IsVisible = !lesson.CanChooseType;
        _question.IsEnabled = canRead && !lesson.Busy;
        if (_question.IsVisible)
        {
            var kind = _kinds.FirstOrDefault(k => k.Kind == lesson.Kind);
            _question.SetFace("查看题目", kind.Label ?? "看题", kind.Icon ?? "book-open");
            AutomationProperties.SetHelpText(_question, lesson.Caption);
        }
        _ring = lesson.CanChooseType ? [.._choices, Tools, Finish, _more] : [_question, Finish, _more, Tools];
        // The editable ring starts at ten o'clock so the three question types read left to right.
        var firstSlot = lesson.CanChooseType ? _ring.Length - 1 : 0;
        for (var i = 0; i < _ring.Length; i++)
        {
            _ring[i].Place((firstSlot + i) % _ring.Length, _ring.Length);
            _ring[i].TabIndex = i + 1;
        }
        Tools.IsEnabled = Finish.IsEnabled = !lesson.Busy;
        Start.IsEnabled = lesson.Enabled;
        _number.Text = lesson.Number > 0 ? $"第 {lesson.Number} 题" : "课堂";
        _label.Text = lesson.Primary == "advance" ? "出题" : "收答";
        AutomationProperties.SetName(Start, lesson.Label);
        AutomationProperties.SetHelpText(Start, string.Join(" · ", new[]{ _number.Text, lesson.Caption }.Where(s => !string.IsNullOrEmpty(s))));
        ToolTip.SetTip(Start, lesson.Label);
    }

    internal void FocusAction(Control? current, Key key) => StepFocus(_ring.Prepend<Button>(Start), current, key);
}
