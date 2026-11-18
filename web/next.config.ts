import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // LAN・VPNから開発画面を確認する場合だけ、接続先のホスト名を明示する。
  allowedDevOrigins: process.env.DEV_ALLOWED_ORIGINS?.split(',').map(host => host.trim()).filter(Boolean),
};

export default nextConfig;
