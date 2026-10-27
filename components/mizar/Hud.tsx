"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { User } from "@/lib/auth/session";
import { formatMoney, isCostKey, nodeCost, parseTopServices } from "@/lib/graph/cost";
import { ancestry, countByType, descendants, isResource } from "@/lib/graph/query";
import type { EdgeKind, GraphNode, NodeType } from "@/lib/graph/types";
import { COST_RAMP, type CostScale, NO_COST } from "./cost";
import { useSceneData } from "./data";
import { useMizar } from "./store";
import { EDGE_COLOR, ENV_COLOR, STATUS_COLOR, TYPE_COLOR, TYPE_LABEL } from "./theme";

const STRUCTURAL: NodeType[] = ["organization", "ou", "account", "region"];

export function Hud({ user }: { user: User | null }) {
  const select = useMizar((s) => s.select);
  const view = useMizar((s) => s.view);

  useDeepLink();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  // z-20 keeps the HUD above drei <Html> labels, which use z-index up to 10.
  return (
    <div className="pointer-events-none absolute inset-0 z-20 font-mono text-xs text-slate-300">
      <div className="absolute left-4 top-4 flex w-80 flex-col gap-3">
        <Summary user={user} />
        <Breadcrumb />
      </div>
      <div className="absolute left-1/2 top-4 w-96 -translate-x-1/2">
        <Search />
      </div>
      {/* In 2D the minimap owns the bottom-right corner. */}
      <div className={`absolute right-4 top-4 flex w-96 flex-col justify-start ${view === "2d" ? "bottom-48" : "bottom-4"}`}>
        <Details />
      </div>
      <div className="absolute bottom-4 left-4">
        <Legend />
      </div>
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
        <Controls />
      </div>
      <Scanframe />
    </div>
  );
}

/**
 * Keeps view, colouring and selection in the URL (`?view=2d&color=cost#<node id or name>`), so views can be shared
 * and survive reloads.
 * The view is only known after mount, which keeps server and first client render identical.
 */
function useDeepLink() {
  const { graph, index } = useSceneData();
  const selectedId = useMizar((s) => s.selectedId);
  const view = useMizar((s) => s.view);
  const select = useMizar((s) => s.select);
  const setView = useMizar((s) => s.setView);
  const colorBy = useMizar((s) => s.colorBy);
  const setColorBy = useMizar((s) => s.setColorBy);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setView(params.get("view") === "2d" ? "2d" : "3d");
    setColorBy(params.get("color") === "cost" ? "cost" : "environment");
    const fromHash = () => {
      const key = decodeURIComponent(window.location.hash.slice(1));
      if (!key) return select(null);
      const node = index.byId.get(key) ?? graph.nodes.find((n) => n.name === key);
      if (node) select(node.id);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [graph, index, select, setView, setColorBy]);

  useEffect(() => {
    if (!view) return;
    const params = new URLSearchParams();
    if (view === "2d") params.set("view", "2d");
    if (colorBy === "cost") params.set("color", "cost");
    const query = params.size ? `?${params}` : "";
    const url = `${window.location.pathname}${query}${selectedId ? `#${encodeURIComponent(selectedId)}` : ""}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) history.replaceState(null, "", url);
  }, [selectedId, view, colorBy]);
}

function Panel({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`pointer-events-auto relative border border-teal-400/25 bg-slate-950/65 p-3 backdrop-blur-sm ${className}`}>
      {/* corner brackets */}
      <span className="absolute -left-px -top-px h-2 w-2 border-l-2 border-t-2 border-teal-300" />
      <span className="absolute -right-px -top-px h-2 w-2 border-r-2 border-t-2 border-teal-300" />
      <span className="absolute -bottom-px -left-px h-2 w-2 border-b-2 border-l-2 border-teal-300" />
      <span className="absolute -bottom-px -right-px h-2 w-2 border-b-2 border-r-2 border-teal-300" />
      {title && <h2 className="mb-2 text-[10px] uppercase tracking-[0.3em] text-teal-300/80">{title}</h2>}
      {children}
    </section>
  );
}

function Summary({ user }: { user: User | null }) {
  const { graph, index } = useSceneData();
  const stats = useMemo(() => {
    const counts = countByType(graph.nodes);
    const resources = graph.nodes.filter(isResource).length;
    const alerts = graph.nodes.filter((n) => n.status === "critical" || n.status === "warning");
    return {
      accounts: counts.account ?? 0,
      regions: new Set(graph.nodes.filter((n) => n.region).map((n) => n.region)).size,
      resources,
      critical: alerts.filter((n) => n.status === "critical"),
      warning: alerts.filter((n) => n.status === "warning").length,
    };
  }, [graph]);
  const select = useMizar((s) => s.select);

  return (
    <Panel>
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold tracking-[0.4em] text-teal-200 drop-shadow-[0_0_8px_rgba(94,234,212,0.8)]">MIZAR</h1>
        <span className="text-[10px] uppercase tracking-widest text-slate-500">{graph.source === "mock" ? "simulation" : "live"}</span>
      </div>
      <p className="mt-1 truncate text-[11px] uppercase tracking-wider text-slate-400">{index.root.name}</p>
      <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
        <Stat label="accts" value={stats.accounts} />
        <Stat label="regions" value={stats.regions} />
        <Stat label="res" value={stats.resources} />
        <Stat label="alerts" value={stats.critical.length + stats.warning} tone={stats.critical.length ? "critical" : "warning"} />
      </dl>
      <Spend />
      {stats.critical.length > 0 && (
        <ul className="mt-3 space-y-1">
          {stats.critical.slice(0, 4).map((n) => (
            <li key={n.id}>
              <button onClick={() => select(n.id)} className="flex w-full items-center gap-2 text-left text-[11px] text-red-300 hover:text-white">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500 shadow-[0_0_6px_#ef4444]" />
                <span className="truncate">{n.name}</span>
                <span className="ml-auto text-[9px] uppercase text-slate-500">{TYPE_LABEL[n.type]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {user && (
        <form action="/auth/logout" method="post" className="mt-3 flex items-center gap-2 border-t border-teal-400/10 pt-2 text-[10px] text-slate-500">
          <span className="truncate" title={user.email}>{user.name ?? user.email ?? user.sub}</span>
          <button className="ml-auto uppercase tracking-widest text-teal-300/70 hover:text-teal-100">sign out</button>
        </form>
      )}
    </Panel>
  );
}

const PERIOD_LABEL: Record<CostScale["period"], string> = { monthToDate: "this month to date", lastMonth: "last month" };

/** Organization spend and the biggest accounts; or why costs are missing, when the collector reported a problem. */
function Spend() {
  const { graph, index, cost } = useSceneData();
  const select = useMizar((s) => s.select);
  const top = useMemo(() => {
    if (!cost) return [];
    return graph.nodes
      .flatMap((n) => {
        const c = n.type === "account" ? nodeCost(n) : undefined;
        return c && c[cost.period] > 0 ? [{ node: n, amount: c[cost.period] }] : [];
      })
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 3);
  }, [graph, cost]);

  const error = index.root.meta.costError;
  if (!cost) {
    return error ? (
      <p className="mt-3 truncate text-[10px] text-slate-500" title={String(error)}>
        <span className="uppercase tracking-widest" style={{ color: STATUS_COLOR.warning }}>⚠ costs unavailable</span> · {String(error)}
      </p>
    ) : null;
  }
  const { summary } = cost;
  const money = (amount: number) => formatMoney(amount, summary.currency);
  const accounts = graph.nodes.filter((n) => n.type === "account").length;

  return (
    <div className="mt-3 border-t border-teal-400/10 pt-2">
      <dl className="grid grid-cols-2 gap-2">
        <div>
          <dt className="text-[9px] uppercase tracking-widest text-slate-500">spend to date</dt>
          <dd className="text-base text-teal-100">{money(summary.monthToDate)}</dd>
        </div>
        <div>
          <dt className="text-[9px] uppercase tracking-widest text-slate-500">last month</dt>
          <dd className="text-base text-slate-300">{money(summary.lastMonth)}</dd>
        </div>
      </dl>
      {top.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {top.map(({ node, amount }) => (
            <li key={node.id}>
              <button onClick={() => select(node.id)} className="flex w-full items-center gap-2 text-left text-[11px] hover:text-white">
                <span className="truncate">{node.name}</span>
                <span className="ml-auto shrink-0 tabular-nums text-slate-200">{money(amount)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-[9px] uppercase tracking-wider text-slate-500" title="Credits and refunds excluded">
        {summary.metric.replace(/Cost$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() || "cost"} · through {summary.through}
        {summary.accounts < accounts && ` · ${summary.accounts} of ${accounts} accounts`}
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "critical" | "warning" }) {
  return (
    <div className="border border-teal-400/15 py-1">
      <dd className="text-base text-teal-100" style={tone ? { color: STATUS_COLOR[tone] } : undefined}>
        {value.toLocaleString()}
      </dd>
      <dt className="text-[9px] uppercase tracking-widest text-slate-500">{label}</dt>
    </div>
  );
}

function Breadcrumb() {
  const { index } = useSceneData();
  const selectedId = useMizar((s) => s.selectedId);
  const select = useMizar((s) => s.select);
  if (!selectedId) return null;
  const path = ancestry(index, selectedId);

  return (
    <Panel title="Trace">
      <ol className="space-y-0.5">
        {path.map((n, i) => (
          <li key={n.id} style={{ paddingLeft: i * 8 }}>
            <button onClick={() => select(n.id)} className="truncate text-left hover:text-white">
              <span className="text-slate-500">{i ? "└ " : ""}</span>
              <span style={{ color: TYPE_COLOR[n.type] }}>{n.name}</span>
            </button>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function Search() {
  const { graph } = useSceneData();
  const select = useMizar((s) => s.select);
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return graph.nodes
      .filter((n) => n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q) || TYPE_LABEL[n.type].toLowerCase().includes(q))
      .slice(0, 8);
  }, [graph, query]);

  const choose = (n: GraphNode) => {
    select(n.id);
    setQuery("");
  };

  return (
    <div className="pointer-events-auto">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0]) choose(results[0]);
          if (e.key === "Escape") setQuery("");
        }}
        placeholder="⌕  SEARCH NAME · ARN · TYPE"
        className="w-full border border-teal-400/30 bg-slate-950/70 px-3 py-2 text-xs uppercase tracking-widest text-teal-100 placeholder:text-slate-500 focus:border-teal-300 focus:outline-none focus:ring-1 focus:ring-teal-300/40"
      />
      {results.length > 0 && (
        <ul className="mt-1 border border-teal-400/25 bg-slate-950/90 backdrop-blur-sm">
          {results.map((n) => (
            <li key={n.id}>
              <button onClick={() => choose(n)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-teal-400/10">
                <span className="h-2 w-2 shrink-0" style={{ background: TYPE_COLOR[n.type] }} />
                <span className="truncate text-teal-100">{n.name}</span>
                <span className="ml-auto shrink-0 text-[9px] uppercase text-slate-500">{TYPE_LABEL[n.type]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Details() {
  const { index } = useSceneData();
  const selectedId = useMizar((s) => s.selectedId);
  const select = useMizar((s) => s.select);
  const node = selectedId ? index.byId.get(selectedId) : undefined;
  if (!node) return null;

  const connections = index.edgesOf.get(node.id) ?? [];
  const contained = STRUCTURAL.includes(node.type) || node.type === "vpc" || node.type === "subnet" ? countByType(descendants(index, node.id)) : null;

  return (
    <Panel className="max-h-full overflow-y-auto">
      <div className="text-[10px] uppercase tracking-[0.3em]" style={{ color: TYPE_COLOR[node.type] }}>
        {TYPE_LABEL[node.type]}
      </div>
      <div className="mt-1 flex items-start gap-2">
        <h2 className="break-all text-sm text-white">{node.name}</h2>
        <span
          className="ml-auto shrink-0 border px-1.5 py-0.5 text-[9px] uppercase tracking-widest"
          style={{ color: STATUS_COLOR[node.status], borderColor: STATUS_COLOR[node.status] }}
        >
          {node.status}
        </span>
      </div>
      <p className="mt-2 break-all text-[10px] text-slate-500">{node.id}</p>

      <Section title="Location">
        <Row k="account" v={node.accountId} />
        <Row k="region" v={node.region} />
        <Row k="az" v={node.az} />
      </Section>

      <CostSection node={node} />

      {Object.keys(node.meta).some((k) => !isCostKey(k)) && (
        <Section title="Attributes">
          {Object.entries(node.meta).filter(([k]) => !isCostKey(k)).map(([k, v]) => (
            <Row key={k} k={k} v={typeof v === "number" ? v.toLocaleString() : String(v)} />
          ))}
        </Section>
      )}

      {Object.keys(node.tags).length > 0 && (
        <Section title="Tags">
          {Object.entries(node.tags).map(([k, v]) => (
            <Row key={k} k={k} v={v} />
          ))}
        </Section>
      )}

      {contained && Object.keys(contained).length > 0 && (
        <Section title="Contains">
          <div className="grid grid-cols-2 gap-x-3">
            {Object.entries(contained).map(([type, n]) => (
              <Row key={type} k={TYPE_LABEL[type as NodeType]} v={String(n)} />
            ))}
          </div>
        </Section>
      )}

      {connections.length > 0 && (
        <Section title={`Links · ${connections.length}`}>
          <ul className="space-y-0.5">
            {connections.slice(0, 40).map((edge) => {
              const outgoing = edge.from === node.id;
              const other = index.byId.get(outgoing ? edge.to : edge.from)!;
              return (
                <li key={edge.id}>
                  <button onClick={() => select(other.id)} className="flex w-full items-center gap-2 text-left hover:text-white">
                    <span className="w-24 shrink-0 text-[9px] uppercase" style={{ color: EDGE_COLOR[edge.kind] }}>
                      {outgoing ? "→" : "←"} {edge.kind}
                    </span>
                    <span className="truncate">{other.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <button onClick={() => select(node.parentId ?? null)} className="mt-4 text-[10px] uppercase tracking-widest text-teal-300 hover:text-white">
        ↑ up a level
      </button>
    </Panel>
  );
}

/** Spend of an account, region or the organization: both periods, share of the total, top services. */
function CostSection({ node }: { node: GraphNode }) {
  const { cost } = useSceneData();
  const spend = nodeCost(node);
  if (!cost || !spend) return null;
  const money = (amount: number) => formatMoney(amount, cost.summary.currency);
  const total = cost.summary[cost.period];
  const share = node.type === "organization" || total <= 0 ? undefined : spend[cost.period] / total;
  const { services, more } = parseTopServices(node.meta.costTopServices);

  return (
    <Section title="Cost">
      <Row k="this month to date" v={money(spend.monthToDate)} />
      <Row k="last month" v={money(spend.lastMonth)} />
      {share !== undefined && <Row k={`share of org${cost.period === "lastMonth" ? ", last month" : ""}`} v={`${(share * 100).toFixed(share < 0.1 ? 1 : 0)} %`} />}
      {node.type === "organization" && <Row k="period" v={`${cost.summary.from} → ${cost.summary.through}`} />}
      {services.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {services.map(([service, amount]) => (
            <li key={service} className="flex gap-2 text-[11px]">
              <span className="truncate text-slate-400">{service}</span>
              <span className="ml-auto shrink-0 tabular-nums text-slate-200">{money(amount)}</span>
            </li>
          ))}
          {more > 0 && <li className="text-[10px] text-slate-500">+ {more} more services</li>}
        </ul>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3 border-t border-teal-400/15 pt-2">
      <h3 className="mb-1 text-[9px] uppercase tracking-[0.3em] text-teal-300/70">{title}</h3>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v?: string }) {
  if (!v) return null;
  return (
    <div className="flex gap-2 text-[11px]">
      <span className="shrink-0 text-slate-500">{k}</span>
      <span className="ml-auto truncate text-right text-slate-200">{v}</span>
    </div>
  );
}

function Legend() {
  const hiddenEdgeKinds = useMizar((s) => s.hiddenEdgeKinds);
  const toggleEdgeKind = useMizar((s) => s.toggleEdgeKind);
  const colorBy = useMizar((s) => s.colorBy);
  const { cost } = useSceneData();
  const resourceTypes: NodeType[] = [
    "ec2",
    "ecs-service",
    "eks-cluster",
    "lambda",
    "elb",
    "workspaces",
    "api-gateway",
    "cloudfront",
    "rds",
    "elasticache",
    "dynamodb",
    "s3",
    "sqs",
    "tgw",
    "vpn-connection",
    "network-firewall",
  ];
  return (
    <Panel title="Legend" className="w-80">
      {colorBy === "cost" && cost ? (
        <CostLegend cost={cost} />
      ) : (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {Object.entries(ENV_COLOR).map(([env, color]) => (
            <Swatch key={env} color={color} label={env} round />
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {resourceTypes.map((t) => (
          <Swatch key={t} color={TYPE_COLOR[t]} label={t} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {(Object.entries(EDGE_COLOR) as [EdgeKind, string][]).map(([kind, color]) => {
          const hidden = hiddenEdgeKinds.has(kind);
          return (
            <button
              key={kind}
              onClick={() => toggleEdgeKind(kind)}
              title={hidden ? "Show these links" : "Hide these links"}
              className={`flex items-center gap-1 text-[9px] uppercase hover:text-white ${hidden ? "text-slate-600 line-through" : "text-slate-400"}`}
            >
              <span className="h-px w-3" style={{ background: hidden ? "#334155" : color, boxShadow: hidden ? undefined : `0 0 4px ${color}` }} />
              {kind}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

/** The account colour ramp: log scale from nothing to the biggest account. */
function CostLegend({ cost }: { cost: CostScale }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest text-slate-400">account spend, {PERIOD_LABEL[cost.period]}</div>
      <div className="mt-1 h-2" style={{ background: `linear-gradient(to right, ${COST_RAMP.join(", ")})` }} />
      <div className="mt-0.5 flex text-[9px] tabular-nums text-slate-400">
        <span>{formatMoney(cost.min, cost.summary.currency, true)}</span>
        <span className="ml-auto">{formatMoney(cost.max, cost.summary.currency, true)} · log scale</span>
      </div>
      <div className="mt-1">
        <Swatch color={NO_COST} label="no figures" round />
      </div>
    </div>
  );
}

function Swatch({ color, label, round }: { color: string; label: string; round?: boolean }) {
  return (
    <span className="flex items-center gap-1 text-[9px] uppercase text-slate-400">
      <span className={`h-2 w-2 ${round ? "rounded-full" : ""}`} style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      {label}
    </span>
  );
}

function Controls() {
  const select = useMizar((s) => s.select);
  const selectedId = useMizar((s) => s.selectedId);
  const effects = useMizar((s) => s.effects);
  const toggleEffects = useMizar((s) => s.toggleEffects);
  const hoveredId = useMizar((s) => s.hoveredId);
  const view = useMizar((s) => s.view);
  const setView = useMizar((s) => s.setView);
  const setExpanded = useMizar((s) => s.setExpanded);
  const colorBy = useMizar((s) => s.colorBy);
  const setColorBy = useMizar((s) => s.setColorBy);
  const { index, org, cost } = useSceneData();
  const hovered = hoveredId ? index.byId.get(hoveredId) : undefined;

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-2">
      <div className="h-4 text-[10px] uppercase tracking-widest text-teal-200">
        {hovered && (
          <>
            <span style={{ color: TYPE_COLOR[hovered.type] }}>{TYPE_LABEL[hovered.type]}</span> · {hovered.name}
          </>
        )}
      </div>
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest">
        <button onClick={() => select(null)} className="border border-teal-400/30 bg-slate-950/70 px-3 py-1.5 text-teal-200 hover:border-teal-300 hover:text-white">
          ◎ overview
        </button>
        <div className="flex border border-teal-400/30 bg-slate-950/70">
          {(["3d", "2d"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1.5 ${view === v ? "bg-teal-400/20 text-white" : "text-teal-200/60 hover:text-white"}`}
            >
              {v}
            </button>
          ))}
        </div>
        {cost && (
          <div className="flex border border-teal-400/30 bg-slate-950/70" title="What account colours show">
            {(["environment", "cost"] as const).map((c) => (
              <button
                key={c}
                onClick={() => setColorBy(c)}
                className={`px-3 py-1.5 ${colorBy === c ? "bg-teal-400/20 text-white" : "text-teal-200/60 hover:text-white"}`}
              >
                {c === "environment" ? "env" : "cost"}
              </button>
            ))}
          </div>
        )}
        {view === "3d" ? (
          <>
            <button onClick={toggleEffects} className="border border-teal-400/30 bg-slate-950/70 px-3 py-1.5 text-teal-200 hover:border-teal-300 hover:text-white">
              fx {effects ? "on" : "off"}
            </button>
            <span className="text-slate-500">drag rotate · right-drag pan · scroll zoom · esc back</span>
          </>
        ) : (
          <>
            <button
              onClick={() => setExpanded(org.planets.map((p) => p.account.id))}
              className="border border-teal-400/30 bg-slate-950/70 px-3 py-1.5 text-teal-200 hover:border-teal-300 hover:text-white"
            >
              expand all
            </button>
            <button
              onClick={() => {
                // Keep the selection valid: anything inside an account falls back to the account.
                const account = selectedId ? org.accountNodeOf.get(selectedId) : undefined;
                if (account) select(account);
                setExpanded([]);
              }}
              className="border border-teal-400/30 bg-slate-950/70 px-3 py-1.5 text-teal-200 hover:border-teal-300 hover:text-white"
            >
              collapse all
            </button>
            <span className="text-slate-500">drag pan · scroll zoom · double-click account to expand · esc back</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Thin frame around the viewport. */
function Scanframe() {
  return <div className="absolute inset-2 border border-teal-400/10" />;
}
