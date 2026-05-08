# Deploying to IDCloudHost

The [Hetzner guide](./getting-started.md) applies in full. This page only
records provider-specific differences worth noting.

- **Compute**: IDCloudHost VM. Pick a plan with at least 2 vCPU / 4 GB RAM
  and Ubuntu 22.04 LTS as the OS image.
- **Region**: pick the Indonesian datacenter closest to your customer base
  (Jakarta or Surabaya).
- **Firewall**: configured in the IDCloudHost panel. Open 22/tcp, 80/tcp,
  443/tcp, and 443/udp. The in-VM `ufw` rules from the Hetzner guide can
  be layered on top.
- **Object storage** (for off-site backups): IDCloudHost offers
  S3-compatible storage. Configure rclone with the `s3` remote type and the
  endpoint listed in your IDCloudHost dashboard. See
  [`backup-restore.md`](./backup-restore.md).

> **TODO**: verify the firewall UI naming and the exact rclone endpoint for
> IDCloudHost object storage, then update this page.

Everything else (DNS records, Docker install, `docker compose up -d --build`,
seeding, owner provisioning) is identical to the Hetzner guide.
