# Deploying to Biznet Gio

The [Hetzner guide](./getting-started.md) applies in full. This page only
records provider-specific differences worth noting.

- **Compute**: Biznet Gio Neo Lite or Neo Cloud instances. Pick a size with
  at least 2 vCPU / 4 GB RAM. Ubuntu 22.04 LTS is offered as a stock image.
- **Region**: Jakarta (`jakarta-1` etc.) for the lowest RTT to Indonesian
  customers.
- **Firewall**: configured in the Biznet Gio panel rather than via `ufw` if
  you prefer. Open 22/tcp, 80/tcp, 443/tcp, and 443/udp. The in-VM `ufw`
  rules from the Hetzner guide work too — defense in depth is fine.
- **Object storage** (for off-site backups): Biznet Gio S3-compatible
  storage works with rclone using the `s3` remote type. See
  [`backup-restore.md`](./backup-restore.md).

> **TODO**: verify the firewall UI naming and the exact rclone endpoint for
> Biznet Gio object storage, then update this page.

Everything else (DNS records, Docker install, `docker compose up -d --build`,
seeding, owner provisioning) is identical to the Hetzner guide.
