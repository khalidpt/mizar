"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useMemo, type ReactNode } from "react";
import { descendants, isResource } from "@/lib/graph/query";
import type { Environment, GraphNode, NodeType } from "@/lib/graph/types";
import { accountColor, spendLabel } from "@/components/mizar/cost";
import { useSceneData } from "@/components/mizar/data";
import { useMizar } from "@/components/mizar/store";
import { STATUS_COLOR, TYPE_COLOR, TYPE_LABEL } from "@/components/mizar/theme";
import { ACCOUNT_HEADER, type Box } from "./layout2d";

export type BoxNode = Node<{ box: Box }>;

const TYPE_CODE: Partial<Record<NodeType, string>> = {
  ec2: "EC2",
  "ecs-service": "ECS",
  "eks-cluster": "EKS",
  lambda: "λ",
  elb: "ALB",
  rds: "RDS",
  elasticache: "CACHE",
  "api-gateway": "API",
  cloudfront: "CDN",
  dynamodb: "DDB",
  s3: "S3",
  sqs: "SQS",
  igw: "IGW",
  "nat-gateway": "NAT",
  tgw: "TGW",
  "vpn-gateway": "VGW",
  "vpn-connection": "VPN",
  "network-firewall": "NFW",
  workspaces: "WSP",
};

const TIER_COLOR: Record<string, string> = { public: "#4ade80", private: "#38bdf8", data: "#c084fc" };

/** Invisible anchors; edges attach left (in) and right (out). */
function Anchors() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className="!pointer-events-none !opacity-0" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="!pointer-events-none !opacity-0" />
    </>
  );
}

function useHighlight(id: string) {
  const selected = useMizar((s) => s.selectedId === id);
  const hovered = useMizar((s) => s.hoveredId === id);
  return { selected, hovered };
}

function envOf(node: GraphNode): Environment {
  return (node.tags.Environment as Environment) ?? "shared";
}

function useContainerColor(node: GraphNode): string {
  const { cost } = useSceneData();
  const colorBy = useMizar((s) => s.colorBy);
  switch (node.type) {
    case "account":
      return accountColor(node, envOf(node), colorBy, cost);
    case "subnet":
      return TIER_COLOR[String(node.meta.tier)] ?? TYPE_COLOR.subnet;
    default:
      return TYPE_COLOR[node.type];
  }
}

/** Compact spend with its period ("$1.2K mtd"), when the snapshot has costs. */
function useSpend(node: GraphNode): string | undefined {
  return spendLabel(useSceneData().cost, node);
}

export function ContainerNode({ data }: NodeProps<BoxNode>) {
  const { box } = data;
  const node = box.node!;
  const { selected, hovered } = useHighlight(node.id);
  const toggleExpanded = useMizar((s) => s.toggleExpanded);
  const select = useMizar((s) => s.select);
  const color = useContainerColor(node);
  const spend = useSpend(node);
  const structural = node.type === "organization" || node.type === "ou";

  let title: ReactNode = node.name;
  let detail: ReactNode = null;
  if (node.type === "vpc") detail = String(node.meta.cidr);
  if (node.type === "subnet") {
    title = `${node.meta.tier} · ${node.az?.slice(-1)}`;
    detail = String(node.meta.cidr);
  }
  if (node.type === "account") detail = node.accountId;
  if ((node.type === "account" || node.type === "region") && spend) detail = detail ? `${detail} · ${spend}` : spend;

  return (
    <div
      className="relative h-full w-full font-mono"
      style={{
        border: `1px ${node.type === "ou" ? "dashed" : "solid"} ${color}${selected ? "" : structural ? "40" : "70"}`,
        background: `${color}${node.type === "subnet" ? "0d" : structural ? "05" : "08"}`,
        boxShadow: selected ? `0 0 0 1px ${color}, 0 0 24px ${color}66` : hovered ? `0 0 12px ${color}44` : undefined,
      }}
    >
      <Anchors />
      <div
        className="flex items-baseline gap-2 overflow-hidden whitespace-nowrap px-2 uppercase"
        style={{ paddingTop: node.type === "subnet" ? 6 : 10, height: node.type === "account" ? ACCOUNT_HEADER : undefined }}
      >
        <span className="text-[9px] tracking-[0.25em]" style={{ color: `${color}cc` }}>
          {node.type === "ou" ? "◇ ou" : node.type === "region" ? "◈" : node.type === "subnet" ? "▤" : TYPE_LABEL[node.type]}
        </span>
        <span className={`${structural || node.type === "account" ? "text-[13px]" : "text-[11px]"} truncate tracking-widest text-slate-100`}>
          {title}
        </span>
        {detail && <span className="text-[9px] tracking-wider text-slate-500">{detail}</span>}
        {node.type === "account" && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              // Selecting the account keeps a selection inside it from re-expanding it straight away.
              select(node.id);
              toggleExpanded(node.id);
            }}
            className="nodrag ml-auto border px-1.5 text-[9px] tracking-widest hover:text-white"
            style={{ borderColor: `${color}80`, color }}
          >
            − collapse
          </button>
        )}
      </div>
      {box.columns?.map((c) => (
        <div key={c.label} className="absolute text-[9px] uppercase tracking-[0.3em] text-cyan-300/60" style={{ left: c.x, top: c.y }}>
          {c.label}
        </div>
      ))}
    </div>
  );
}

export function CardNode({ data }: NodeProps<BoxNode>) {
  const node = data.box.node!;
  const { index, cost } = useSceneData();
  const { selected, hovered } = useHighlight(node.id);
  const toggleExpanded = useMizar((s) => s.toggleExpanded);
  const color = useContainerColor(node);
  const spend = useSpend(node);

  const stats = useMemo(() => {
    const all = descendants(index, node.id);
    return {
      resources: all.filter(isResource).length,
      vpcs: all.filter((n) => n.type === "vpc").length,
      regions: all.filter((n) => n.type === "region").length,
      critical: all.filter((n) => n.status === "critical").length,
      warning: all.filter((n) => n.status === "warning").length,
    };
  }, [index, node.id]);

  return (
    <div
      className="relative flex h-full w-full flex-col justify-between overflow-hidden bg-slate-950/80 py-2 pl-4 pr-3 font-mono"
      style={{
        border: `1px solid ${color}${selected ? "" : "80"}`,
        boxShadow: selected ? `0 0 0 1px ${color}, 0 0 28px ${color}88` : hovered ? `0 0 16px ${color}55` : `0 0 10px ${color}22`,
      }}
    >
      <Anchors />
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
      <div>
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] uppercase tracking-widest text-slate-100">{node.name}</span>
          {stats.critical > 0 && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500 shadow-[0_0_8px_#ef4444]" />}
          <span className="ml-auto text-[9px] uppercase tracking-widest" style={{ color }}>
            {node.status === "stopped" ? "suspended" : envOf(node)}
          </span>
        </div>
        <div className="text-[10px] tracking-wider text-slate-500">{node.accountId}</div>
      </div>
      <div className="flex items-end gap-3 text-[10px] uppercase tracking-wider text-slate-400">
        <span>
          <b className="font-normal text-slate-100">{stats.resources}</b> res
        </span>
        <span>
          <b className="font-normal text-slate-100">{stats.vpcs}</b> vpc
        </span>
        <span>
          <b className="font-normal text-slate-100">{stats.regions}</b> rgn
        </span>
        {spend && (
          <span title={cost?.period === "lastMonth" ? "Spend last month" : "Spend this month to date"}>
            <b className="font-normal text-slate-100">{spend}</b>
          </span>
        )}
        {stats.critical + stats.warning > 0 && (
          <span style={{ color: stats.critical ? STATUS_COLOR.critical : STATUS_COLOR.warning }}>⚠ {stats.critical + stats.warning}</span>
        )}
        {stats.regions > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleExpanded(node.id);
            }}
            className="nodrag ml-auto border px-1.5 text-[9px] tracking-widest hover:text-white"
            style={{ borderColor: `${color}80`, color }}
          >
            + expand
          </button>
        )}
      </div>
    </div>
  );
}

export function ResourceNode({ data }: NodeProps<BoxNode>) {
  const node = data.box.node!;
  const { selected, hovered } = useHighlight(node.id);
  const color = TYPE_COLOR[node.type];
  const status = STATUS_COLOR[node.status];

  return (
    <div
      className="flex h-full w-full items-center gap-2 border bg-slate-950/85 px-2 font-mono"
      style={{
        borderColor: selected ? color : hovered ? `${color}aa` : `${color}40`,
        boxShadow: selected ? `0 0 16px ${color}aa` : undefined,
        opacity: node.status === "stopped" ? 0.55 : 1,
      }}
    >
      <Anchors />
      <span className="w-8 shrink-0 text-[9px] font-semibold tracking-wider" style={{ color, textShadow: `0 0 6px ${color}` }}>
        {TYPE_CODE[node.type] ?? "•"}
      </span>
      <span className="truncate text-[10px] tracking-wide text-slate-200">{node.name}</span>
      <span
        className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${node.status === "critical" ? "animate-pulse" : ""}`}
        style={{ background: status, boxShadow: node.status === "ok" ? undefined : `0 0 6px ${status}` }}
        title={node.status}
      />
    </div>
  );
}

export function ServicesNode() {
  return (
    <div className="h-full w-full border border-dashed border-teal-400/25 font-mono">
      <div className="px-2 pt-1.5 text-[9px] uppercase tracking-[0.25em] text-teal-300/60">regional services</div>
    </div>
  );
}
