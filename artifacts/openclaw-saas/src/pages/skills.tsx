import { useState } from "react";
import {
  useListSkills,
  useListFeaturedSkills,
  useListSkillCategories,
  useListTenants,
  useInstallSkillOnTenant,
  getListTenantSkillsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout, PageHeader, EmptyState } from "@/components/Layout";
import { useToast } from "@/hooks/use-toast";
import { Zap, Star, Download, Search, Filter } from "lucide-react";

export default function SkillsPage() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: featured } = useListFeaturedSkills();
  const { data: categories } = useListSkillCategories();
  const { data: skills, isLoading } = useListSkills(
    { search: search || undefined, category: category || undefined },
    { query: { queryKey: ["skills", search, category] as any } }
  );
  const { data: tenants } = useListTenants();

  const installSkill = useInstallSkillOnTenant({
    mutation: {
      onSuccess: (_, vars) => {
        if (vars.id) queryClient.invalidateQueries({ queryKey: getListTenantSkillsQueryKey(vars.id) });
        toast({ title: "Skill installed" });
      },
      onError: () => {
        toast({ title: "Error", description: "Could not install skill", variant: "destructive" });
      },
    },
  });

  const handleInstall = (skillId: number) => {
    if (!selectedTenantId) {
      toast({ title: "Select an agent first", description: "Choose which agent to install this skill on" });
      return;
    }
    installSkill.mutate({ id: selectedTenantId, data: { skillId } });
  };

  return (
    <Layout>
      <PageHeader
        title="Skill Catalog"
        subtitle="5,400+ skills from ClawHub — install on any agent"
      />

      <div className="p-6 space-y-5">
        {/* Controls */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-card border border-border rounded pl-9 pr-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Search skills..."
              data-testid="input-search"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="w-3.5 h-3.5 text-muted-foreground" />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="bg-card border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              data-testid="select-category"
            >
              <option value="">All categories</option>
              {categories?.map((c) => (
                <option key={c.slug} value={c.name}>
                  {c.name} ({c.count})
                </option>
              ))}
            </select>
            <select
              value={selectedTenantId ?? ""}
              onChange={(e) => setSelectedTenantId(e.target.value ? Number(e.target.value) : null)}
              className="bg-card border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              data-testid="select-target-agent"
            >
              <option value="">Install to agent...</option>
              {tenants?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Featured skills */}
        {!search && !category && featured && featured.length > 0 && (
          <div>
            <h2 className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3">
              Featured & Trending
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
              {featured.slice(0, 6).map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onInstall={handleInstall}
                  installing={installSkill.isPending}
                  featured
                />
              ))}
            </div>
          </div>
        )}

        {/* All skills */}
        <div>
          {(search || category) && (
            <h2 className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3">
              {isLoading ? "Searching..." : `${skills?.length ?? 0} results`}
            </h2>
          )}
          {!search && !category && (
            <h2 className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3">
              All Skills
            </h2>
          )}
          {isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="h-32 bg-card border border-border rounded-lg animate-pulse" />
              ))}
            </div>
          ) : !skills?.length ? (
            <EmptyState
              icon={Zap}
              title="No skills found"
              description="Try a different search term or category"
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {skills.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onInstall={handleInstall}
                  installing={installSkill.isPending}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

function SkillCard({
  skill,
  onInstall,
  installing,
  featured,
}: {
  skill: { id: number; name: string; slug: string; description: string; category: string; stars: number; installs: number; featured: boolean; tags: string[] };
  onInstall: (id: number) => void;
  installing: boolean;
  featured?: boolean;
}) {
  return (
    <div
      className={`bg-card border rounded-lg p-4 hover:border-primary/30 transition-colors ${featured ? "border-primary/30" : "border-border"}`}
      data-testid={`skill-card-${skill.id}`}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
          <Zap className="w-4 h-4 text-primary" />
        </div>
        {skill.featured && (
          <span className="text-[9px] font-mono text-amber-400 border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 rounded">
            FEATURED
          </span>
        )}
      </div>
      <h3 className="text-xs font-mono font-bold text-foreground mb-1 truncate">{skill.name}</h3>
      <p className="text-[10px] font-mono text-muted-foreground mb-2 line-clamp-2 leading-relaxed">
        {skill.description}
      </p>
      <div className="flex items-center gap-3 mb-3">
        <span className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
          <Star className="w-3 h-3" />
          {skill.stars.toLocaleString()}
        </span>
        <span className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
          <Download className="w-3 h-3" />
          {skill.installs.toLocaleString()}
        </span>
        <span className="text-[10px] font-mono text-primary">{skill.category}</span>
      </div>
      <button
        onClick={() => onInstall(skill.id)}
        disabled={installing}
        className="w-full py-1.5 bg-primary/10 text-primary border border-primary/20 rounded text-[10px] font-mono hover:bg-primary/20 transition-colors disabled:opacity-50"
        data-testid={`button-install-${skill.id}`}
      >
        Install on agent
      </button>
    </div>
  );
}
