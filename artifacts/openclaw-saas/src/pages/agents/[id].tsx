import { useState, useRef, useEffect } from "react";
import { useRoute, Link } from "wouter";
import {
  useGetTenant,
  useListTenantSkills,
  useGetTenantActivity,
  useStartTenant,
  useStopTenant,
  useInstallSkillOnTenant,
  useUninstallSkillFromTenant,
  useListSkills,
  useGetChatHistory,
  useSendChatMessage,
  getGetTenantQueryKey,
  getListTenantSkillsQueryKey,
  getGetChatHistoryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout, PageHeader, StatusBadge, ActivityIcon } from "@/components/Layout";
import { useToast } from "@/hooks/use-toast";
import {
  Play,
  Square,
  Zap,
  Plus,
  Trash2,
  ChevronLeft,
  Clock,
  MessageSquare,
  Send,
  AlertTriangle,
} from "lucide-react";

type Tab = "overview" | "skills" | "chat";

function AddSkillModal({ tenantId, onClose }: { tenantId: number; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const { data: skills } = useListSkills({ search: search || undefined });
  const { data: installed } = useListTenantSkills(tenantId);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const installSkill = useInstallSkillOnTenant({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTenantSkillsQueryKey(tenantId) });
        toast({ title: "Skill installed" });
      },
      onError: () => {
        toast({ title: "Error", description: "Could not install skill", variant: "destructive" });
      },
    },
  });

  const installedIds = new Set(installed?.map((s) => s.skillId) ?? []);

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50" data-testid="modal-add-skill">
      <div className="bg-card border border-border rounded-lg p-5 w-full max-w-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-mono font-bold text-foreground">Add Skill</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs font-mono" data-testid="button-close-skill-modal">
            Close
          </button>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary mb-3"
          placeholder="Search skills..."
          data-testid="input-search-skills"
        />
        <div className="max-h-80 overflow-y-auto space-y-2">
          {skills?.slice(0, 20).map((skill) => (
            <div key={skill.id} className="flex items-center justify-between p-2.5 bg-background border border-border rounded" data-testid={`skill-row-${skill.id}`}>
              <div>
                <p className="text-xs font-mono font-bold text-foreground">{skill.name}</p>
                <p className="text-[10px] font-mono text-muted-foreground">{skill.category} · {skill.stars.toLocaleString()} stars</p>
              </div>
              {installedIds.has(skill.id) ? (
                <span className="text-[10px] font-mono text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded">Installed</span>
              ) : (
                <button
                  onClick={() => installSkill.mutate({ id: tenantId, data: { skillId: skill.id } })}
                  disabled={installSkill.isPending}
                  className="flex items-center gap-1 px-2 py-1 bg-primary/10 text-primary border border-primary/20 rounded text-[10px] font-mono hover:bg-primary/20 transition-colors"
                  data-testid={`button-install-skill-${skill.id}`}
                >
                  <Plus className="w-3 h-3" />
                  Install
                </button>
              )}
            </div>
          ))}
          {!skills?.length && (
            <p className="text-center text-xs font-mono text-muted-foreground py-6">No skills found</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatPanel({ tenantId, isRunning }: { tenantId: number; isRunning: boolean }) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: messages = [], isLoading } = useGetChatHistory(tenantId, {
    query: { enabled: !!tenantId, queryKey: getGetChatHistoryQueryKey(tenantId) },
  });

  const send = useSendChatMessage({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetChatHistoryQueryKey(tenantId) });
        setInput("");
      },
      onError: (err: any) => {
        const msg = err?.response?.data?.error ?? "Failed to send message";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || send.isPending) return;
    send.mutate({ id: tenantId, data: { message: trimmed } });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  }

  if (!isRunning) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center gap-3">
        <AlertTriangle className="w-6 h-6 text-amber-400" />
        <p className="text-xs font-mono text-muted-foreground">
          Agent must be running to chat.<br />Start it using the button above.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-lg flex flex-col" style={{ minHeight: 480 }} data-testid="chat-panel">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <MessageSquare className="w-3.5 h-3.5 text-primary" />
        <span className="text-xs font-mono font-bold text-foreground">Agent Chat</span>
        <span className="ml-auto text-[10px] font-mono text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded">live</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ maxHeight: 380 }}>
        {isLoading && (
          <div className="text-center text-[10px] font-mono text-muted-foreground py-8">Loading history…</div>
        )}
        {!isLoading && messages.length === 0 && (
          <div className="text-center text-[10px] font-mono text-muted-foreground py-8">
            Send a message to start talking to your agent.
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            data-testid={`chat-message-${msg.id}`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2 ${
                msg.role === "user"
                  ? "bg-primary/15 border border-primary/20 text-foreground"
                  : msg.role === "error"
                  ? "bg-red-500/10 border border-red-500/20 text-red-300"
                  : "bg-secondary border border-border text-foreground"
              }`}
            >
              <p className="text-xs font-mono leading-relaxed whitespace-pre-wrap">{msg.content}</p>
              <p className="text-[9px] font-mono text-muted-foreground mt-1">
                {msg.role === "error" ? "error · " : ""}{new Date(msg.createdAt).toLocaleTimeString()}
              </p>
            </div>
          </div>
        ))}
        {send.isPending && (
          <div className="flex justify-start" data-testid="chat-thinking">
            <div className="bg-secondary border border-border rounded-lg px-3 py-2">
              <div className="flex gap-1 items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: "120ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: "240ms" }} />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="flex items-end gap-2 p-3 border-t border-border">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          disabled={send.isPending}
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          className="flex-1 bg-background border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none disabled:opacity-50"
          data-testid="input-chat-message"
        />
        <button
          type="submit"
          disabled={!input.trim() || send.isPending}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground rounded text-xs font-mono hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="button-send-chat"
        >
          <Send className="w-3.5 h-3.5" />
          Send
        </button>
      </form>
    </div>
  );
}

export default function AgentDetailPage() {
  const [, params] = useRoute<{ id: string }>("/agents/:id");
  const tenantId = Number(params?.id);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [showAddSkill, setShowAddSkill] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: tenant, isLoading } = useGetTenant(tenantId, {
    query: { enabled: !!tenantId, queryKey: getGetTenantQueryKey(tenantId) },
  });
  const { data: skills } = useListTenantSkills(tenantId, {
    query: { enabled: !!tenantId, queryKey: getListTenantSkillsQueryKey(tenantId) },
  });
  const { data: activity } = useGetTenantActivity(tenantId);

  const startTenant = useStartTenant({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetTenantQueryKey(tenantId) });
        toast({ title: "Agent started" });
      },
    },
  });

  const stopTenant = useStopTenant({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetTenantQueryKey(tenantId) });
        toast({ title: "Agent stopped" });
      },
    },
  });

  const uninstallSkill = useUninstallSkillFromTenant({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTenantSkillsQueryKey(tenantId) });
        toast({ title: "Skill removed" });
      },
    },
  });

  if (isLoading) {
    return (
      <Layout>
        <PageHeader title="Loading..." />
        <div className="p-6">
          <div className="h-32 bg-card border border-border rounded-lg animate-pulse" />
        </div>
      </Layout>
    );
  }

  if (!tenant) {
    return (
      <Layout>
        <PageHeader title="Agent not found" />
        <div className="p-6 text-center text-xs font-mono text-muted-foreground">
          This agent does not exist or was deleted.
        </div>
      </Layout>
    );
  }

  const isRunning = tenant.status === "running";

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "skills", label: `Skills (${skills?.length ?? 0})` },
    { id: "chat", label: "Chat" },
  ];

  return (
    <Layout>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <Link href="/agents" className="text-muted-foreground hover:text-foreground" data-testid="link-back-agents">
            <ChevronLeft className="w-4 h-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-mono font-bold text-foreground">{tenant.name}</h1>
              <StatusBadge status={tenant.status} />
            </div>
            {tenant.description && (
              <p className="text-xs font-mono text-muted-foreground mt-0.5">{tenant.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tenant.status === "stopped" && (
            <button
              onClick={() => startTenant.mutate({ id: tenantId })}
              disabled={startTenant.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded text-xs font-mono hover:bg-emerald-500/20 transition-colors"
              data-testid="button-start-agent"
            >
              <Play className="w-3.5 h-3.5" />
              Start Agent
            </button>
          )}
          {tenant.status === "running" && (
            <button
              onClick={() => stopTenant.mutate({ id: tenantId })}
              disabled={stopTenant.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-500/10 text-zinc-400 border border-zinc-500/20 rounded text-xs font-mono hover:bg-zinc-500/20 transition-colors"
              data-testid="button-stop-agent"
            >
              <Square className="w-3.5 h-3.5" />
              Stop Agent
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-border px-6">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-xs font-mono transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            data-testid={`tab-${tab.id}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="p-6">
        {/* Overview */}
        {activeTab === "overview" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-card border border-border rounded-lg p-4">
              <h3 className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3">Instance Info</h3>
              <dl className="space-y-2">
                <div className="flex justify-between">
                  <dt className="text-[10px] font-mono text-muted-foreground">Status</dt>
                  <dd><StatusBadge status={tenant.status} /></dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[10px] font-mono text-muted-foreground">Memory</dt>
                  <dd className="text-[11px] font-mono text-foreground">{Math.round((tenant.memoryUsedKb ?? 0) / 1024)} MB</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[10px] font-mono text-muted-foreground">Agents</dt>
                  <dd className="text-[11px] font-mono text-foreground">{tenant.agentCount}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[10px] font-mono text-muted-foreground">Created</dt>
                  <dd className="text-[11px] font-mono text-foreground">{new Date(tenant.createdAt).toLocaleDateString()}</dd>
                </div>
                {tenant.wsEndpoint && (
                  <div>
                    <dt className="text-[10px] font-mono text-muted-foreground mb-1">WS Endpoint</dt>
                    <dd className="text-[10px] font-mono text-primary break-all">{tenant.wsEndpoint}</dd>
                  </div>
                )}
              </dl>
            </div>

            {/* Activity */}
            <div className="bg-card border border-border rounded-lg">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Activity</span>
                <Clock className="w-3 h-3 text-muted-foreground" />
              </div>
              {!activity?.length ? (
                <div className="p-4 text-center text-[10px] font-mono text-muted-foreground">No activity</div>
              ) : (
                <div className="divide-y divide-border">
                  {activity.slice(0, 10).map((entry) => (
                    <div key={entry.id} className="flex items-start gap-2 px-4 py-2.5" data-testid={`activity-entry-${entry.id}`}>
                      <ActivityIcon type={entry.type} />
                      <div>
                        <p className="text-[11px] font-mono text-foreground">{entry.message}</p>
                        <p className="text-[10px] font-mono text-muted-foreground">
                          {new Date(entry.createdAt).toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Skills */}
        {activeTab === "skills" && (
          <div className="bg-card border border-border rounded-lg">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Zap className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-mono font-bold text-foreground">
                  Installed Skills ({skills?.length ?? 0})
                </span>
              </div>
              <button
                onClick={() => setShowAddSkill(true)}
                className="flex items-center gap-1 px-2.5 py-1 bg-primary/10 text-primary border border-primary/20 rounded text-[10px] font-mono hover:bg-primary/20 transition-colors"
                data-testid="button-add-skill"
              >
                <Plus className="w-3 h-3" />
                Add Skill
              </button>
            </div>
            {!skills?.length ? (
              <div className="p-10 text-center">
                <Zap className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
                <p className="text-xs font-mono text-muted-foreground">No skills installed</p>
                <button
                  onClick={() => setShowAddSkill(true)}
                  className="text-xs font-mono text-primary hover:underline mt-1"
                  data-testid="button-add-first-skill"
                >
                  Install from catalog
                </button>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {skills.map((skill) => (
                  <div key={skill.id} className="flex items-center justify-between px-4 py-3 hover:bg-secondary/20 transition-colors" data-testid={`installed-skill-${skill.id}`}>
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Zap className="w-3.5 h-3.5 text-primary" />
                      </div>
                      <div>
                        <p className="text-xs font-mono font-bold text-foreground">{skill.skillName}</p>
                        <p className="text-[10px] font-mono text-muted-foreground">
                          {skill.category} · Installed {new Date(skill.installedAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => uninstallSkill.mutate({ id: tenantId, skillId: skill.skillId })}
                      className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                      data-testid={`button-uninstall-${skill.skillId}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Chat */}
        {activeTab === "chat" && (
          <ChatPanel tenantId={tenantId} isRunning={isRunning} />
        )}
      </div>

      {showAddSkill && (
        <AddSkillModal tenantId={tenantId} onClose={() => setShowAddSkill(false)} />
      )}
    </Layout>
  );
}
