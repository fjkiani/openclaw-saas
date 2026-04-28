const RENDER_API = "https://api.render.com/v1";

function headers(): Record<string, string> {
  const key = process.env.RENDER_API_KEY;
  if (!key) throw new Error("RENDER_API_KEY environment variable is not set");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function ownerId(): string {
  const id = process.env.RENDER_OWNER_ID;
  if (!id) throw new Error("RENDER_OWNER_ID environment variable is not set");
  return id;
}

export interface ProvisionResult {
  serviceId: string;
  wsEndpoint: string;
  status: "provisioning";
}

export async function provisionTenant(
  tenantId: string,
  token: string
): Promise<ProvisionResult> {
  const res = await fetch(`${RENDER_API}/services`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type: "private_service",
      name: `openclaw-gateway-${tenantId}`,
      ownerId: ownerId(),
      serviceDetails: {
        runtime: "docker",
        dockerImage: "openclaw/openclaw-gateway:latest",
        envVars: [
          { key: "OPENCLAW_CONFIG_DIR", value: `/tenants/${tenantId}` },
          { key: "OPENCLAW_GATEWAY_TOKEN", value: token },
          { key: "OPENCLAW_GATEWAY_BIND", value: "remote" },
          { key: "OPENCLAW_GATEWAY_PORT", value: "18789" },
        ],
        disk: {
          name: `tenant-${tenantId}-disk`,
          mountPath: `/tenants/${tenantId}`,
          sizeGB: 1,
        },
      },
      plan: "starter",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Render API error ${res.status} on provisionTenant: ${body}`
    );
  }

  const data = (await res.json()) as { service: { id: string } };
  const serviceId = data.service.id;

  return {
    serviceId,
    wsEndpoint: `wss://openclaw-gateway-${tenantId}.onrender.com`,
    status: "provisioning",
  };
}

export async function startTenant(serviceId: string): Promise<void> {
  const res = await fetch(`${RENDER_API}/services/${serviceId}/resume`, {
    method: "POST",
    headers: headers(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Render API error ${res.status} on startTenant: ${body}`);
  }
}

export async function stopTenant(serviceId: string): Promise<void> {
  const res = await fetch(`${RENDER_API}/services/${serviceId}/suspend`, {
    method: "POST",
    headers: headers(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Render API error ${res.status} on stopTenant: ${body}`);
  }
}

export async function destroyTenant(serviceId: string): Promise<void> {
  const res = await fetch(`${RENDER_API}/services/${serviceId}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(
      `Render API error ${res.status} on destroyTenant: ${body}`
    );
  }
}

export async function getServiceStatus(serviceId: string): Promise<string> {
  const res = await fetch(`${RENDER_API}/services/${serviceId}`, {
    headers: headers(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Render API error ${res.status} on getStatus: ${body}`);
  }
  const data = (await res.json()) as {
    service: { suspended: string; state?: string };
  };
  if (data.service.suspended === "suspended") return "stopped";
  if (data.service.state === "available") return "running";
  return "provisioning";
}
