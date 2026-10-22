using System.Net.Http.Json;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;

namespace ICeClass.Receiver;

public sealed class EnrollmentWindow : Window
{
    private readonly ReceiverConfig? _existing;
    private readonly TextBox _endpoint = new();
    private readonly TextBox _deviceName = new();
    private readonly TextBox _code = new();
    private readonly ComboBox _grades = new() { PlaceholderText = "请先读取班级", HorizontalAlignment = HorizontalAlignment.Stretch, IsEnabled = false };
    private readonly ComboBox _classes = new() { PlaceholderText = "请先选择年级", HorizontalAlignment = HorizontalAlignment.Stretch, IsEnabled = false };
    private readonly CheckBox _singleUse = new() { Content = "使用单班一次性绑定码" };
    private readonly CheckBox _startup = new();
    private readonly TextBlock _connection = ClassroomStyle.Text("等待绑定", 14, muted: true);
    private readonly TextBlock _updateStatus = ClassroomStyle.Text("", 14, muted: true);
    private readonly TextBlock _error = ClassroomStyle.Text("", 14);
    private readonly TextBlock _lookupStatus = ClassroomStyle.Text("先输入全校绑定码，再读取班级。", 14, muted: true);
    private readonly Button _save = ClassroomStyle.Button("绑定此教室", true);
    private readonly Button _lookup = ClassroomStyle.Button("读取班级");
    private readonly Button _checkUpdate = ClassroomStyle.Button("检查更新");
    private readonly Button _audioTest = ClassroomStyle.Button("测试本机声音");
    private readonly TextBlock _audioTestStatus = ClassroomStyle.Text("", 14, muted: true);
    private readonly List<ClassOption> _allClasses = new();
    private List<ClassOption> _visibleClasses = new();
    private string _loadedCode = "", _loadedEndpoint = "";
    private int _classRequest;
    private bool _loadingClasses;
    private readonly StackPanel _classFields = new() { Spacing = 10 };

    public EnrollmentWindow(ReceiverConfig? existing)
    {
        ClassroomStyle.Apply(this);
        _existing = existing;
        Title = existing is null ? "ICeClass 班伴 · 连接教室" : "ICeClass 班伴 · 教室设置";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 760; Height = 780; MinWidth = 640; MinHeight = 540;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = DesktopStyle.Brush("#F5F7FB");
        DesktopStyle.KeepWindowInWorkingArea(this);

        _endpoint.Text = existing?.Endpoint ?? ReceiverConfig.TryLoadDefaultEndpoint() ?? "";
        _endpoint.Watermark = "https://iceclass.icecreamchat.top";
        _deviceName.Text = existing?.DeviceName ?? Environment.MachineName;
        _deviceName.MaxLength = 80;
        _code.MaxLength = 40;
        _code.Watermark = existing is null ? "输入全校绑定码" : "输入绑定码以更换班级";
        _startup.Content = "开机后自动接收班级通知";
        _startup.IsChecked = existing?.StartWithWindows ?? true;
        _updateStatus.Text = $"当前版本 {ReceiverUpdateService.CurrentVersionText}";
        _error.Foreground = DesktopStyle.Brush("#B42318");
        _error.IsVisible = false;
        _error.PropertyChanged += (_, change) =>
        {
            if (change.Property == TextBlock.TextProperty) _error.IsVisible = !string.IsNullOrWhiteSpace(_error.Text);
        };
        _save.Content = existing is null ? "绑定此教室" : "保存设置";
        _save.MinHeight = 40;
        _save.Click += SaveOnClick;
        CompactAction(_checkUpdate); _checkUpdate.MinWidth = 104;
        CompactAction(_audioTest); _audioTest.MinWidth = 132;
        _audioTestStatus.IsVisible = false;
        _singleUse.FontSize = 14; _startup.FontSize = 14;
        ToolTip.SetTip(_checkUpdate, "启动后自动检查更新；更新会保留本教室绑定和本机设置。");
        _lookup.Click += async (_, _) => await LoadClassesAsync();
        _checkUpdate.Click += (_, _) => UpdateRequested?.Invoke(this, EventArgs.Empty);
        _audioTest.Click += (_, _) => AudioTestRequested?.Invoke(this, EventArgs.Empty);
        _singleUse.IsCheckedChanged += (_, _) => _classFields.IsVisible = _singleUse.IsChecked != true;
        _code.TextChanged += (_, _) => InvalidateClasses();
        _endpoint.TextChanged += (_, _) => { InvalidateClasses(); UpdateStartupControl(); };
        _grades.ItemsSource = new[] { "高一", "高二", "高三" };
        _grades.SelectionChanged += (_, _) => FilterClasses();
        AutomationProperties.SetName(_endpoint, "平台网址");
        AutomationProperties.SetName(_deviceName, "设备名称");
        AutomationProperties.SetName(_code, "全校绑定码");
        AutomationProperties.SetName(_grades, "年级");
        AutomationProperties.SetName(_classes, "本教室所属班级");
        UpdateStartupControl();

        var introduction = new StackPanel { Spacing = 4 };
        introduction.Children.Add(ClassroomStyle.Title(existing is null ? "连接此教室" : "教室设置"));
        introduction.Children.Add(ClassroomStyle.Text(existing is null ? "输入绑定码，读取班级后选择本教室归属。" : "管理这台电脑的连接、班级与声音。", 14, muted: true));
        var body = new StackPanel { Spacing = 16, MaxWidth = 656, HorizontalAlignment = HorizontalAlignment.Stretch, Children = { introduction } };

        var codeGrid = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        _lookup.Margin = new Thickness(12, 0, 0, 0);
        _lookup.MinHeight = 40; _lookup.VerticalAlignment = VerticalAlignment.Stretch;
        codeGrid.Children.Add(_code); Grid.SetColumn(_lookup, 1); codeGrid.Children.Add(_lookup);
        _classFields.Children.Add(_lookupStatus);
        var classGrid = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*") };
        var gradeField = ClassroomStyle.Field("年级", _grades); gradeField.Margin = new Thickness(0, 0, 6, 0);
        var classField = ClassroomStyle.Field("班级", _classes); classField.Margin = new Thickness(6, 0, 0, 0);
        classGrid.Children.Add(gradeField); Grid.SetColumn(classField, 1); classGrid.Children.Add(classField);
        _classFields.Children.Add(classGrid);
        _classFields.Children.Add(ClassroomStyle.Text("名单由学校管理，可随时刷新。", 14, muted: true));
        var binding = new StackPanel { Spacing = 12, Children = { ClassroomStyle.Field("全校绑定码", codeGrid), _classFields } };
        binding.Children.Add(_singleUse);
        if (existing is null) body.Children.Add(Section("绑定班级", binding));
        else
        {
            var current = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
            current.Children.Add(new StackPanel { Spacing = 2, Children = {
                ClassroomStyle.Text("当前班级", 13, muted: true), ClassroomStyle.Text(existing.ClassName, 18, true) } });
            _connection.FontSize = 13; _connection.MaxWidth = 160; _connection.VerticalAlignment = VerticalAlignment.Center;
            var changeClass = DesktopStyle.Button("更换班级"); CompactAction(changeClass);
            changeClass.Classes.Add("settings-binding-toggle");
            var classActions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12,
                VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(16, 0, 0, 0),
                Children = { _connection, changeClass } };
            Grid.SetColumn(classActions, 1); current.Children.Add(classActions);
            var bindingForm = new StackPanel { Spacing = 12, IsVisible = false,
                Children = { Divider(), binding } };
            changeClass.Click += (_, _) =>
            {
                bindingForm.IsVisible = !bindingForm.IsVisible;
                changeClass.Content = bindingForm.IsVisible ? "收起" : "更换班级";
                AutomationProperties.SetName(changeClass, bindingForm.IsVisible ? "收起更换班级表单" : "更换班级");
            };
            body.Children.Add(SettingsCard(new StackPanel { Spacing = 12, Children = { current, bindingForm } }));
        }

        var device = new StackPanel { Spacing = 12 };
        device.Children.Add(ClassroomStyle.Field("平台网址", _endpoint));
        device.Children.Add(new StackPanel { Spacing = 6, Children = {
            ClassroomStyle.Field("设备名称", _deviceName),
            ClassroomStyle.Text("使用易识别的名称，方便管理员核对教室电脑。", 13, muted: true) } });
        var identity = new StackPanel { Spacing = 4 };
        if (existing is not null)
        {
            var deviceCode = ClassroomStyle.Text($"设备编号：{ComputerIdentity.DeviceCode(existing.DeviceId)}", 13, muted: true);
            ToolTip.SetTip(deviceCode, existing.DeviceId); identity.Children.Add(deviceCode);
        }
        identity.Children.Add(ClassroomStyle.Text($"电脑名称：{Environment.MachineName}", 13, muted: true));
        device.Children.Add(identity);
        device.Children.Add(_startup);
        body.Children.Add(Section("连接与设备", device));

        _updateStatus.FontSize = 13;
        var maintenance = new StackPanel { Spacing = 12, Children = {
            SettingRow("客户端更新", _updateStatus, _checkUpdate), Divider(), BuildPreviewPanel() } };
        body.Children.Add(Section("更新与测试", maintenance));
        var root = new Grid { RowDefinitions = new RowDefinitions("*,Auto") };
        root.Children.Add(new ScrollViewer {
            Content = new Border { Padding = new Thickness(28, 20), Child = body },
            HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled });
        var actions = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        var cancel = ClassroomStyle.Button("取消"); cancel.MinWidth = 100; cancel.HorizontalAlignment = HorizontalAlignment.Left;
        cancel.Click += (_, _) => Close(); actions.Children.Add(cancel);
        _save.MinWidth = 144; _save.HorizontalAlignment = HorizontalAlignment.Right;
        Grid.SetColumn(_save, 1); actions.Children.Add(_save);
        var errorBox = new Border { Background = DesktopStyle.Brush("#FFF1EF"), CornerRadius = new CornerRadius(8),
            Padding = new Thickness(12, 10), Child = _error, IsVisible = _error.IsVisible };
        _error.PropertyChanged += (_, change) => { if (change.Property == IsVisibleProperty) errorBox.IsVisible = _error.IsVisible; };
        var footer = new StackPanel { Spacing = 8, MaxWidth = 656, HorizontalAlignment = HorizontalAlignment.Stretch,
            Children = { errorBox, actions } };
        var footerBox = DesktopStyle.DialogFooter(footer, 28);
        Grid.SetRow(footerBox, 1); root.Children.Add(footerBox); Content = root;
    }

    public event EventHandler<ReceiverConfig>? Saved;
    public event EventHandler? UpdateRequested;
    public event Action<string>? PreviewRequested;
    public event EventHandler? AudioTestRequested;

    public void SetConnectionState(ReceiverConnectionState state)
    {
        _connection.Text = state.Connected ? "已连接平台" : state.Text;
        _connection.Foreground = DesktopStyle.Brush(state.Connected ? "#167447" : "#97591B");
    }
    public void SetUpdateState(string text, bool checking) { _updateStatus.Text = text; _checkUpdate.IsEnabled = !checking; }
    public void SetAudioTestState(string text, bool playing)
    {
        _audioTestStatus.Text = text; _audioTestStatus.IsVisible = !string.IsNullOrWhiteSpace(text); _audioTest.IsEnabled = !playing;
    }

    private static void CompactAction(Button button)
    {
        button.FontSize = 14; button.MinHeight = 40; button.Padding = new Thickness(12, 6);
        button.HorizontalAlignment = HorizontalAlignment.Left;
    }
    private static Border SettingsCard(Control content) => ClassroomStyle.SettingsCard(content);
    private static Border Divider() => ClassroomStyle.SettingsDivider();
    private static StackPanel Section(string title, Control content) => ClassroomStyle.SettingsSection(title, content);
    private static Grid SettingRow(string title, Control description, Control action)
    {
        var row = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        row.Children.Add(new StackPanel { Spacing = 3, VerticalAlignment = VerticalAlignment.Center,
            Children = { ClassroomStyle.Text(title, 14, true), description } });
        action.Margin = new Thickness(16, 0, 0, 0); action.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(action, 1); row.Children.Add(action); return row;
    }

    private Control BuildPreviewPanel()
    {
        var row = new WrapPanel { Orientation = Orientation.Horizontal };
        foreach (var (text, level) in new[] { ("普通通知", "info"), ("重要通知", "warning"), ("紧急通知", "urgent") })
        {
            var button = DesktopStyle.Button(text); CompactAction(button); button.Margin = new Thickness(row.Children.Count == 0 ? 0 : 8, 0, 0, 0);
            button.Click += (_, _) => PreviewRequested?.Invoke(level); row.Children.Add(button);
        }
        return new StackPanel { Spacing = 12, Children = {
            SettingRow("通知预览", ClassroomStyle.Text("仅在本机显示，不向班级发送。", 13, muted: true), row),
            SettingRow("声音测试", ClassroomStyle.Text("播放本机提示音。", 13, muted: true), _audioTest), _audioTestStatus } };
    }
    private void InvalidateClasses()
    {
        ++_classRequest;
        _loadedCode = ""; _loadedEndpoint = ""; _allClasses.Clear(); _visibleClasses.Clear();
        _grades.SelectedIndex = -1; _grades.IsEnabled = false; _grades.PlaceholderText = "请先读取班级";
        _classes.ItemsSource = null; _classes.IsEnabled = false; _classes.PlaceholderText = "请先选择年级";
        _lookup.Content = _loadingClasses ? "读取中…" : "读取班级";
        _lookupStatus.Text = "先读取班级，再依次选择年级和班级。";
    }
    private void UpdateStartupControl()
    {
        var local = Uri.TryCreate(_endpoint.Text, UriKind.Absolute, out var endpoint) && endpoint.IsLoopback;
        _startup.IsEnabled = !local;
        _startup.Content = local ? "本地验收不会修改电脑的开机启动设置" : "开机后自动接收班级通知";
    }
    private ClassOption? SelectedClass => _classes.SelectedIndex >= 0 && _classes.SelectedIndex < _visibleClasses.Count ? _visibleClasses[_classes.SelectedIndex] : null;

    private void FilterClasses(string? selectedId = null)
    {
        var grade = _grades.SelectedItem as string;
        _visibleClasses = _allClasses.Where(c => c.Grade == grade).OrderBy(c => c.Number).ThenBy(c => c.Name, StringComparer.Ordinal).ToList();
        _classes.ItemsSource = _visibleClasses.Select(c => c.Name).ToArray();
        _classes.SelectedIndex = _visibleClasses.FindIndex(c => c.Id == selectedId);
        _classes.IsEnabled = !_loadingClasses && _visibleClasses.Count > 0;
        _classes.PlaceholderText = grade is null ? "请先选择年级" : _visibleClasses.Count == 0 ? "该年级暂无启用班级" : "请选择本教室的班级";
        if (_allClasses.Count > 0)
            _lookupStatus.Text = grade is null ? $"已同步 {_allClasses.Count} 个班级，请先选择年级。" : $"{grade} · {_visibleClasses.Count} 个班级，请核对本教室归属。";
    }
    private bool TryEndpoint(out Uri endpoint)
    {
        var value = (_endpoint.Text ?? "").Trim().TrimEnd('/');
        if (!value.Contains("://", StringComparison.Ordinal)) value = "https://" + value;
        if (Uri.TryCreate(value, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback))) { endpoint = uri; return true; }
        endpoint = null!; _error.Text = "请在“连接与设备”中填写完整的 HTTPS 平台网址。"; _endpoint.Focus(); return false;
    }
    private async Task LoadClassesAsync()
    {
        _error.Text = "";
        if (_singleUse.IsChecked == true) { _error.Text = "一次性绑定码可以直接绑定，无需读取班级。"; return; }
        if (!TryEndpoint(out var endpoint)) return;
        var code = (_code.Text ?? "").Trim();
        if (code.Length == 0) { _error.Text = "请输入全校绑定码。"; _code.Focus(); return; }
        var selectedId = SelectedClass?.Id ?? (_loadedCode.Length == 0 ? _existing?.ClassId : null);
        var selectedGrade = _grades.SelectedItem as string;
        var request = ++_classRequest;
        _loadingClasses = true; _grades.IsEnabled = false; _classes.IsEnabled = false;
        _lookup.IsEnabled = false; _save.IsEnabled = false; _lookup.Content = "读取中…";
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            using var response = await client.PostAsJsonAsync(new Uri(endpoint, "/api/device/enrollment/classes"), new { code });
            var text = await response.Content.ReadAsStringAsync();
            if (request != _classRequest) return;
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException(TryReadError(text) ?? $"读取失败（{(int)response.StatusCode}）。");
            // Ignore a response if the user edited the code or address while the request was in flight.
            if ((_code.Text ?? "").Trim() != code || !TryEndpoint(out var current) || current != endpoint) return;
            var data = JsonSerializer.Deserialize<ClassList>(text, JsonOptions) ?? throw new InvalidOperationException("班级列表无法识别。");
            _allClasses.Clear(); _allClasses.AddRange(data.Classes.Where(c => !string.IsNullOrWhiteSpace(c.Id) && !string.IsNullOrWhiteSpace(c.Name)));
            _loadedCode = code; _loadedEndpoint = endpoint.ToString();
            _grades.ItemsSource = _allClasses.Any(c => c.Grade == "其他班级") ? new[] { "高一", "高二", "高三", "其他班级" } : new[] { "高一", "高二", "高三" };
            _grades.SelectedItem = selectedGrade ?? _allClasses.FirstOrDefault(c => c.Id == selectedId)?.Grade;
            _grades.PlaceholderText = "请选择年级";
            FilterClasses(selectedId);
            if (_allClasses.Count == 0) _lookupStatus.Text = "平台还没有启用的班级，请联系管理员。";
        }
        catch (Exception error)
        {
            if (request != _classRequest) return;
            InvalidateClasses();
            _error.Text = error is TaskCanceledException ? "读取超时，请检查网络后重试。" : error is HttpRequestException ? "无法连接平台，请检查网络与网址。" : error.Message;
        }
        finally
        {
            _loadingClasses = false;
            _lookup.Content = _loadedCode.Length > 0 ? "刷新班级" : "读取班级"; _lookup.IsEnabled = true; _save.IsEnabled = true;
            _grades.IsEnabled = _allClasses.Count > 0; _classes.IsEnabled = _visibleClasses.Count > 0;
        }
    }
    private async void SaveOnClick(object? sender, Avalonia.Interactivity.RoutedEventArgs args)
    {
        _error.Text = "";
        if (!TryEndpoint(out var endpoint)) return;
        var deviceName = (_deviceName.Text ?? "").Trim(); var code = (_code.Text ?? "").Trim();
        if (deviceName.Length is < 1 or > 80) { _error.Text = "设备名称应为 1 至 80 个字符。"; _deviceName.Focus(); return; }
        if (code.Length == 0 && _existing is null) { _error.Text = "请输入全校绑定码。"; _code.Focus(); return; }
        string? classId = null;
        if (code.Length > 0 && _singleUse.IsChecked != true)
        {
            if (_loadedCode != code || _loadedEndpoint != endpoint.ToString()) { await LoadClassesAsync(); return; }
            if (_grades.SelectedIndex < 0) { _error.Text = "请先选择年级，再选择本教室的班级。"; _grades.Focus(); return; }
            if (_classes.SelectedIndex < 0 || _classes.SelectedIndex >= _visibleClasses.Count) { _error.Text = "请选择本教室的班级。"; _classes.Focus(); return; }
            classId = _visibleClasses[_classes.SelectedIndex].Id;
        }
        _save.IsEnabled = false; _lookup.IsEnabled = false;
        try
        {
            ReceiverConfig config;
            if (code.Length == 0 && _existing is not null)
            {
                if (!string.Equals(endpoint.ToString().TrimEnd('/'), _existing.Endpoint.TrimEnd('/'), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("更换平台网址需要重新输入绑定码并绑定。原设备身份不会发送到新平台。");
                config = new ReceiverConfig { Endpoint = _existing.Endpoint, DeviceId = _existing.DeviceId, DeviceToken = _existing.DeviceToken, ClassId = _existing.ClassId, ClassName = _existing.ClassName, DeviceName = deviceName, StartWithWindows = _startup.IsChecked == true };
            }
            else
            {
                _save.Content = "正在连接教室…";
                using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
                var samePlatform = _existing is not null && string.Equals(endpoint.ToString().TrimEnd('/'), _existing.Endpoint.TrimEnd('/'), StringComparison.OrdinalIgnoreCase);
                if (samePlatform) client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _existing!.DeviceToken);
                var response = await client.PostAsJsonAsync(new Uri(endpoint, "/api/device/enroll"), new { code, deviceName, classId,
                    replaceDeviceId = samePlatform ? _existing!.DeviceId : null, computer = ComputerIdentity.Snapshot() });
                var text = await response.Content.ReadAsStringAsync();
                if (!response.IsSuccessStatusCode) throw new InvalidOperationException(TryReadError(text) ?? $"平台返回错误（{(int)response.StatusCode}）。");
                var data = JsonSerializer.Deserialize<EnrollmentResponse>(text, JsonOptions) ?? throw new InvalidOperationException("平台返回内容无法识别。");
                if (string.IsNullOrWhiteSpace(data.DeviceId) || string.IsNullOrWhiteSpace(data.DeviceToken)) throw new InvalidOperationException("平台未返回完整设备信息。");
                config = new ReceiverConfig { Endpoint = endpoint.ToString().TrimEnd('/'), DeviceId = data.DeviceId, DeviceToken = data.DeviceToken, ClassId = data.ClassId, ClassName = data.ClassName, DeviceName = deviceName, StartWithWindows = _startup.IsChecked == true };
            }
            ReceiverConfig.Save(config); Saved?.Invoke(this, config);
        }
        catch (TaskCanceledException) { _error.Text = "连接超时，请检查网络后重试。"; }
        catch (HttpRequestException) { _error.Text = "无法连接平台，请检查网络和网址。"; }
        catch (UnauthorizedAccessException) { _error.Text = "无法保存配置，请将程序放在可写文件夹。"; }
        catch (IOException) { _error.Text = "配置保存失败，请检查文件夹权限和磁盘空间。"; }
        catch (Exception error) { _error.Text = error.Message; AppLog.Error("Device enrollment failed", error); }
        finally { _save.Content = _existing is null ? "绑定此教室" : "保存设置"; _save.IsEnabled = true; _lookup.IsEnabled = true; }
    }
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static string? TryReadError(string text) { try { return JsonSerializer.Deserialize<ApiError>(text, JsonOptions)?.Error; } catch { return null; } }
    private sealed class ApiError { public string Error { get; set; } = ""; }
    private sealed class ClassOption
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string Grade => new[] { "高一", "高二", "高三" }.FirstOrDefault(grade => Name.StartsWith(grade, StringComparison.Ordinal)) ?? "其他班级";
        public int Number => int.TryParse(Regex.Match(Name, @"\d+").Value, out var number) ? number : int.MaxValue;
    }
    private sealed class ClassList { public List<ClassOption> Classes { get; set; } = new(); }
    private sealed class EnrollmentResponse { public string DeviceId { get; set; } = ""; public string DeviceToken { get; set; } = ""; public string ClassId { get; set; } = ""; public string ClassName { get; set; } = ""; }
}
