using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ICeClass.Receiver;

/// <summary>One observed local document, recycled by the existing STA adapter.</summary>
internal static class ClassroomAgentFiles
{
    internal static bool CanRecycle(string path)
    {
        if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal) || !File.Exists(path)) return false;
        var attributes = File.GetAttributes(path);
        return (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint | FileAttributes.ReadOnly | FileAttributes.System)) == 0
            && new DriveInfo(Path.GetPathRoot(path)!).DriveType == DriveType.Fixed;
    }

    internal static JsonObject Recycle(JsonElement args, IReadOnlyList<AgentApplication> applications, CancellationToken token)
    {
        var path = ClassroomAgentService.Text(args, "path", 32767);
        if (!CanRecycle(path)) throw new InvalidOperationException("此文件不能移入本机回收站，未删除。仅支持可回收的本地普通文档。");
        var info = new FileInfo(path);
        if (info.Length != args.GetProperty("length").GetInt64() || info.LastWriteTimeUtc.Ticks != args.GetProperty("modifiedTicks").GetInt64())
            throw new InvalidOperationException("文件在查找后已被修改，请重新查找再操作。");
        // Only an exact saved document may be closed. Unsaved work and other
        // documents in the same editor stay open.
        try { using var available = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None); }
        catch (IOException)
        {
            if (!ClassroomAgentDocuments.CloseSavedFile(path, applications, token))
                throw new InvalidOperationException("文件正在使用，无法核实并安全关闭这份文稿；尚未删除。");
            try { using var available = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None); }
            catch (IOException) { throw new InvalidOperationException("文件仍被其他程序占用，尚未删除。"); }
            info.Refresh();
            if (!info.Exists || info.Length != args.GetProperty("length").GetInt64() || info.LastWriteTimeUtc.Ticks != args.GetProperty("modifiedTicks").GetInt64())
                throw new InvalidOperationException("关闭文稿后文件状态发生变化，请重新查找；尚未删除。");
        }
        token.ThrowIfCancellationRequested();
        IFileOperation? operation = null;
        IShellItem? item = null;
        try
        {
            operation = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new("3AD05575-8857-4850-9277-11B85BDB8E09"), true)!)!;
            // RECYCLEONDELETE explicitly requests the recycle bin; no permanent
            // deletion fallback. EARLYFAILURE turns shell errors into a failure.
            const uint recycleOnDelete = 0x00080000, earlyFailure = 0x00100000, addUndoRecord = 0x20000000;
            const uint noConnectedElements = 0x2000, noErrorUi = 0x0400, noConfirmation = 0x0010, silent = 0x0004;
            const uint flags = recycleOnDelete | earlyFailure | addUndoRecord | noConnectedElements | noErrorUi | noConfirmation | silent;
            Marshal.ThrowExceptionForHR(operation.SetOperationFlags(flags));
            var iid = typeof(IShellItem).GUID;
            Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item));
            Marshal.ThrowExceptionForHR(operation.DeleteItem(item, IntPtr.Zero));
            token.ThrowIfCancellationRequested();
            Marshal.ThrowExceptionForHR(operation.PerformOperations());
            Marshal.ThrowExceptionForHR(operation.GetAnyOperationsAborted(out var aborted));
            if (aborted || File.Exists(path)) throw new InvalidOperationException("文件尚未移入回收站，请重新查看文件状态。");
            return new() { ["verified"] = true, ["recycled"] = true, ["fileName"] = Path.GetFileName(path), ["detail"] = "已将指定文件移到回收站，可从回收站恢复。" };
        }
        catch (COMException)
        {
            throw new InvalidOperationException("Windows 未能将文件移到回收站，请检查文稿占用、文件权限和回收站状态；未尝试永久删除。");
        }
        finally
        {
            if (item is not null) Marshal.FinalReleaseComObject(item);
            if (operation is not null) Marshal.FinalReleaseComObject(operation);
        }
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr binding, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem { }

    [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOperation
    {
        [PreserveSig] int Advise(IntPtr sink, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOperationFlags(uint flags);
        [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
        [PreserveSig] int SetProgressDialog(IntPtr dialog);
        [PreserveSig] int SetProperties(IntPtr properties);
        [PreserveSig] int SetOwnerWindow(IntPtr owner);
        [PreserveSig] int ApplyPropertiesToItem(IShellItem item);
        [PreserveSig] int ApplyPropertiesToItems(IntPtr items);
        [PreserveSig] int RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        [PreserveSig] int RenameItems(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int MoveItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        [PreserveSig] int MoveItems(IntPtr items, IShellItem destination);
        [PreserveSig] int CopyItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        [PreserveSig] int CopyItems(IntPtr items, IShellItem destination);
        [PreserveSig] int DeleteItem(IShellItem item, IntPtr sink);
        [PreserveSig] int DeleteItems(IntPtr items);
        [PreserveSig] int NewItem(IShellItem destination, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, IntPtr sink);
        [PreserveSig] int PerformOperations();
        [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }
}
