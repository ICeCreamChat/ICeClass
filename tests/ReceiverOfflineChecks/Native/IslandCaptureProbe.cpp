// Standalone diagnostic only. Compile with the installed Windows SDK / MSVC.
// It captures synthetic windows, reads a small crop in memory and writes metrics.
// It never saves screen pixels or changes capture affinity on an ICeClass window.
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <dwmapi.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <algorithm>
#include <chrono>
#include <iostream>
#include <thread>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
using Clock = std::chrono::steady_clock;

static LRESULT CALLBACK SurfaceProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam)
{
    if (message == WM_TIMER) { InvalidateRect(window, nullptr, FALSE); return 0; }
    if (message == WM_PAINT)
    {
        PAINTSTRUCT paint{}; auto dc = BeginPaint(window, &paint); RECT bounds{}; GetClientRect(window, &bounds);
        const auto kind = GetWindowLongPtr(window, GWLP_USERDATA);
        const bool overlay = kind != 0;
        auto brush = CreateSolidBrush(kind == 2 ? RGB(29, 205, 144) : overlay ? RGB(229, 40, 88) : RGB(33, 108, 164));
        FillRect(dc, &bounds, brush); DeleteObject(brush);
        if (!overlay)
        {
            const auto x = static_cast<int>((GetTickCount64() / 6) % 1200);
            RECT stripe{x, 130, x + 6, bounds.bottom}; FillRect(dc, &stripe, static_cast<HBRUSH>(GetStockObject(WHITE_BRUSH)));
        }
        EndPaint(window, &paint); return 0;
    }
    return DefWindowProc(window, message, wParam, lParam);
}

static void Pump()
{
    MSG message{};
    while (PeekMessage(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessage(&message); }
}

static double CpuMilliseconds()
{
    FILETIME creation{}, exit{}, kernel{}, user{};
    check_bool(GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user));
    ULARGE_INTEGER k{}, u{}; k.LowPart = kernel.dwLowDateTime; k.HighPart = kernel.dwHighDateTime;
    u.LowPart = user.dwLowDateTime; u.HighPart = user.dwHighDateTime;
    return static_cast<double>(k.QuadPart + u.QuadPart) / 10000.;
}

static com_ptr<ID3D11Texture2D> TextureFromSurface(IDirect3DSurface const& surface)
{
    auto access = surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    com_ptr<ID3D11Texture2D> texture; check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D), texture.put_void()));
    return texture;
}

int main()
{
    HWND background{}, overlay{}, proxy{}; HTHUMBNAIL thumbnail{};
    try
    {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        init_apartment(apartment_type::multi_threaded);
        WNDCLASSW type{}; type.lpfnWndProc = SurfaceProc; type.hInstance = GetModuleHandle(nullptr); type.lpszClassName = L"ICeClassCaptureProbe";
        check_bool(RegisterClass(&type));
        background = CreateWindowEx(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, type.lpszClassName, L"原生折射性能检查背景",
            WS_POPUP | WS_VISIBLE, 160, 220, 1300, 300, nullptr, nullptr, type.hInstance, nullptr);
        overlay = CreateWindowEx(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, type.lpszClassName, L"原生折射性能检查前景",
            WS_POPUP | WS_VISIBLE, 240, 260, 400, 90, nullptr, nullptr, type.hInstance, nullptr);
        check_bool(background && overlay); SetWindowLongPtr(overlay, GWLP_USERDATA, 1);
        UpdateWindow(background); InvalidateRect(overlay, nullptr, FALSE); UpdateWindow(overlay);
        SetTimer(background, 1, 16, nullptr);
        proxy = CreateWindowEx(WS_EX_TOOLWINDOW, type.lpszClassName, L"背景取样代理检查", WS_POPUP | WS_VISIBLE,
            GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN) + 100, 220, 1200, 240,
            nullptr, nullptr, type.hInstance, nullptr);
        check_bool(proxy); SetWindowLongPtr(proxy, GWLP_USERDATA, 2); InvalidateRect(proxy, nullptr, FALSE); UpdateWindow(proxy);
        check_hresult(DwmRegisterThumbnail(proxy, background, &thumbnail));
        DWM_THUMBNAIL_PROPERTIES thumb{}; thumb.dwFlags = DWM_TNP_RECTDESTINATION | DWM_TNP_RECTSOURCE | DWM_TNP_OPACITY | DWM_TNP_VISIBLE | DWM_TNP_SOURCECLIENTAREAONLY;
        thumb.rcDestination = {0, 0, 1200, 240}; thumb.rcSource = {0, 0, 1200, 240}; thumb.opacity = 255; thumb.fVisible = TRUE; thumb.fSourceClientAreaOnly = TRUE;
        check_hresult(DwmUpdateThumbnailProperties(thumbnail, &thumb));

        const auto baselineStart = Clock::now(); const auto baselineCpu = CpuMilliseconds();
        while (Clock::now() - baselineStart < std::chrono::seconds(2)) { Pump(); Sleep(4); }
        std::cout << "baseline: processCpuMs=" << CpuMilliseconds() - baselineCpu << "/2000ms\n";

        com_ptr<ID3D11Device> device; com_ptr<ID3D11DeviceContext> context;
        check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, context.put()));
        auto dxgi = device.as<IDXGIDevice>(); com_ptr<::IInspectable> inspectable;
        check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), inspectable.put()));
        auto direct3d = inspectable.as<IDirect3DDevice>();
        auto interop = get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();

        for (const auto mode : { 0, 1, 2, 3 })
        {
            GraphicsCaptureItem item{nullptr}; POINT origin{160, 220};
            if (mode >= 2)
            {
                check_hresult(interop->CreateForWindow(mode == 3 ? proxy : background, guid_of<GraphicsCaptureItem>(), put_abi(item)));
                origin = {0, 0};
            }
            else
            {
                const auto monitor = MonitorFromWindow(background, MONITOR_DEFAULTTONEAREST); MONITORINFO info{sizeof(info)};
                check_bool(GetMonitorInfo(monitor, &info)); origin.x -= info.rcMonitor.left; origin.y -= info.rcMonitor.top;
                check_hresult(interop->CreateForMonitor(monitor, guid_of<GraphicsCaptureItem>(), put_abi(item)));
            }
            check_bool(SetWindowDisplayAffinity(overlay, mode == 1 ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE));
            auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(direct3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, item.Size());
            auto session = pool.CreateCaptureSession(item); session.IsCursorCaptureEnabled(false);
            D3D11_TEXTURE2D_DESC desc{}; desc.Width = 1200; desc.Height = 240; desc.MipLevels = desc.ArraySize = 1;
            desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_STAGING; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            com_ptr<ID3D11Texture2D> staging; check_hresult(device->CreateTexture2D(&desc, nullptr, staging.put()));
            session.StartCapture(); const auto started = Clock::now(); const auto cpu = CpuMilliseconds();
            std::vector<double> times; unsigned color{};
            while (Clock::now() - started < std::chrono::seconds(3))
            {
                Pump(); auto frame = pool.TryGetNextFrame();
                if (!frame) { Sleep(1); continue; }
                const auto begin = Clock::now(); auto texture = TextureFromSurface(frame.Surface());
                const D3D11_BOX crop{static_cast<UINT>(origin.x), static_cast<UINT>(origin.y), 0,
                    static_cast<UINT>(origin.x + 1200), static_cast<UINT>(origin.y + 240), 1};
                context->CopySubresourceRegion(staging.get(), 0, 0, 0, 0, texture.get(), 0, &crop);
                D3D11_MAPPED_SUBRESOURCE data{}; check_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &data));
                color = *reinterpret_cast<unsigned*>(static_cast<char*>(data.pData) + 70 * data.RowPitch + 180 * 4) & 0xFFFFFF;
                context->Unmap(staging.get(), 0); frame.Close();
                times.push_back(std::chrono::duration<double, std::milli>(Clock::now() - begin).count());
                Sleep(15);
            }
            std::sort(times.begin(), times.end());
            if (times.empty()) throw hresult_error(E_FAIL, L"Capture returned no frames.");
            std::cout << (mode == 0 ? "monitor-self" : mode == 1 ? "monitor-excluded" : mode == 2 ? "background-window" : "offscreen-thumbnail")
                << ": frames=" << times.size() << ", medianMs=" << times[times.size() / 2] << ", p95Ms=" << times[times.size() * 95 / 100]
                << ", processCpuMs=" << CpuMilliseconds() - cpu << "/3000ms, frame=" << item.Size().Width << "x" << item.Size().Height
                << ", crop=1200x240, rgb=#" << std::hex << color << std::dec << "\n";
            session.Close(); pool.Close();
        }
        SetWindowDisplayAffinity(overlay, WDA_NONE); KillTimer(background, 1); DwmUnregisterThumbnail(thumbnail); DestroyWindow(proxy); DestroyWindow(overlay); DestroyWindow(background);
        std::cout << "Capture resources released; test capture affinity restored.\n"; return 0;
    }
    catch (hresult_error const& error)
    {
        std::wcerr << L"capture probe failed: 0x" << std::hex << error.code().value << L" " << error.message().c_str() << L"\n";
        if (overlay) { SetWindowDisplayAffinity(overlay, WDA_NONE); DestroyWindow(overlay); }
        if (thumbnail) DwmUnregisterThumbnail(thumbnail);
        if (proxy) DestroyWindow(proxy);
        if (background) DestroyWindow(background);
        return 1;
    }
}
