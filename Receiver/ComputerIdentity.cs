using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace ICeClass.Receiver;

/// <summary>Computer details for ICe to verify and correct a classroom binding.</summary>
public static class ComputerIdentity
{
    public static string DeviceCode(string id)
    {
        var compact = id.Replace("-", "").ToUpperInvariant();
        return compact.Length >= 12 ? $"BB-{compact[..8]}-{compact[^4..]}" : id;
    }

    public static object Snapshot() => new
    {
        computerName = Environment.MachineName,
        osVersion = RuntimeInformation.OSDescription,
        localAddresses = LocalAddresses(),
    };

    public static string[] LocalAddresses()
    {
        try
        {
            return NetworkInterface.GetAllNetworkInterfaces()
                .Where(adapter => adapter.OperationalStatus == OperationalStatus.Up && adapter.NetworkInterfaceType != NetworkInterfaceType.Loopback)
                .SelectMany(adapter => adapter.GetIPProperties().UnicastAddresses)
                .Where(address => address.Address.AddressFamily == AddressFamily.InterNetwork)
                .Select(address => address.Address.ToString()).Distinct().Take(8).ToArray();
        }
        catch { return []; }
    }
}
