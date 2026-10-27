// Copies the AWS Architecture Icons Mizar uses into public/icons/aws/<node-type>.svg.
// Usage: node scripts/import-aws-icons.mjs ~/Downloads/aws-architecture-icons
//
// Glyphs are stripped of their category-coloured background and recoloured white, so the
// 3D view can tint them per type and status. Use of the icons is subject to AWS's terms.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCES = {
  ec2: "Arch_Amazon-EC2_64.svg",
  "ecs-service": "Arch_Amazon-Elastic-Container-Service_64.svg",
  "eks-cluster": "Arch_Amazon-Elastic-Kubernetes-Service_64.svg",
  lambda: "Arch_AWS-Lambda_64.svg",
  elb: "Arch_Elastic-Load-Balancing_64.svg",
  workspaces: "Arch_Amazon-WorkSpaces_64.svg",
  rds: "Arch_Amazon-RDS_64.svg",
  elasticache: "Arch_Amazon-ElastiCache_64.svg",
  dynamodb: "Arch_Amazon-DynamoDB_64.svg",
  s3: "Arch_Amazon-Simple-Storage-Service_64.svg",
  sqs: "Arch_Amazon-Simple-Queue-Service_64.svg",
  "api-gateway": "Arch_Amazon-API-Gateway_64.svg",
  cloudfront: "Arch_Amazon-CloudFront_64.svg",
  tgw: "Arch_AWS-Transit-Gateway_64.svg",
  "network-firewall": "Arch_AWS-Network-Firewall_64.svg",
  igw: "Res_Amazon-VPC_Internet-Gateway_48.svg",
  "nat-gateway": "Res_Amazon-VPC_NAT-Gateway_48.svg",
  "vpn-gateway": "Res_Amazon-VPC_VPN-Gateway_48.svg",
  "vpn-connection": "Res_Amazon-VPC_VPN-Connection_48.svg",
};

/** Rasterised by the browser at this size before upload as a texture. */
const SIZE = 256;

const root = process.argv[2];
if (!root) {
  console.error("usage: node scripts/import-aws-icons.mjs <aws-architecture-icons dir>");
  process.exit(1);
}

const files = new Map();
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else files.set(entry.name, path);
  }
})(root);

const out = join(dirname(fileURLToPath(import.meta.url)), "../public/icons/aws");
mkdirSync(out, { recursive: true });

for (const [type, name] of Object.entries(SOURCES)) {
  const source = files.get(name);
  if (!source) throw new Error(`${name} not found under ${root}`);
  const svg = readFileSync(source, "utf8")
    .replace(/<\?xml[^>]*>\s*/, "")
    .replace(/<title>[\s\S]*?<\/title>\s*/, "")
    .replace(/<g id="Icon-Architecture-BG[^"]*"[^>]*>[\s\S]*?<\/g>\s*/, "")
    .replace(/fill="#(?!FFFFFF)[0-9A-Fa-f]{6}"/g, 'fill="#FFFFFF"')
    .replace(/width="\d+px" height="\d+px"/, `width="${SIZE}" height="${SIZE}"`)
    // Resource glyphs fill their frame; pad them to the service icons' proportions.
    .replace('viewBox="0 0 48 48"', 'viewBox="-7 -7 62 62"');
  writeFileSync(join(out, `${type}.svg`), svg);
}
console.log(`wrote ${Object.keys(SOURCES).length} icons to ${out}`);
