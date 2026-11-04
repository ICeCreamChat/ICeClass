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
#include <array>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
using Clock = std::chrono::steady_clock;

namespace
{
    struct Request { HWND source{}; RECT screen{}; unsigned long long generation{}; };
    bool Same(RECT a, RECT b) { return a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom; }
    struct Capture
    {
        std::mutex gate; std::condition_variable wake;
        bool stopping{}; Request request{};
        std::vector<unsigned char> pixels; int width{}, height{}, status{}, frames{};
        unsigned long long version{}; double captureMilliseconds{};
        std::thread worker;

        Capture() { worker = std::thread([this] { Run(); }); }
        ~Capture() { { std::lock_guard lock(gate); stopping = true; } wake.notify_one(); worker.join(); }

        void Run() noexcept
        {
            HWND host{}; HTHUMBNAIL thumbnail{};
            Direct3D11CaptureFramePool pool{nullptr}; GraphicsCaptureSession session{nullptr};
            bool apartmentInitialized{};
            auto closeSession = [&] { if (session) { session.Close(); session = nullptr; } if (pool) { pool.Close(); pool = nullptr; } };
            try
            {
                init_apartment(apartment_type::multi_threaded);
                apartmentInitialized = true;
                SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                if (!GraphicsCaptureSession::IsSupported()) throw hresult_not_implemented();
                WNDCLASSW type{}; type.lpfnWndProc = DefWindowProcW; type.hInstance = GetModuleHandleW(nullptr);
                type.lpszClassName = L"ICeClass.Glass.CaptureHost";
                if (!RegisterClassW(&type) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) throw_last_error();
                host = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, type.lpszClassName, L"", WS_POPUP,
                    0, 0, 1, 1, nullptr, nullptr, type.hInstance, nullptr);
                check_bool(host);
                com_ptr<ID3D11Device> device; com_ptr<ID3D11DeviceContext> context;
                check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, context.put()));
                auto dxgi = device.as<IDXGIDevice>(); com_ptr<::IInspectable> inspectable;
                check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), inspectable.put()));
                auto direct3d = inspectable.as<IDirect3DDevice>();
                auto interop = get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
                std::array<com_ptr<ID3D11Texture2D>, 2> staging;
                std::array<bool, 2> pending{};
                std::array<unsigned long long, 2> sequence{}; unsigned long long copied{}, published{};
                Request active{}; RECT sourceBounds{}; unsigned next{};
                auto nextTick = Clock::now();
                while (true)
                {
                    Request wanted{};
                    { std::unique_lock lock(gate); if (wake.wait_until(lock, nextTick, [this] { return stopping; })) break; wanted = request; }
                    nextTick = Clock::now() + std::chrono::milliseconds(40);
                    MSG message{};
                    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
                    const auto begin = Clock::now();
                    const int w = wanted.screen.right - wanted.screen.left, h = wanted.screen.bottom - wanted.screen.top;
                    if (!wanted.source || w <= 0 || h <= 0) continue;
                    // Bound both GPU buffers and CPU copies. Oversized surfaces
                    // use the existing translucent material without this sampler.
                    if (static_cast<long long>(w) * h > 1500000) { std::lock_guard lock(gate); status = -2; break; }
                    RECT source{}; check_bool(GetWindowRect(wanted.source, &source));
                    const auto rawSource = source;
                    const bool resized = w != active.screen.right - active.screen.left || h != active.screen.bottom - active.screen.top;
                    const bool replaced = wanted.source != active.source;
                    if (wanted.generation != active.generation || !Same(rawSource, sourceBounds))
                    {
                        closeSession(); pending = {}; published = copied;
                        if (replaced)
                        {
                            closeSession(); if (thumbnail) { DwmUnregisterThumbnail(thumbnail); thumbnail = nullptr; }
                            check_hresult(DwmRegisterThumbnail(host, wanted.source, &thumbnail));
                        }
                        if (resized || replaced)
                        {
                            staging = {}; next = 0;
                            const int offscreen = GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN) + 32;
                            check_bool(SetWindowPos(host, nullptr, offscreen, GetSystemMetrics(SM_YVIRTUALSCREEN), w, h,
                                SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_SHOWWINDOW));
                            D3D11_TEXTURE2D_DESC desc{}; desc.Width = w; desc.Height = h; desc.MipLevels = desc.ArraySize = 1;
                            desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_STAGING; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
                            for (auto& target : staging) check_hresult(device->CreateTexture2D(&desc, nullptr, target.put()));
                        }
                        SIZE size{}; check_hresult(DwmQueryThumbnailSourceSize(thumbnail, &size));
                        RECT extended{};
                        if (SUCCEEDED(DwmGetWindowAttribute(wanted.source, DWMWA_EXTENDED_FRAME_BOUNDS, &extended, sizeof(extended)))
                            && extended.right - extended.left == size.cx && extended.bottom - extended.top == size.cy) source = extended;
                        const double sx = static_cast<double>(size.cx) / (source.right - source.left);
                        const double sy = static_cast<double>(size.cy) / (source.bottom - source.top);
                        DWM_THUMBNAIL_PROPERTIES thumb{};
                        thumb.dwFlags = DWM_TNP_RECTDESTINATION | DWM_TNP_RECTSOURCE | DWM_TNP_OPACITY | DWM_TNP_VISIBLE | DWM_TNP_SOURCECLIENTAREAONLY;
                        thumb.rcDestination = {0, 0, w, h};
                        thumb.rcSource = {static_cast<LONG>((wanted.screen.left - source.left) * sx), static_cast<LONG>((wanted.screen.top - source.top) * sy),
                            static_cast<LONG>((wanted.screen.right - source.left) * sx), static_cast<LONG>((wanted.screen.bottom - source.top) * sy)};
                        thumb.opacity = 255; thumb.fVisible = TRUE; thumb.fSourceClientAreaOnly = FALSE;
                        check_hresult(DwmUpdateThumbnailProperties(thumbnail, &thumb));
                        if (!session)
                        {
                            GraphicsCaptureItem item{nullptr}; check_hresult(interop->CreateForWindow(host, guid_of<GraphicsCaptureItem>(), put_abi(item)));
                            pool = Direct3D11CaptureFramePool::CreateFreeThreaded(direct3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, item.Size());
                            session = pool.CreateCaptureSession(item); session.IsCursorCaptureEnabled(false); session.StartCapture();
                            std::lock_guard lock(gate); width = w; height = h; pixels.clear(); status = 0;
                        }
                        active = wanted; sourceBounds = rawSource;
                    }
                    // Read the previous GPU copy without ever waiting for GPU
                    // completion on the UI thread (or in this sampling worker).
                    for (unsigned i = 0; i < staging.size(); ++i) if (pending[i])
                    {
                        D3D11_MAPPED_SUBRESOURCE data{};
                        const auto result = context->Map(staging[i].get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &data);
                        if (result == DXGI_ERROR_WAS_STILL_DRAWING) continue;
                        check_hresult(result);
                        {
                            std::lock_guard lock(gate);
                            if (request.generation == active.generation && sequence[i] > published)
                            {
                                bool changed = pixels.size() != static_cast<size_t>(w) * h * 4;
                                for (int row = 0; !changed && row < h; ++row)
                                    changed = std::memcmp(pixels.data() + static_cast<size_t>(row) * w * 4,
                                        static_cast<unsigned char*>(data.pData) + static_cast<size_t>(row) * data.RowPitch, static_cast<size_t>(w) * 4) != 0;
                                if (changed)
                                {
                                    pixels.resize(static_cast<size_t>(w) * h * 4);
                                    for (int row = 0; row < h; ++row) std::memcpy(pixels.data() + static_cast<size_t>(row) * w * 4,
                                        static_cast<unsigned char*>(data.pData) + static_cast<size_t>(row) * data.RowPitch, static_cast<size_t>(w) * 4);
                                    ++version;
                                }
                                published = sequence[i]; ++frames; status = 1;
                            }
                        }
                        context->Unmap(staging[i].get(), 0); pending[i] = false;
                    }
                    if (!pending[next])
                    {
                        Direct3D11CaptureFrame frame{nullptr};
                        for (int i = 0; i < 3; ++i)
                        {
                            auto newer = pool.TryGetNextFrame(); if (!newer) break;
                            if (frame) frame.Close(); frame = std::move(newer);
                        }
                        if (frame)
                        {
                            auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
                            com_ptr<ID3D11Texture2D> texture; check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D), texture.put_void()));
                            D3D11_TEXTURE2D_DESC desc{}; texture->GetDesc(&desc);
                            if (desc.Width == static_cast<unsigned>(w) && desc.Height == static_cast<unsigned>(h))
                            { context->CopyResource(staging[next].get(), texture.get()); context->Flush(); pending[next] = true; sequence[next] = ++copied; next ^= 1; }
                            frame.Close();
                        }
                    }
                    const double milliseconds = std::chrono::duration<double, std::milli>(Clock::now() - begin).count();
                    { std::lock_guard lock(gate); captureMilliseconds = milliseconds; }
                }
                closeSession(); if (thumbnail) { DwmUnregisterThumbnail(thumbnail); thumbnail = nullptr; }
                DestroyWindow(host); host = nullptr;
            }
            catch (...)
            {
                try { closeSession(); } catch (...) { }
                if (thumbnail) DwmUnregisterThumbnail(thumbnail);
                if (host) DestroyWindow(host);
                std::lock_guard lock(gate); status = -1;
            }
            if (apartmentInitialized) uninit_apartment();
        }
    };
}

extern "C" __declspec(dllexport) void* IceGlassCreate() noexcept
{ try { return new Capture(); } catch (...) { return nullptr; } }
extern "C" __declspec(dllexport) void IceGlassClose(void* handle) noexcept { delete static_cast<Capture*>(handle); }
extern "C" __declspec(dllexport) void IceGlassUpdate(void* handle, HWND source, int x, int y, int width, int height) noexcept
{
    if (!handle) return;
    auto capture = static_cast<Capture*>(handle); std::lock_guard lock(capture->gate);
    RECT screen{x, y, x + width, y + height};
    if (capture->request.source == source && Same(capture->request.screen, screen)) return;
    capture->request = {source, screen, capture->request.generation + 1};
    capture->pixels.clear(); capture->status = 0;
}
extern "C" __declspec(dllexport) int IceGlassRead(void* handle, void* destination, int stride, int width, int height,
    unsigned long long previous, unsigned long long* version, double* milliseconds) noexcept
{
    if (!handle || !destination || !version || !milliseconds || width <= 0 || height <= 0 || stride < width * 4) return -1;
    auto capture = static_cast<Capture*>(handle); std::lock_guard lock(capture->gate);
    *version = capture->version; *milliseconds = capture->captureMilliseconds;
    if (capture->status < 0) return capture->status;
    if (capture->version == previous || capture->pixels.empty() || capture->width != width || capture->height != height) return 0;
    for (int row = 0; row < height; ++row) std::memcpy(static_cast<unsigned char*>(destination) + static_cast<size_t>(row) * stride,
        capture->pixels.data() + static_cast<size_t>(row) * width * 4, static_cast<size_t>(width) * 4);
    return 1;
}
