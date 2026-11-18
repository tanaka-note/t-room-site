#include <windows.h>
#include <shlobj.h>
#include <commctrl.h>

// Test-only Shell host: a bad extension must not terminate the user's Explorer.
namespace {
IExplorerBrowser* browser = nullptr;
LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM first, LPARAM second) {
    switch (message) {
    case WM_SIZE:
        if (browser) {
            RECT bounds = {};
            GetClientRect(window, &bounds);
            browser->SetRect(nullptr, bounds);
        }
        return 0;
    case WM_DESTROY:
        if (browser) { browser->Destroy(); browser->Release(); browser = nullptr; }
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(window, message, first, second);
}
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
    int count = 0;
    LPWSTR* args = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!args || count != 2) { if (args) LocalFree(args); return 2; }
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized)) { LocalFree(args); return 3; }
    INITCOMMONCONTROLSEX controls = {sizeof(controls), ICC_LISTVIEW_CLASSES};
    InitCommonControlsEx(&controls);
    WNDCLASSW type = {};
    type.lpfnWndProc = WindowProc;
    type.hInstance = instance;
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    type.lpszClassName = L"TCloudSyntheticShellHost";
    RegisterClassW(&type);
    HWND window = CreateWindowW(type.lpszClassName, L"T-Cloud synthetic Shell test", WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, 900, 600, nullptr, nullptr, instance, nullptr);
    HRESULT status = window ? CoCreateInstance(CLSID_ExplorerBrowser, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(&browser)) : E_FAIL;
    RECT bounds = {};
    if (window) GetClientRect(window, &bounds);
    FOLDERSETTINGS settings = {FVM_DETAILS, FWF_AUTOARRANGE};
    if (SUCCEEDED(status)) status = browser->Initialize(window, &bounds, &settings);
    if (SUCCEEDED(status)) status = browser->SetPropertyBag(L"TCloud-Synthetic-Shell-Test");
    if (SUCCEEDED(status)) status = browser->SetOptions(EBO_NOTRAVELLOG | EBO_NOBORDER);
    PIDLIST_ABSOLUTE pidl = nullptr;
    if (SUCCEEDED(status)) status = SHParseDisplayName(args[1], nullptr, &pidl, 0, nullptr);
    if (SUCCEEDED(status)) status = browser->BrowseToIDList(pidl, SBSP_ABSOLUTE);
    CoTaskMemFree(pidl);
    LocalFree(args);
    if (FAILED(status)) {
        if (window) DestroyWindow(window);
        CoUninitialize();
        return 4;
    }
    ShowWindow(window, SW_SHOWNORMAL);
    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        IInputObject* input = nullptr;
        if (browser && SUCCEEDED(browser->QueryInterface(IID_PPV_ARGS(&input)))) {
            const HRESULT translated = input->TranslateAcceleratorIO(&message);
            input->Release();
            if (translated == S_OK) continue;
        }
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    CoUninitialize();
    return 0;
}
