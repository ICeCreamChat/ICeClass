using System.Security.Cryptography;
using System.Text;

namespace ICeClass.VideoBooth.Transport;

/// <summary>Held for the entire process lifetime, before either mode reads or writes data.</summary>
public sealed class DataDirectoryLease : IDisposable
{
    private readonly Mutex mutex;
    private DataDirectoryLease(Mutex mutex) => this.mutex = mutex;

    public static DataDirectoryLease Acquire(string directory)
    {
        var normalized = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory));
        if (OperatingSystem.IsWindows()) normalized = normalized.ToUpperInvariant();
        var name = "ICeClass.VideoBooth.Data." + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)));
        if (OperatingSystem.IsWindows()) name = "Local\\" + name;
        // createdNew also rejects a second acquisition on the same thread (Mutex is otherwise recursive).
        var mutex = new Mutex(false, name, out var createdNew);
        if (!createdNew) { mutex.Dispose(); throw new IOException("此资料目录已有展台运行，请先手动关闭原展台。"); }
        return new DataDirectoryLease(mutex);
    }
    public void Dispose() => mutex.Dispose();
}
