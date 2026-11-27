package com.velodeck.agent.network

import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URLEncoder

data class VirtualNicEndpoint(
    val ifaceName: String,
    val label: String,
    val ip: String,
)

data class DetectedEndpoints(
    val tailscaleIp: String?,
    val lanIps: List<String>,
    val port: Int,
    val vpnEndpoints: List<VirtualNicEndpoint> = emptyList(),
) {
    val preferredVpnIp: String?
        get() = tailscaleIp ?: vpnEndpoints.firstOrNull()?.ip

    val preferredIp: String?
        get() = tailscaleIp ?: vpnEndpoints.firstOrNull()?.ip ?: lanIps.firstOrNull()

    val tailscaleWsUrl: String?
        get() = tailscaleIp?.let { "ws://$it:$port/ws" }

    val lanWsUrls: List<String>
        get() = lanIps.map { "ws://$it:$port/ws" }

    val preferredDirectWsUrl: String?
        get() = preferredIp?.let { "ws://$it:$port/ws" }

    fun buildQuickConnectWebUrl(ip: String, token: String): String {
        val wsUrl = "ws://$ip:$port/ws"
        val encodedWs = URLEncoder.encode(wsUrl, "UTF-8")
        val encodedToken = URLEncoder.encode(token, "UTF-8")
        return "http://$ip:$port/#url=$encodedWs&token=$encodedToken&mode=direct"
    }
}

object NetworkUtils {

    fun detectEndpoints(port: Int): DetectedEndpoints {
        var tailscaleIp: String? = null
        val vpnEndpoints = mutableListOf<VirtualNicEndpoint>()
        val seenVpnIps = HashSet<String>()
        val lanIps = mutableListOf<String>()

        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces != null && interfaces.hasMoreElements()) {
                val iface = interfaces.nextElement()
                if (!iface.isUp || iface.isLoopback) continue
                val ifaceName = iface.name.lowercase()
                if (isCellularInterface(ifaceName)) continue

                val isVirtualVpn = isVirtualVpnInterface(ifaceName)
                val addrs = iface.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr !is Inet4Address || addr.isLoopbackAddress || addr.isLinkLocalAddress) continue
                    val ip = addr.hostAddress ?: continue

                    val isTailscale = isTailscaleCgnatIp(ip) || ifaceName.contains("tailscale")
                    if (isTailscale) {
                        if (tailscaleIp == null) tailscaleIp = ip
                        if (seenVpnIps.add(ip)) {
                            vpnEndpoints.add(
                                VirtualNicEndpoint(
                                    ifaceName = iface.name,
                                    label = labelForVpnInterface(ifaceName, ip),
                                    ip = ip,
                                ),
                            )
                        }
                    } else if (isVirtualVpn) {
                        if (seenVpnIps.add(ip)) {
                            vpnEndpoints.add(
                                VirtualNicEndpoint(
                                    ifaceName = iface.name,
                                    label = labelForVpnInterface(ifaceName, ip),
                                    ip = ip,
                                ),
                            )
                        }
                    } else if (isPrivateLanIp(ip)) {
                        lanIps.add(ip)
                    }
                }
            }
        } catch (_: Throwable) {
        }

        // Prioritize Wi-Fi style 192.168 / 10.x / 172.x without duplicates
        val uniqueLan = lanIps.distinct().sortedBy { ip ->
            when {
                ip.startsWith("192.168.") -> 0
                ip.startsWith("10.") -> 1
                else -> 2
            }
        }
        return DetectedEndpoints(
            tailscaleIp = tailscaleIp,
            lanIps = uniqueLan,
            port = port,
            vpnEndpoints = vpnEndpoints,
        )
    }

    /**
     * Checks whether an interface name belongs to common virtual overlay/VPN NICs:
     * Tailscale, 蒲公英 (pgy/oray), EasyTier (easytier), ZeroTier (zt), and Android VpnService (tun).
     */
    fun isVirtualVpnInterface(ifaceName: String): Boolean {
        val lower = ifaceName.lowercase()
        return lower.startsWith("tun") ||
            lower.startsWith("pgy") ||
            lower.startsWith("oray") ||
            lower.startsWith("zt") ||
            lower.startsWith("easytier") ||
            lower.contains("tailscale")
    }

    fun labelForVpnInterface(ifaceName: String, ip: String): String {
        val lower = ifaceName.lowercase()
        return when {
            lower.contains("tailscale") -> "Tailscale"
            lower.startsWith("pgy") || lower.startsWith("oray") -> "蒲公英 ($ifaceName)"
            lower.startsWith("easytier") -> "EasyTier ($ifaceName)"
            lower.startsWith("zt") -> "ZeroTier ($ifaceName)"
            isTailscaleCgnatIp(ip) -> "Tailscale / 虚拟组网 ($ifaceName)"
            lower.startsWith("tun") -> "虚拟组网 ($ifaceName)"
            else -> ifaceName
        }
    }

    fun isCellularInterface(ifaceName: String): Boolean {
        val lower = ifaceName.lowercase()
        return lower.startsWith("rmnet") || lower.startsWith("ccmni")
    }

    /**
     * Checks whether IPv4 falls inside Tailscale's CGNAT range 100.64.0.0/10 (100.64.x.x - 100.127.x.x).
     */
    fun isTailscaleCgnatIp(ip: String): Boolean {
        val parts = ip.split(".")
        if (parts.size != 4) return false
        val first = parts[0].toIntOrNull() ?: return false
        val second = parts[1].toIntOrNull() ?: return false
        return first == 100 && second in 64..127
    }

    fun isPrivateLanIp(ip: String): Boolean {
        val parts = ip.split(".")
        if (parts.size != 4) return false
        val a = parts[0].toIntOrNull() ?: return false
        val b = parts[1].toIntOrNull() ?: return false
        return a == 10 ||
            (a == 192 && b == 168) ||
            (a == 172 && b in 16..31)
    }

    /** Escapes HTML special characters to prevent XSS in dynamically interpolated markup. */
    fun escapeHtml(raw: String): String = buildString(raw.length + 16) {
        for (ch in raw) {
            when (ch) {
                '&' -> append("&amp;")
                '<' -> append("&lt;")
                '>' -> append("&gt;")
                '"' -> append("&quot;")
                '\'' -> append("&#39;")
                else -> append(ch)
            }
        }
    }
}
