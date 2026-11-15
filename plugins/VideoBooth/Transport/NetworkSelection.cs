using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace ICeClass.VideoBooth.Transport;

public sealed record NetworkChoice(string Address, string Name, string Kind = "ethernet", bool HasGateway = false);
public sealed record SharingAdapter(Guid Id, bool Physical, bool Connected, bool HasIpv4Address, bool HasIpv4Gateway, NetworkInterfaceType Type);

public static class NetworkSelection
{
    public static Guid? SelectSharingUpstream(IEnumerable<SharingAdapter> adapters, Guid? current)
    {
        var physical = adapters.Where(adapter => adapter.Physical
            && adapter.Type is NetworkInterfaceType.Ethernet or NetworkInterfaceType.Wireless80211).ToArray();
        var usable = physical.Where(adapter => adapter.Connected && adapter.HasIpv4Address && adapter.HasIpv4Gateway).ToArray();
        // Retain a working pair. If its cable is unplugged, use an available Wi-Fi
        // connection instead. Without an upstream, retain local-only sharing.
        var candidates = usable.Length > 0 ? usable : physical;
        return candidates.FirstOrDefault(adapter => adapter.Id == current)?.Id
            ?? candidates.OrderByDescending(adapter => adapter.Connected && adapter.HasIpv4Address)
                .ThenByDescending(adapter => adapter.Type == NetworkInterfaceType.Ethernet).FirstOrDefault()?.Id;
    }

    public static NetworkChoice Describe(string address, string name, string description, NetworkInterfaceType type, bool hasGateway)
    {
        var adapter = name + " " + description;
        bool Contains(params string[] values) => values.Any(value => adapter.Contains(value, StringComparison.OrdinalIgnoreCase));
        var kind = address.StartsWith("169.254.") ? "link-local"
            : Contains("Wi-Fi Direct", "WiFi Direct", "Hosted Network") ? "hotspot"
            : type is NetworkInterfaceType.Tunnel or NetworkInterfaceType.Ppp || Contains("Tunnel", "Mihomo", "Wintun", "WireGuard", "Tailscale", "ZeroTier", "OpenVPN", "TAP-Windows", "VPN") ? "tunnel"
            : Contains("VMnet", "WSL", "Docker", "Host-Only", "Default Switch") ? "virtual"
            : Contains("vEthernet", "Hyper-V", "VMware", "VirtualBox", "Virtual Ethernet") ? hasGateway ? "bridge" : "virtual"
            : type == NetworkInterfaceType.Wireless80211 ? "wifi"
            : type == NetworkInterfaceType.Ethernet ? "ethernet" : "other";
        return new(address, name, kind, hasGateway);
    }

    public static int Priority(NetworkChoice network) => network.Kind switch
    {
        "hotspot" => 0,
        "wifi" => 10,
        "ethernet" => 20,
        "bridge" => 25,
        "other" => 50,
        "virtual" => 80,
        "tunnel" => 90,
        _ => 100
    };

    public static NetworkChoice[] Read()
    {
        var choices = new List<NetworkChoice>();
        foreach (var adapter in NetworkInterface.GetAllNetworkInterfaces().Where(adapter => adapter.OperationalStatus == OperationalStatus.Up && adapter.NetworkInterfaceType != NetworkInterfaceType.Loopback))
        {
            var properties = adapter.GetIPProperties();
            var hasGateway = properties.GatewayAddresses.Any(gateway => gateway.Address.AddressFamily == AddressFamily.InterNetwork && !gateway.Address.Equals(IPAddress.Any));
            foreach (var address in properties.UnicastAddresses.Where(address => address.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(address.Address)))
                choices.Add(Describe(address.Address.ToString(), adapter.Name, adapter.Description, adapter.NetworkInterfaceType, hasGateway));
        }
        return choices.OrderBy(Priority).ThenByDescending(choice => choice.HasGateway).DistinctBy(choice => choice.Address).ToArray();
    }

    public static string RestoreAddress(NetworkChoice[] networks, string? savedAddress, bool? explicitlySelected)
    {
        var preferred = networks.FirstOrDefault();
        var saved = networks.FirstOrDefault(network => network.Address == savedAddress);
        if (saved is null) return preferred?.Address ?? "127.0.0.1";
        if (explicitlySelected == false) return preferred?.Address ?? saved.Address;
        // Old releases could save a VM/VPN address simply because it was first in the list.
        // Keep deliberate choices, including isolated bridges and unusual classroom networks.
        if (explicitlySelected != true && Priority(saved) >= 80 && preferred is not null && Priority(preferred) < 80)
            return preferred.Address;
        return saved.Address;
    }
}
