/**
 * hooks.ts — TanStack Query bindings for the MCP Trust Certification surface.
 *
 * Wraps the typed certifyClient SDK. Reads: MCP list (to pick a target),
 * leaderboard, single certificate, health. Mutations: certify (issue), revoke.
 * Verify is a mutation-style on-demand call.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiFetch";
import {
  certifyClient,
  type IssueResponse,
  type VerifyResponse,
  type LeaderboardRow,
  type StoredCertificate,
} from "@/lib/certifyClient";

const STALE_MS = 60 * 1000;

export interface McpListRow {
  slug: string;
  name: string;
  category: string;
  gateStatus?: string;
  declaredTools?: Array<{ name: string }>;
}

/** MCP registry rows to choose a certification target. */
export function useMcpList() {
  return useQuery<McpListRow[]>({
    queryKey: ["certify", "mcp-list"],
    queryFn: async () => {
      const res = await apiFetch("/api/mcps/");
      if (!res.ok) throw new Error(`GET /api/mcps → ${res.status}`);
      const data = (await res.json()) as { rows?: McpListRow[] } | McpListRow[];
      return Array.isArray(data) ? data : data.rows ?? [];
    },
    staleTime: STALE_MS,
  });
}

export function useCertifyHealth() {
  return useQuery({
    queryKey: ["certify", "health"],
    queryFn: async () => {
      const res = await apiFetch("/api/v1/certify/health");
      return (await res.json()) as { ok: boolean; live: boolean; model: string; suite_size: number; reason?: string };
    },
    staleTime: STALE_MS,
  });
}

export function useLeaderboard() {
  return useQuery<LeaderboardRow[]>({
    queryKey: ["certify", "leaderboard"],
    queryFn: async () => (await certifyClient.leaderboard(100)).leaderboard,
    staleTime: 15 * 1000,
  });
}

export function useCertificate(slug: string | null) {
  return useQuery<StoredCertificate | null>({
    queryKey: ["certify", "cert-by-slug", slug],
    queryFn: async () => {
      if (!slug) return null;
      const r = await certifyClient.getBySlug(slug);
      return r.certificate ?? null;
    },
    enabled: !!slug,
    staleTime: 15 * 1000,
  });
}

/** Issue a certificate (runs the behavioral eval + signs). */
export function useCertify() {
  const qc = useQueryClient();
  return useMutation<IssueResponse, Error, { slug: string; dry?: boolean }>({
    mutationFn: ({ slug, dry }) => certifyClient.certify(slug, { dry }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["certify", "leaderboard"] });
    },
  });
}

/** Verify a certificate by id. */
export function useVerify() {
  return useMutation<VerifyResponse, Error, string>({
    mutationFn: (certId) => certifyClient.verify(certId),
  });
}

export function useRevoke() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean; revoked?: boolean; error?: string }, Error, string>({
    mutationFn: (certId) => certifyClient.revoke(certId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["certify", "leaderboard"] });
    },
  });
}
