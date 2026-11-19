#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <new>

namespace {
#ifdef TCLOUD_SHELL_PROBE
const CLSID ProbeClass = {0xb5d30db5, 0x7fb2, 0x438c, {0x80, 0xe2, 0x00, 0xf5, 0xd0, 0x27, 0x89, 0x1c}};
#else
const CLSID ProbeClass = {0x14bd3096, 0xe835, 0x4a10, {0xa5, 0xca, 0xea, 0x11, 0x82, 0xb6, 0x36, 0x14}};
#endif
const CLSID FileSystemClass = {0xf3364ba0, 0x65b9, 0x11ce, {0xa9, 0xba, 0x00, 0xaa, 0x00, 0x4a, 0xe8, 0x37}};
LONG objects = 0;
LONG locks = 0;

class ProtectedMenu final : public IContextMenu3, public IObjectWithSite {
    LONG references = 1;
    IContextMenu* inner;
public:
    explicit ProtectedMenu(IContextMenu* value) : inner(value) { InterlockedIncrement(&objects); }
    ~ProtectedMenu() { inner->Release(); InterlockedDecrement(&objects); }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** value) override {
        if (!value) return E_POINTER;
        *value = nullptr;
        if (id == IID_IUnknown || id == IID_IContextMenu || id == IID_IContextMenu2 || id == IID_IContextMenu3)
            *value = static_cast<IContextMenu3*>(this);
        else if (id == IID_IObjectWithSite) *value = static_cast<IObjectWithSite*>(this);
        if (!*value) return E_NOINTERFACE;
        AddRef();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references); }
    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG remaining = InterlockedDecrement(&references);
        if (!remaining) delete this;
        return remaining;
    }
    HRESULT STDMETHODCALLTYPE SetSite(IUnknown* site) override { return IUnknown_SetSite(inner, site); }
    HRESULT STDMETHODCALLTYPE GetSite(REFIID id, void** value) override { return IUnknown_GetSite(inner, id, value); }
    HRESULT STDMETHODCALLTYPE QueryContextMenu(HMENU menu, UINT index, UINT first, UINT last, UINT flags) override {
        const HRESULT status = inner->QueryContextMenu(menu, index, first, last, flags);
        if (FAILED(status)) return status;
        for (int position = GetMenuItemCount(menu) - 1; position >= 0; --position) {
            const UINT command = GetMenuItemID(menu, position);
            if (command == static_cast<UINT>(-1) || command < first) continue;
            wchar_t verb[256] = {};
            if (SUCCEEDED(inner->GetCommandString(command - first, GCS_VERBW, nullptr,
                reinterpret_cast<LPSTR>(verb), ARRAYSIZE(verb))) && lstrcmpiW(verb, L"delete") == 0)
                DeleteMenu(menu, position, MF_BYPOSITION);
        }
        return status;
    }
    HRESULT STDMETHODCALLTYPE InvokeCommand(CMINVOKECOMMANDINFO* command) override {
        if (!command) return E_POINTER;
        char verb[256] = {};
        if (IS_INTRESOURCE(command->lpVerb)) {
            if (SUCCEEDED(inner->GetCommandString(LOWORD(command->lpVerb), GCS_VERBA, nullptr, verb, ARRAYSIZE(verb)))
                && lstrcmpiA(verb, "delete") == 0) return HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED);
        } else if (lstrcmpiA(command->lpVerb, "delete") == 0) return HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED);
        return inner->InvokeCommand(command);
    }
    HRESULT STDMETHODCALLTYPE GetCommandString(UINT_PTR command, UINT type, UINT* reserved, LPSTR value, UINT length) override {
        return inner->GetCommandString(command, type, reserved, value, length);
    }
    HRESULT STDMETHODCALLTYPE HandleMenuMsg(UINT message, WPARAM first, LPARAM second) override {
        IContextMenu2* handler = nullptr;
        const HRESULT status = inner->QueryInterface(IID_PPV_ARGS(&handler));
        if (FAILED(status)) return status;
        const HRESULT result = handler->HandleMenuMsg(message, first, second);
        handler->Release();
        return result;
    }
    HRESULT STDMETHODCALLTYPE HandleMenuMsg2(UINT message, WPARAM first, LPARAM second, LRESULT* result) override {
        IContextMenu3* handler = nullptr;
        const HRESULT status = inner->QueryInterface(IID_PPV_ARGS(&handler));
        if (FAILED(status)) return status;
        const HRESULT response = handler->HandleMenuMsg2(message, first, second, result);
        handler->Release();
        return response;
    }
};

class ProtectedFolder final : public IShellFolder2, public IPersistFolder2, public IObjectWithSite {
    LONG references = 1;
    IShellFolder2* inner = nullptr;
    IUnknown* site = nullptr;
public:
    ProtectedFolder() { InterlockedIncrement(&objects); }
    ~ProtectedFolder() { if (inner) inner->Release(); if (site) site->Release(); InterlockedDecrement(&objects); }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** value) override {
        if (!value) return E_POINTER;
        *value = nullptr;
        if (id == IID_IUnknown || id == IID_IShellFolder || id == IID_IShellFolder2)
            *value = static_cast<IShellFolder2*>(this);
        else if (id == IID_IPersist || id == IID_IPersistFolder || id == IID_IPersistFolder2)
            *value = static_cast<IPersistFolder2*>(this);
        else if (id == IID_IObjectWithSite) *value = static_cast<IObjectWithSite*>(this);
        if (!*value) return E_NOINTERFACE;
        AddRef();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references); }
    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG remaining = InterlockedDecrement(&references);
        if (!remaining) delete this;
        return remaining;
    }
    HRESULT STDMETHODCALLTYPE SetSite(IUnknown* value) override {
        if (value) value->AddRef();
        if (site) site->Release();
        site = value;
        if (inner) (void)IUnknown_SetSite(inner, value);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetSite(REFIID id, void** value) override {
        if (!value) return E_POINTER;
        *value = nullptr;
        return site ? site->QueryInterface(id, value) : E_FAIL;
    }
    HRESULT STDMETHODCALLTYPE GetClassID(CLSID* value) override {
        if (!value) return E_POINTER;
        *value = ProbeClass;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE Initialize(PCIDLIST_ABSOLUTE pidl) override {
        if (inner) return E_UNEXPECTED;
        HRESULT status = CoCreateInstance(FileSystemClass, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&inner));
        if (FAILED(status)) return status;
        if (site) (void)IUnknown_SetSite(inner, site);
        IPersistFolder* persistence = nullptr;
        status = inner->QueryInterface(IID_PPV_ARGS(&persistence));
        if (SUCCEEDED(status)) {
            status = persistence->Initialize(pidl);
            persistence->Release();
        }
        return status;
    }
    HRESULT STDMETHODCALLTYPE GetCurFolder(PIDLIST_ABSOLUTE* pidl) override {
        if (!inner) return E_UNEXPECTED;
        IPersistFolder2* persistence = nullptr;
        const HRESULT status = inner->QueryInterface(IID_PPV_ARGS(&persistence));
        if (FAILED(status)) return status;
        const HRESULT result = persistence->GetCurFolder(pidl);
        persistence->Release();
        return result;
    }
    HRESULT STDMETHODCALLTYPE ParseDisplayName(HWND window, IBindCtx* context, LPWSTR name, ULONG* eaten,
        PIDLIST_RELATIVE* pidl, ULONG* attributes) override {
        if (!inner) return E_UNEXPECTED;
        const HRESULT status = inner->ParseDisplayName(window, context, name, eaten, pidl, attributes);
        if (SUCCEEDED(status) && attributes) *attributes &= ~SFGAO_CANDELETE;
        return status;
    }
    HRESULT STDMETHODCALLTYPE EnumObjects(HWND window, SHCONTF flags, IEnumIDList** items) override {
        return inner ? inner->EnumObjects(window, flags, items) : E_UNEXPECTED;
    }
    HRESULT STDMETHODCALLTYPE BindToObject(PCUIDLIST_RELATIVE pidl, IBindCtx* context, REFIID id, void** value) override {
        if (!inner) return E_UNEXPECTED;
        if (!value) return E_POINTER;
        *value = nullptr;
        if (id != IID_IShellFolder && id != IID_IShellFolder2)
            return inner->BindToObject(pidl, context, id, value);
        PIDLIST_ABSOLUTE parent = nullptr;
        HRESULT status = GetCurFolder(&parent);
        if (FAILED(status)) return status;
        PIDLIST_ABSOLUTE child = ILCombine(parent, pidl);
        CoTaskMemFree(parent);
        if (!child) return E_OUTOFMEMORY;
        auto* wrapper = new (std::nothrow) ProtectedFolder();
        if (!wrapper) { CoTaskMemFree(child); return E_OUTOFMEMORY; }
        status = wrapper->Initialize(child);
        CoTaskMemFree(child);
        if (SUCCEEDED(status)) status = wrapper->QueryInterface(id, value);
        wrapper->Release();
        return status;
    }
    HRESULT STDMETHODCALLTYPE BindToStorage(PCUIDLIST_RELATIVE pidl, IBindCtx* context, REFIID id, void** value) override {
        return inner ? inner->BindToStorage(pidl, context, id, value) : E_UNEXPECTED;
    }
    HRESULT STDMETHODCALLTYPE CompareIDs(LPARAM flags, PCUIDLIST_RELATIVE first, PCUIDLIST_RELATIVE second) override {
        return inner ? inner->CompareIDs(flags, first, second) : E_UNEXPECTED;
    }
    HRESULT STDMETHODCALLTYPE CreateViewObject(HWND window, REFIID id, void** value) override {
        if (!inner) return E_UNEXPECTED;
        if (id == IID_IShellView) {
            SFV_CREATE settings = {};
            settings.cbSize = sizeof(settings);
            settings.pshf = this;
            return SHCreateShellFolderView(&settings, reinterpret_cast<IShellView**>(value));
        }
        return inner->CreateViewObject(window, id, value);
    }
    HRESULT STDMETHODCALLTYPE GetAttributesOf(UINT count, PCUITEMID_CHILD_ARRAY pidls, SFGAOF* attributes) override {
        if (!inner) return E_UNEXPECTED;
        const HRESULT status = inner->GetAttributesOf(count, pidls, attributes);
        if (SUCCEEDED(status) && attributes) *attributes &= ~SFGAO_CANDELETE;
        return status;
    }
    HRESULT STDMETHODCALLTYPE GetUIObjectOf(HWND window, UINT count, PCUITEMID_CHILD_ARRAY pidls,
        REFIID id, UINT* reserved, void** value) override {
        if (!inner) return E_UNEXPECTED;
        if (id != IID_IContextMenu && id != IID_IContextMenu2 && id != IID_IContextMenu3)
            return inner->GetUIObjectOf(window, count, pidls, id, reserved, value);
        IContextMenu* menu = nullptr;
        const HRESULT status = inner->GetUIObjectOf(window, count, pidls, IID_IContextMenu, reserved, reinterpret_cast<void**>(&menu));
        if (FAILED(status)) return status;
        auto* wrapper = new (std::nothrow) ProtectedMenu(menu);
        if (!wrapper) { menu->Release(); return E_OUTOFMEMORY; }
        const HRESULT wrapped = wrapper->QueryInterface(id, value);
        wrapper->Release();
        return wrapped;
    }
    HRESULT STDMETHODCALLTYPE GetDisplayNameOf(PCUITEMID_CHILD pidl, SHGDNF flags, STRRET* value) override {
        return inner ? inner->GetDisplayNameOf(pidl, flags, value) : E_UNEXPECTED;
    }
    HRESULT STDMETHODCALLTYPE SetNameOf(HWND window, PCUITEMID_CHILD pidl, LPCWSTR name, SHGDNF flags, PITEMID_CHILD* value) override {
        return inner ? inner->SetNameOf(window, pidl, name, flags, value) : E_UNEXPECTED;
    }
    HRESULT STDMETHODCALLTYPE GetDefaultSearchGUID(GUID* value) override { return inner ? inner->GetDefaultSearchGUID(value) : E_UNEXPECTED; }
    HRESULT STDMETHODCALLTYPE EnumSearches(IEnumExtraSearch** value) override { return inner ? inner->EnumSearches(value) : E_UNEXPECTED; }
    HRESULT STDMETHODCALLTYPE GetDefaultColumn(DWORD reserved, ULONG* sort, ULONG* display) override {
        return inner ? inner->GetDefaultColumn(reserved, sort, display) : E_UNEXPECTED;
    }
    HRESULT STDMETHODCALLTYPE GetDefaultColumnState(UINT column, SHCOLSTATEF* state) override {
        return inner ? inner->GetDefaultColumnState(column, state) : E_UNEXPECTED;
    }
    HRESULT STDMETHODCALLTYPE GetDetailsEx(PCUITEMID_CHILD pidl, const SHCOLUMNID* column, VARIANT* value) override {
        return inner ? inner->GetDetailsEx(pidl, column, value) : E_UNEXPECTED;
    }
    HRESULT STDMETHODCALLTYPE GetDetailsOf(PCUITEMID_CHILD pidl, UINT column, SHELLDETAILS* value) override {
        return inner ? inner->GetDetailsOf(pidl, column, value) : E_UNEXPECTED;
    }
    HRESULT STDMETHODCALLTYPE MapColumnToSCID(UINT column, SHCOLUMNID* value) override {
        return inner ? inner->MapColumnToSCID(column, value) : E_UNEXPECTED;
    }
};

class Factory final : public IClassFactory {
    LONG references = 1;
public:
    Factory() { InterlockedIncrement(&objects); }
    ~Factory() { InterlockedDecrement(&objects); }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** value) override {
        if (!value) return E_POINTER;
        *value = nullptr;
        if (id != IID_IUnknown && id != IID_IClassFactory) return E_NOINTERFACE;
        *value = static_cast<IClassFactory*>(this);
        AddRef();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references); }
    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG remaining = InterlockedDecrement(&references);
        if (!remaining) delete this;
        return remaining;
    }
    HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown* outer, REFIID id, void** value) override {
        if (outer) return CLASS_E_NOAGGREGATION;
        auto* folder = new (std::nothrow) ProtectedFolder();
        if (!folder) return E_OUTOFMEMORY;
        const HRESULT status = folder->QueryInterface(id, value);
        folder->Release();
        return status;
    }
    HRESULT STDMETHODCALLTYPE LockServer(BOOL lock) override {
        if (lock) InterlockedIncrement(&locks); else InterlockedDecrement(&locks);
        return S_OK;
    }
};
}

extern "C" HRESULT __stdcall DllGetClassObject(REFCLSID classId, REFIID id, void** value) {
    if (classId != ProbeClass) return CLASS_E_CLASSNOTAVAILABLE;
    auto* factory = new (std::nothrow) Factory();
    if (!factory) return E_OUTOFMEMORY;
    const HRESULT status = factory->QueryInterface(id, value);
    factory->Release();
    return status;
}
extern "C" HRESULT __stdcall DllCanUnloadNow() {
    return objects == 0 && locks == 0 ? S_OK : S_FALSE;
}
