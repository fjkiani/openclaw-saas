/**
 * /router-loop — Unified A-Z workflow surface for the OpenClaw intelligence plane.
 *
 * URL state:
 *   /router-loop                           → fleet grid landing
 *   /router-loop?mcp=<slug>&tool=<name>    → drill-down for one bucket
 *   /router-loop?mcp=…&tool=…&stage=judge  → scroll to specific stage in drill-down
 *   /router-loop?mcp=…&tool=…&labeling=1   → open labeling drawer
 *
 * Renders exactly one of: FleetGrid or DrilldownView. Everything lives inside
 * the shared <Layout /> so the sidebar stays intact.
 */
import { useLocation } from "wouter";
import { Layout } from "@/components/Layout";
import { FleetGrid } from "./FleetGrid";
import { DrilldownView } from "./DrilldownView";
import { parseUrlState } from "@/pages/intelligence/workflow-types";

export default function RouterLoopPage() {
  const [location] = useLocation();
  const search = typeof window !== "undefined" ? window.location.search : "";
  const state = parseUrlState(search);
  void location; // re-render on route change

  return (
    <Layout>
      {state.mcp && state.tool ? (
        <DrilldownView mcpSlug={state.mcp} toolName={state.tool} stage={state.stage} labelingOpen={state.labeling} />
      ) : (
        <FleetGrid />
      )}
    </Layout>
  );
}
