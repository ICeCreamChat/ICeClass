using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Automation;

namespace ICeClass.Receiver;

internal sealed partial class ClassroomAgentWindows
{
    private static readonly HashSet<string> ControlActions = new(StringComparer.Ordinal)
    {
        "invoke_control", "set_control_value", "type_text", "select_control", "set_control_toggle",
        "expand_control", "collapse_control", "scroll_control", "set_control_range", "focus_control", "press_control_key"
    };

    private JsonObject InspectControls(string windowId, Target target, CancellationToken token, JsonElement args = default)
    {
        var query = args.ValueKind == JsonValueKind.Object ? ClassroomAgentService.Text(args, "query", 100, false) : "";
        var scope = args.ValueKind == JsonValueKind.Object ? ClassroomAgentService.Text(args, "controlId", 100, false) : "";
        var root = scope.Length > 0 ? ResolveControl(windowId, target, scope, false) : AutomationElement.FromHandle(target.Handle);
        var queue = new Queue<(AutomationElement Element, int Depth, string? Parent)>();
        queue.Enqueue((root, 0, null));
        var controls = new JsonArray();
        var published = new Dictionary<string, ControlTarget>();
        if (scope.Length > 0)
        {
            lock (_gate) if (_controls.TryGetValue(scope, out var saved)) published[scope] = saved;
        }
        var scanned = 0;
        var characters = 0;
        while (queue.Count > 0 && controls.Count < 60 && scanned++ < 800 && characters < 4000)
        {
            token.ThrowIfCancellationRequested();
            var (element, depth, parent) = queue.Dequeue();
            try
            {
                var state = element.Current;
                // Do not traverse password subtrees, including text providers.
                if (SensitiveControl(state) || state.IsOffscreen) continue;
                var item = DescribeControl(element, query);
                var name = item["name"]!.GetValue<string>();
                var value = item["value"]?.GetValue<string>() ?? "";
                if ((name.Length > 0 || item["actions"]!.AsArray().Count > 0) &&
                    (query.Length == 0 || name.Contains(query, StringComparison.OrdinalIgnoreCase) || value.Contains(query, StringComparison.OrdinalIgnoreCase)))
                {
                    var runtime = element.GetRuntimeId();
                    var id = ClassroomAgentPolicy.Identity(windowId + ":" + string.Join('.', runtime));
                    item["id"] = id;
                    item["parentId"] = parent;
                    item["depth"] = depth;
                    published[id] = new(windowId, runtime, state.Name, state.ControlType.Id, state.AutomationId, DateTime.UtcNow);
                    controls.Add(item);
                    characters += name.Length + value.Length;
                    parent = id;
                }
                if (depth >= 14) continue;
                var child = TreeWalker.ControlViewWalker.GetFirstChild(element);
                while (child is not null && queue.Count < 800)
                {
                    queue.Enqueue((child, depth + 1, parent));
                    child = TreeWalker.ControlViewWalker.GetNextSibling(child);
                }
            }
            catch (ElementNotAvailableException) { }
        }
        lock (_gate)
        {
            // Only the current observation authorizes subsequent input. A page
            // change must not leave actionable fields from its previous page.
            foreach (var id in _controls.Where(p => p.Value.WindowId == windowId).Select(p => p.Key).ToArray()) _controls.Remove(id);
            foreach (var (id, saved) in published) _controls[id] = saved;
        }
        return new() { ["controls"] = controls, ["targetId"] = windowId, ["verified"] = true,
            ["truncated"] = queue.Count > 0, ["query"] = query,
            ["detail"] = "已读取当前界面的文字、控件和状态。" };
    }

    private static bool SensitiveControl(AutomationElement.AutomationElementInformation state) => state.IsPassword ||
        state.ControlType == ControlType.Edit && new[] { "密码", "口令", "password", "passcode", "passphrase" }
            .Any(word => state.Name.Contains(word, StringComparison.OrdinalIgnoreCase) || state.AutomationId.Contains(word, StringComparison.OrdinalIgnoreCase));

    private static string ControlExcerpt(string text, int length, string query)
    {
        if (text.Length <= length) return text;
        var match = query.Length > 0 ? text.IndexOf(query, StringComparison.OrdinalIgnoreCase) : -1;
        var start = match < 0 ? 0 : Math.Clamp(match - (length - query.Length) / 2, 0, text.Length - length);
        return text.Substring(start, length);
    }

    private static JsonObject DescribeControl(AutomationElement element, string query)
    {
        var state = element.Current;
        var name = state.Name;
        if (name.Length == 0 && state.LabeledBy is { } label && !label.Current.IsPassword) name = label.Current.Name;
        var actions = new JsonArray();
        var item = new JsonObject { ["name"] = ControlExcerpt(name, 120, query),
            ["type"] = state.ControlType.ProgrammaticName.Replace("ControlType.", ""),
            ["enabled"] = state.IsEnabled, ["focused"] = state.HasKeyboardFocus, ["actions"] = actions };
        if (state.IsKeyboardFocusable) { actions.Add("focus_control"); actions.Add("press_control_key"); }
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var value))
        {
            var pattern = (ValuePattern)value;
            var text = pattern.Current.Value;
            item["value"] = ControlExcerpt(text, 600, query);
            item["editable"] = !pattern.Current.IsReadOnly;
            if (!pattern.Current.IsReadOnly) actions.Add("set_control_value");
        }
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out _)) actions.Add("invoke_control");
        if (element.TryGetCurrentPattern(TogglePattern.Pattern, out var toggle))
        {
            item["toggleState"] = ((TogglePattern)toggle).Current.ToggleState.ToString();
            actions.Add("set_control_toggle"); actions.Add("invoke_control");
        }
        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var select))
        {
            item["selected"] = ((SelectionItemPattern)select).Current.IsSelected;
            actions.Add("select_control");
        }
        if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var expand))
        {
            var expansion = ((ExpandCollapsePattern)expand).Current.ExpandCollapseState;
            item["expandState"] = expansion.ToString();
            if (expansion != ExpandCollapseState.LeafNode) { actions.Add("expand_control"); actions.Add("collapse_control"); }
        }
        if (element.TryGetCurrentPattern(ScrollPattern.Pattern, out var scroll))
        {
            var position = ((ScrollPattern)scroll).Current;
            item["verticalScroll"] = position.VerticalScrollPercent;
            item["horizontalScroll"] = position.HorizontalScrollPercent;
            if (position.VerticallyScrollable || position.HorizontallyScrollable) actions.Add("scroll_control");
        }
        if (element.TryGetCurrentPattern(RangeValuePattern.Pattern, out var range))
        {
            var limits = ((RangeValuePattern)range).Current;
            item["rangeValue"] = limits.Value; item["minimum"] = limits.Minimum; item["maximum"] = limits.Maximum;
            if (!limits.IsReadOnly) actions.Add("set_control_range");
        }
        return item;
    }

    private AutomationElement ResolveControl(string windowId, Target target, string controlId, bool requireEnabled = true)
    {
        ControlTarget? saved;
        lock (_gate) _controls.TryGetValue(controlId, out saved);
        if (saved is null || saved.WindowId != windowId || (DateTime.UtcNow - saved.Seen).TotalMinutes > 2)
            throw new InvalidOperationException("控件信息已过期，请重新查看当前界面。");
        var root = AutomationElement.FromHandle(target.Handle);
        var element = root.FindFirst(TreeScope.Subtree, new PropertyCondition(AutomationElement.RuntimeIdProperty, saved.RuntimeId));
        if (element is null) throw new InvalidOperationException("目标控件已离开当前界面，请重新查看。");
        var state = element.Current;
        if (SensitiveControl(state) || state.IsOffscreen || requireEnabled && !state.IsEnabled || state.Name != saved.Name ||
            state.ControlType.Id != saved.Type || state.AutomationId != saved.AutomationId)
            throw new InvalidOperationException("控件已变化、不可见或不可操作，请重新查看。");
        return element;
    }

    private JsonObject WaitForControl(string windowId, Target target, JsonElement args, CancellationToken token)
    {
        var query = ClassroomAgentService.Text(args, "query", 100);
        var clock = Stopwatch.StartNew();
        JsonObject result;
        do
        {
            result = InspectControls(windowId, target, token, args);
            if (result["controls"]!.AsArray().Count > 0)
            { result["detail"] = "已在当前界面核对到：" + query; return result; }
            if (token.WaitHandle.WaitOne(120)) token.ThrowIfCancellationRequested();
        } while (clock.Elapsed < TimeSpan.FromSeconds(3));
        result["verified"] = false;
        result["detail"] = "当前界面暂未出现：" + query;
        return result;
    }

    private JsonObject Control(string action, string windowId, Target target, JsonElement args, IReadOnlyList<AgentApplication> apps, CancellationToken token)
    {
        var element = ResolveControl(windowId, target, ClassroomAgentService.Text(args, "controlId", 100));
        token.ThrowIfCancellationRequested();
        Focus(target);
        Func<bool>? verify = null;
        var detail = "已调用选定控件，请根据最新界面核对结果。";
        if (action == "invoke_control")
        {
            if (element.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke)) ((InvokePattern)invoke).Invoke();
            else if (element.TryGetCurrentPattern(TogglePattern.Pattern, out var toggle)) ((TogglePattern)toggle).Toggle();
            else if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selection)) ((SelectionItemPattern)selection).Select();
            else throw new InvalidOperationException("控件不支持调用，请按当前控件报告的操作选择。");
            // A button invocation is dispatch, not proof of a successful save,
            // submission or navigation. Return its actual new UI for reasoning.
        }
        else if (action is "set_control_value" or "type_text")
        {
            var text = ClassroomAgentService.Text(args, "text", 2000, false);
            if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern) || ((ValuePattern)pattern).Current.IsReadOnly)
                throw new InvalidOperationException("所选控件不支持安全填写，不会向未知输入焦点打字。");
            var value = (ValuePattern)pattern;
            value.SetValue(text);
            verify = () => value.Current.Value == text;
            detail = "已填写所选输入框并核对其值。";
        }
        else if (action == "set_control_toggle")
        {
            var expected = args.GetProperty("checked").GetBoolean() ? ToggleState.On : ToggleState.Off;
            if (!element.TryGetCurrentPattern(TogglePattern.Pattern, out var pattern)) throw new InvalidOperationException("此控件不支持勾选。");
            var toggle = (TogglePattern)pattern;
            for (var step = 0; step < 3 && toggle.Current.ToggleState != expected; step++)
            {
                token.ThrowIfCancellationRequested();
                var previous = toggle.Current.ToggleState;
                toggle.Toggle();
                if (!WaitFor(() => toggle.Current.ToggleState != previous, token)) break;
            }
            verify = () => toggle.Current.ToggleState == expected;
            detail = "已核对控件的勾选状态。";
        }
        else if (action == "select_control")
        {
            if (!element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var pattern)) throw new InvalidOperationException("此控件不支持选择。");
            var selection = (SelectionItemPattern)pattern;
            if (!selection.Current.IsSelected) selection.Select();
            verify = () => selection.Current.IsSelected;
            detail = "已核对选中项。";
        }
        else if (action is "expand_control" or "collapse_control")
        {
            if (!element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var pattern)) throw new InvalidOperationException("此控件不支持展开或收起。");
            var expansion = (ExpandCollapsePattern)pattern;
            var expected = action == "expand_control" ? ExpandCollapseState.Expanded : ExpandCollapseState.Collapsed;
            if (expansion.Current.ExpandCollapseState != expected)
            { if (action == "expand_control") expansion.Expand(); else expansion.Collapse(); }
            verify = () => expansion.Current.ExpandCollapseState == expected;
            detail = "已核对控件的展开状态。";
        }
        else if (action == "scroll_control")
        {
            if (!element.TryGetCurrentPattern(ScrollPattern.Pattern, out var pattern)) throw new InvalidOperationException("此区域不支持滚动。");
            var scroll = (ScrollPattern)pattern;
            var before = scroll.Current;
            var beforeVertical = before.VerticalScrollPercent;
            var beforeHorizontal = before.HorizontalScrollPercent;
            var direction = ClassroomAgentService.Text(args, "direction", 10);
            if (direction is not ("up" or "down" or "left" or "right")) throw new InvalidOperationException("滚动方向不正确。");
            var vertical = direction is "up" or "down";
            if (vertical ? !before.VerticallyScrollable : !before.HorizontallyScrollable) throw new InvalidOperationException("此区域在该方向没有可滚动的内容。");
            var amount = direction is "up" or "left" ? ScrollAmount.LargeDecrement : ScrollAmount.LargeIncrement;
            scroll.Scroll(vertical ? ScrollAmount.NoAmount : amount, vertical ? amount : ScrollAmount.NoAmount);
            verify = () => vertical ? scroll.Current.VerticalScrollPercent != beforeVertical : scroll.Current.HorizontalScrollPercent != beforeHorizontal;
            detail = "已核对所选区域的滚动位置。";
        }
        else if (action == "set_control_range")
        {
            var value = args.GetProperty("value").GetDouble();
            if (!element.TryGetCurrentPattern(RangeValuePattern.Pattern, out var pattern)) throw new InvalidOperationException("此控件不支持数值调整。");
            var range = (RangeValuePattern)pattern;
            if (!double.IsFinite(value) || range.Current.IsReadOnly || value < range.Current.Minimum || value > range.Current.Maximum)
                throw new InvalidOperationException("数值超出控件允许范围。");
            range.SetValue(value);
            verify = () => Math.Abs(range.Current.Value - value) < 0.0001;
            detail = "已核对控件数值。";
        }
        else if (action == "focus_control")
        {
            element.SetFocus(); verify = () => element.Current.HasKeyboardFocus;
            detail = "已切到所选控件。";
        }
        else if (action == "press_control_key")
        {
            ushort[] keys = ClassroomAgentService.Text(args, "key", 20) switch
            {
                "enter" => [0x0D], "escape" => [0x1B], "space" => [0x20], "tab" => [0x09], "shift_tab" => [0x10, 0x09],
                "up" => [0x26], "down" => [0x28], "left" => [0x25], "right" => [0x27], "home" => [0x24], "end" => [0x23],
                "page_up" => [0x21], "page_down" => [0x22], _ => throw new InvalidOperationException("仅支持所选控件的标准导航按键。")
            };
            element.SetFocus();
            if (!WaitFor(() => element.Current.HasKeyboardFocus, token)) throw new InvalidOperationException("目标控件未获得输入焦点，未发送按键。");
            Keys(target, keys, token);
            detail = "已向所选控件发送导航按键，请根据最新界面核对结果。";
        }
        bool Reached()
        {
            try { return verify?.Invoke() == true; }
            catch (ElementNotAvailableException) { return false; }
        }
        var verified = verify is not null && WaitFor(Reached, token);
        token.ThrowIfCancellationRequested();
        // UIA callbacks may update their peers asynchronously after Invoke.
        // This is an observation, never a replay of the original action.
        if (verify is null && token.WaitHandle.WaitOne(100)) token.ThrowIfCancellationRequested();
        var desktop = Inspect(apps, token);
        var stillVisible = IsWindow(target.Handle) && IsWindowVisible(target.Handle) && ReadTarget(target.Handle).Title == target.Title;
        var query = ClassroomAgentService.Text(args, "query", 100, false);
        if (action == "invoke_control" && stillVisible && query.Length > 0)
        {
            var observed = WaitForControl(windowId, target, JsonSerializer.SerializeToElement(new { query }), token);
            verified = observed["verified"]?.GetValue<bool>() == true;
            detail = observed["detail"]!.GetValue<string>();
        }
        var result = stillVisible ? InspectControls(windowId, target, token) : new JsonObject { ["targetId"] = windowId, ["controls"] = new JsonArray(), ["windowChanged"] = true };
        result["windows"] = desktop["windows"]?.DeepClone();
        result["performed"] = true; result["verified"] = verified;
        result["detail"] = !stillVisible ? "操作后窗口已关闭或切换，请根据当前窗口继续核对。"
            : verify is not null && !verified ? "操作已发出，控件状态尚未达到目标，请核对最新界面。" : detail;
        return result;
    }
}
