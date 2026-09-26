import { networkInterfaces } from "node:os";

export interface LanInterface {
    /** OS interface name, e.g. "Wi-Fi", "Tailscale", "vEthernet (Docker)" */
    name: string;
    address: string;
}

/**
 * Returns outward-facing IPv4 interfaces (LAN, VPN, Tailscale, …),
 * excluding internal/loopback interfaces. Used to render copyable co-op
 * invites. Empty when offline or when only loopback exists.
 */
export function getLanAddresses(): LanInterface[] {
    const result: LanInterface[] = [];
    for (const [name, interfaces] of Object.entries(networkInterfaces())) {
        for (const iface of interfaces ?? []) {
            if (iface.family !== "IPv4" || iface.internal) {
                continue;
            }
            if (!result.some(entry => entry.address === iface.address)) {
                result.push({ name, address: iface.address });
            }
        }
    }
    return result;
}
