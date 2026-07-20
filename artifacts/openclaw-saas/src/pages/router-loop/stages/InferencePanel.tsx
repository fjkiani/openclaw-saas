/**
 * InferencePanel — W3 track. Prompt box that hits /api/v1/mcps/inference
 * (Modal-hosted). Shows completion, adapter_used, latency, cold-start flag.
 */
import { useState } from "react";
import { useInference } from "@/pages/intelligence/workflow-hooks";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Snowflake, Zap } from "lucide-react";

export function InferencePanel({
  mcpSlug,
  toolName,
  defaultAdapter,
}: {
  mcpSlug: string;
  toolName: string;
  defaultAdapter?: string;
}) {
  const [prompt, setPrompt] = useState("SELECT * FROM users WHERE id = 1;");
  const mut = useInference();

  return (
    <Card className="p-3 mt-3 border-dashed border-border/60 bg-secondary/20">
      <div className="text-[10px] font-mono text-muted-foreground uppercase mb-2">test served adapter</div>
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        className="font-mono text-xs mb-2"
        data-testid="textarea-inference-prompt"
      />
      <div className="flex items-center gap-2 mb-2">
        <Button
          size="sm"
          onClick={() => mut.mutate({ mcp_slug: mcpSlug, tool_name: toolName, prompt, adapter_id: defaultAdapter, max_new_tokens: 64 })}
          disabled={mut.isPending || !prompt.trim()}
          data-testid="btn-run-inference"
        >
          {mut.isPending ? "serving…" : "Run"}
        </Button>
        <span className="text-[10px] font-mono text-muted-foreground">
          adapter: {defaultAdapter ?? "baseline"}
        </span>
      </div>
      {mut.data && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[10px] font-mono">
            <span className="rounded border border-border px-1.5 py-0.5">
              {mut.data.adapter_used}
            </span>
            <span className="text-muted-foreground">{mut.data.latency_ms} ms</span>
            {mut.data.cold_start ? (
              <span className="text-amber-400 flex items-center gap-1">
                <Snowflake className="w-3 h-3" /> cold
              </span>
            ) : (
              <span className="text-emerald-400 flex items-center gap-1">
                <Zap className="w-3 h-3" /> warm
              </span>
            )}
          </div>
          <pre className="text-[11px] font-mono bg-background/60 border border-border rounded p-2 whitespace-pre-wrap max-h-40 overflow-y-auto" data-testid="inference-completion">
            {mut.data.completion}
          </pre>
        </div>
      )}
      {mut.error && <div className="mt-2 text-[11px] font-mono text-rose-400">{String((mut.error as Error).message)}</div>}
    </Card>
  );
}
