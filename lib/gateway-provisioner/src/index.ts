const RENDER_API = "https://api.render.com/v1";
const GATEWAY_IMAGE = "docker.io/cloudlookup/openclaw:latest";
const GATEWAY_MOUNT_PATH = "/home/node/.openclaw";

function renderHeaders(): Record<string, string> {
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
  const owner = ownerId();
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  const serviceName = `openclaw-gateway-${tenantId}`;

  const body = {
    type: "private_service",
    name: serviceName,
    ownerId: owner,
    image: {
      imagePath: GATEWAY_IMAGE,
      ownerId: owner,
    },
    serviceDetails: {
      runtime: "image",
      region: "oregon",
      envVars: [
        { key: "OPENCLAW_GATEWAY_TOKEN", value: token },
        { key: "ANTHROPIC_API_KEY", value: anthropicKey },
        { key: "NODE_ENV", value: "production" },
      ],
      disk: {
        name: `tenant-${tenantId}-disk`,
        mountPath: GATEWAY_MOUNT_PATH,
        sizeGB: 1,
      },
    },
    plan: "starter",
  };

  const res = await fetch(`${RENDER_API}/services`, {
    method: "POST",
    headers: renderHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Render API error ${res.status} on provisionTenant: ${text}`
    );
  }

  const data = (await res.json()) as { service: { id: string } };
  const serviceId = data.service.id;

  return {
    serviceId,
    wsEndpoint: `wss://${serviceName}.onrender.com`,
    status: "provisioning",
  };
}

export async function startTenant(serviceId: string): Promise<void> {
  const res = await fetch(`${RENDER_API}/services/${serviceId}/resume`, {
    method: "POST",
    headers: renderHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Render API error ${res.status} on startTenant: ${text}`);
  }
}

export async function stopTenant(serviceId: string): Promise<void> {
  const res = await fetch(`${RENDER_API}/services/${serviceId}/suspend`, {
    method: "POST",
    headers: renderHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Render API error ${res.status} on stopTenant: ${text}`);
  }
}

export async function destroyTenant(serviceId: string): Promise<void> {
  const res = await fetch(`${RENDER_API}/services/${serviceId}`, {
    method: "DELETE",
    headers: renderHeaders(),
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(
      `Render API error ${res.status} on destroyTenant: ${text}`
    );
  }
}

export async function getServiceStatus(serviceId: string): Promise<string> {
  const res = await fetch(`${RENDER_API}/services/${serviceId}`, {
    headers: renderHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Render API error ${res.status} on getStatus: ${text}`);
  }
  const data = (await res.json()) as {
    service: { suspended: string; state?: string };
  };
  if (data.service.suspended === "suspended") return "stopped";
  if (data.service.state === "available") return "running";
  return "provisioning";
}
