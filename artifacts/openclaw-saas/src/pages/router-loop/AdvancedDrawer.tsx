/**
 * AdvancedDrawer — progressive-disclosure toggle for operator-depth details.
 * Every stage card wraps its raw-JSON / curl-equivalent in one of these.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function AdvancedDrawer({ title = "Advanced", children }: { title?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border-t border-border/60 pt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {title}
      </button>
      {open && <div className="mt-2 space-y-2">{children}</div>}
    </div>
  );
}

export function RawJson({ value }: { value: unknown }) {
  return (
    <pre className="text-[10px] font-mono bg-secondary/40 border border-border rounded p-2 overflow-x-auto max-h-64">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
