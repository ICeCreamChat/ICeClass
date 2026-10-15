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
    private readonly CheckBox _singleUse = new() { Content = "使用原来的单班一次性绑定码" };
    private readonly CheckBox _startup = new();
    private readonly TextBlock _connection = DesktopStyle.Text("等待绑定", 14, muted: true);
    private readonly TextBlock _updateStatus = DesktopStyle.Text("", 14, muted: true);
    private readonly TextBlock _error = DesktopStyle.Text("", 15);
    private readonly TextBlock _lookupStatus = DesktopStyle.Text("先输入全校绑定码，再读取班级。", 14, muted: true);
    private readonly Button _save = DesktopStyle.Button("绑定并开始陪伴", true);
    private readonly Button _lookup = DesktopStyle.Button("读取班级");
    private readonly Button _checkUpdate = DesktopStyle.Button("检查更新");
    private readonly Button _audioTest = DesktopStyle.Button("测试本机声音");
    private readonly TextBlock _audioTestStatus = DesktopStyle.Text("", 14, muted: true);
    private readonly List<ClassOption> _allClasses = new();
    private List<ClassOption> _visibleClasses = new();
    private string _loadedCode = "", _loadedEndpoint = "";
    private int _classRequest;
    private bool _loadingClasses;
    private readonly StackPanel _classFields = new() { Spacing = 12 };

    public EnrollmentWindow(ReceiverConfig? existing)
    {
        _existing = existing;
        Title = existing is null ? "班伴 · 连接教室" : "班伴 · 教室设置";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 800; Height = 780; MinWidth = 640; MinHeight = 540;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = DesktopStyle.Brush("#F5F5F7");

        _endpoint.Text = existing?.Endpoint ?? ReceiverConfig.TryLoadDefaultEndpoint() ?? "";
        _endpoint.Watermark = "https://iceclass.icecreamchat.top";
        _deviceName.Text = existing?.DeviceName ?? Environment.MachineName;
        _deviceName.MaxLength = 80;
        _code.MaxLength = 40;
        _code.Watermark = existing is null ? "输入管理员提供的全校绑定码" : "更换班级时填写；保持原班级可留空";
        _startup.Content = "开机后自动接收班级通知";
        _startup.IsChecked = existing?.StartWithWindows ?? true;
        _updateStatus.Text = $"当前版本 {ReceiverUpdateService.CurrentVersionText}";
        _error.Foreground = DesktopStyle.Brush("#B42318");
        _error.IsVisible = false;
        _error.PropertyChanged += (_, change) =>
        {
            if (change.Property == TextBlock.TextProperty) _error.IsVisible = !string.IsNullOrWhiteSpace(_error.Text);
        };
        _save.Content = existing is null ? "绑定并开始陪伴" : "保存设置";
        _save.FontSize = 18; _save.MinHeight = 54;
        _save.Click += SaveOnClick;
        _lookup.Click += async (_, _) => await LoadClassesAsync();
        _checkUpdate.Click += (_, _) => UpdateRequested?.Invoke(this, EventArgs.Empty);
        _audioTest.Click += (_, _) => AudioTestRequested?.Invoke(this, EventArgs.Empty);
        _singleUse.IsCheckedChanged += (_, _) => _classFields.IsVisible = _singleUse.IsChecked != true;
        _code.TextChanged += (_, _) => InvalidateClasses();
        _endpoint.TextChanged += (_, _) => { InvalidateClasses(); UpdateStartupControl(); };
        _grades.ItemsSource = new[] { "高一", "高二", "高三" };
        _grades.SelectionChanged += (_, _) => FilterClasses();
        AutomationProperties.SetName(_grades, "年级");
        AutomationProperties.SetName(_classes, "本教室所属班级");
        UpdateStartupControl();

        var introduction = new StackPanel { Spacing = 10 };
        introduction.Children.Add(DesktopStyle.Brand("教室白板客户端"));
        introduction.Children.Add(DesktopStyle.Text(existing is null ? "让这个教室，连接班伴。" : "教室设置", 30, true));
        introduction.Children.Add(DesktopStyle.Text(existing is null ? "全校使用同一个绑定码。选好班级后，通知和早读记录会自动归到本班。" : $"当前班级：{existing.ClassName}。不更换班级时，绑定码可以留空。", 16, muted: true));

        var codeGrid = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        _lookup.Margin = new Thickness(10, 0, 0, 0);
        codeGrid.Children.Add(_code); Grid.SetColumn(_lookup, 1); codeGrid.Children.Add(_lookup);
        _classFields.Children.Add(_lookupStatus);
        _classFields.Children.Add(DesktopStyle.Field("年级", _grades));
        _classFields.Children.Add(DesktopStyle.Field("本教室所属班级", _classes));
        _classFields.Children.Add(DesktopStyle.Text("班级名单由平台同步。后台调整后，点击“刷新班级”即可。", 14, muted: true));
        var binding = new StackPanel { Spacing = 16 };
        binding.Children.Add(DesktopStyle.Field(existing is null ? "全校绑定码" : "重新绑定（选填）", codeGrid));
        binding.Children.Add(_classFields);
        binding.Children.Add(_singleUse);
        binding.Children.Add(_error);
        binding.Children.Add(_save);

        var advanced = new StackPanel { Spacing = 14 };
        advanced.Children.Add(DesktopStyle.Field("平台网址", _endpoint));
        advanced.Children.Add(DesktopStyle.Field("设备名称", _deviceName));
        advanced.Children.Add(DesktopStyle.Text($"电脑名称：{Environment.MachineName}", 15, muted: true));
        if (existing is not null)
        {
            var identity = new TextBox { Text = ComputerIdentity.DeviceCode(existing.DeviceId), IsReadOnly = true };
            ToolTip.SetTip(identity, existing.DeviceId);
            advanced.Children.Add(DesktopStyle.Field("设备识别编号（与后台一致）", identity));
        }
        advanced.Children.Add(_startup);
        advanced.Children.Add(_connection);
        advanced.Children.Add(DesktopStyle.Text("客户端更新", 18, true));
        advanced.Children.Add(_updateStatus);
        advanced.Children.Add(DesktopStyle.Text("新功能发布后自动检查更新，也可手动检查。更新会保留本教室绑定和本机设置。", 14, muted: true));
        advanced.Children.Add(_checkUpdate);
        advanced.Children.Add(BuildPreviewPanel());
        var options = new Expander { Header = "连接、更新与声音设置", Content = advanced, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, IsExpanded = string.IsNullOrWhiteSpace(_endpoint.Text) };
        Content = new ScrollViewer
        {
            Content = new Border { Padding = new Thickness(36, 30), Child = new StackPanel { Spacing = 24, Children = { introduction, DesktopStyle.Card(binding), options } } },
            HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled,
        };
    }

    public event EventHandler<ReceiverConfig>? Saved;
    public event EventHandler? UpdateRequested;
    public event Action<string>? PreviewRequested;
    public event EventHandler? AudioTestRequested;

    public void SetConnectionState(ReceiverConnectionState state)
    {
        _connection.Text = state.Text;
        _connection.Foreground = DesktopStyle.Brush(state.Connected ? "#167447" : "#97591B");
    }
    public void SetUpdateState(string text, bool checking) { _updateStatus.Text = text; _checkUpdate.IsEnabled = !checking; }
    public void SetAudioTestState(string text, bool playing) { _audioTestStatus.Text = text; _audioTest.IsEnabled = !playing; }

    private Control BuildPreviewPanel()
    {
        var row = new WrapPanel { Orientation = Orientation.Horizontal };
        foreach (var (text, level) in new[] { ("普通通知", "info"), ("重要通知", "warning"), ("紧急通知", "urgent") })
        {
            var button = DesktopStyle.Button(text); button.Margin = new Thickness(0, 0, 10, 10);
            button.Click += (_, _) => PreviewRequested?.Invoke(level); row.Children.Add(button);
        }
        return new StackPanel { Spacing = 10, Children = { DesktopStyle.Text("通知预览与声音测试", 18, true), row, _audioTest, _audioTestStatus } };
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
        endpoint = null!; _error.Text = "请在连接设置中填写完整的 HTTPS 平台网址。"; return false;
    }
    private async Task LoadClassesAsync()
    {
        _error.Text = "";
        if (_singleUse.IsChecked == true) { _error.Text = "一次性绑定码可以直接绑定，无需读取班级。"; return; }
        if (!TryEndpoint(out var endpoint)) return;
        var code = (_code.Text ?? "").Trim();
        if (code.Length == 0) { _error.Text = "请输入管理员提供的全校绑定码。"; return; }
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
        if (deviceName.Length is < 1 or > 80) { _error.Text = "设备名称应为 1 至 80 个字符。"; return; }
        if (code.Length == 0 && _existing is null) { _error.Text = "请输入全校绑定码。"; return; }
        string? classId = null;
        if (code.Length > 0 && _singleUse.IsChecked != true)
        {
            if (_loadedCode != code || _loadedEndpoint != endpoint.ToString()) { await LoadClassesAsync(); return; }
            if (_grades.SelectedIndex < 0) { _error.Text = "请先选择年级，再选择本教室的班级。"; _grades.Focus(); return; }
            if (_classes.SelectedIndex < 0 || _classes.SelectedIndex >= _visibleClasses.Count) { _error.Text = "请选择本教室的班级。"; return; }
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
        finally { _save.Content = _existing is null ? "绑定并开始陪伴" : "保存设置"; _save.IsEnabled = true; _lookup.IsEnabled = true; }
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
