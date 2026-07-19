/**
 * MCP Registry page — governance-gated catalog of MCP servers.
 *
 * Every entry carries an L0-L4 gate report (see lib/mcps/validator.ts).
 * Certified entries are green-badged; conditional entries surface the notes
 * the reviewer needs to close before promotion.
 *
 * Endpoints: /api/mcps, /api/mcps/health, /api/mcps/:slug, /api/mcps/register
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { ShieldCheck, ShieldAlert, ShieldX, Puzzle, Info } from "lucide-react";
import { useMcpsHealth, useMcpsList, type McpRow } from "./hooks";

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "dev-tools", label: "Dev tools" },
  { key: "data", label: "Data" },
  { key: "agent-ops", label: "Agent ops" },
  { key: "vertical", label: "Vertical" },
] as const;

function GateBadge({ status }: { status: string }) {
  if (status === "passed") {
    return (
      <Badge className="bg-green-600 hover:bg-green-600 text-white gap-1">
        <ShieldCheck className="w-3 h-3" /> Certified
      </Badge>
    );
  }
  if (status === "conditional") {
    return (
      <Badge className="bg-amber-500 hover:bg-amber-500 text-white gap-1">
        <ShieldAlert className="w-3 h-3" /> Conditional
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive" className="gap-1">
        <ShieldX className="w-3 h-3" /> Failed
      </Badge>
    );
  }
  return <Badge variant="secondary">Pending</Badge>;
}

function McpRowDetail({ mcp }: { mcp: McpRow }) {
  const nets = mcp.declaredPrivileges?.net ?? [];
  const fss = mcp.declaredPrivileges?.fs ?? [];
  const envs = mcp.declaredPrivileges?.env ?? [];
  return (
    <TableRow data-testid={`mcp-row-${mcp.slug}`}>
      <TableCell className="font-medium">
        <div className="flex flex-col gap-1">
          <span>{mcp.name}</span>
          <span className="text-xs text-muted-foreground font-mono">{mcp.slug}</span>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant="outline">{mcp.category}</Badge>
      </TableCell>
      <TableCell className="text-xs">{mcp.vendor ?? "—"}</TableCell>
      <TableCell className="text-xs font-mono">{mcp.transport}</TableCell>
      <TableCell className="text-xs">{mcp.declaredTools?.length ?? 0}</TableCell>
      <TableCell className="text-xs">
        {nets.length + fss.length + envs.length === 0
          ? "sandboxed"
          : `${nets.length}n · ${fss.length}f · ${envs.length}e`}
      </TableCell>
      <TableCell><GateBadge status={mcp.gateStatus} /></TableCell>
      <TableCell className="text-xs">v{mcp.currentVersion}</TableCell>
    </TableRow>
  );
}

function CategoryView({ category }: { category: string | null }) {
  const list = useMcpsList(category ? { category } : undefined);

  if (list.isLoading) {
    return (
      <Card>
        <CardContent className="py-4 space-y-2">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (list.isError) {
    return (
      <Card>
        <CardContent className="py-4 text-destructive text-sm">
          Failed to load MCP registry: {String(list.error)}
        </CardContent>
      </Card>
    );
  }

  const rows = list.data?.rows ?? [];
  const passed = rows.filter((r) => r.gateStatus === "passed").length;
  const conditional = rows.filter((r) => r.gateStatus === "conditional").length;
  const failed = rows.filter((r) => r.gateStatus === "failed").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Total MCPs" value={rows.length} />
        <StatCard label="Certified" value={passed} tone="green" />
        <StatCard label="Conditional" value={conditional} tone="amber" />
        <StatCard label="Failed" value={failed} tone="destructive" />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Registry</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Transport</TableHead>
                  <TableHead>Tools</TableHead>
                  <TableHead>Privileges</TableHead>
                  <TableHead>Gate</TableHead>
                  <TableHead>Ver</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-6">
                      No MCPs match this filter yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((m) => <McpRowDetail key={m.slug} mcp={m} />)
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "green" | "amber" | "destructive";
}) {
  const color =
    tone === "green"
      ? "text-green-600"
      : tone === "amber"
        ? "text-amber-600"
        : tone === "destructive"
          ? "text-destructive"
          : "text-foreground";
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-2xl font-semibold ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

export default function McpsPage() {
  const [tab, setTab] = useState<string>("all");
  const health = useMcpsHealth();

  return (
    <div className="container mx-auto px-4 py-6 space-y-6" data-testid="page-mcps">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Puzzle className="w-6 h-6" /> MCP Registry
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Governance-gated catalog of MCP (Model Context Protocol) servers.
            Every entry carries an L0-L4 gate report before it is installable
            by a tenant. Certified entries have passed manifest sanity, tool
            schema conformance, privilege honesty, static adversarial check,
            and human reviewer sign-off.
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground shrink-0">
          {health.data?.ok ? (
            <span className="text-green-600">
              {health.data.n_mcps} registered
            </span>
          ) : (
            <span>checking registry…</span>
          )}
        </div>
      </div>

      <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground flex items-start gap-2">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          The MCP validator inspects declared manifests, it does not launch the
          MCP server. Live invocation happens in the per-tenant runtime with
          the pinned version. See <code className="font-mono">.cursor/rules/12-mcp-domain.mdc</code>.
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {CATEGORIES.map((c) => (
            <TabsTrigger key={c.key} value={c.key} data-testid={`mcp-tab-${c.key}`}>
              {c.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {CATEGORIES.map((c) => (
          <TabsContent key={c.key} value={c.key} className="mt-6">
            <CategoryView category={c.key === "all" ? null : c.key} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
