import { httpCall } from "../http.js";
import { McpError, type IProvider, type IntegrationCredentials } from "../types.js";

const GQL = "https://backboard.railway.app/graphql/v2";

export class RailwayProvider implements IProvider {
  readonly name = "railway" as const;

  async testConnection(
    creds: IntegrationCredentials,
  ): Promise<{ ok: boolean; latencyMs: number; detail?: string | undefined }> {
    const token = creds.token ?? creds.apiKey;
    if (!token) return { ok: false, latencyMs: 0, detail: "No token provided" };

    const t0 = Date.now();
    try {
      const res = await this.gql(token, `{ me { id email } }`);
      const data = res as { data?: { me?: { email?: string } } };
      return {
        ok: true,
        latencyMs: Date.now() - t0,
        detail: data.data?.me?.email,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        detail: err instanceof McpError ? err.message : "Unknown error",
      };
    }
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    creds: IntegrationCredentials,
  ): Promise<Record<string, unknown>> {
    const token = creds.token ?? creds.apiKey;
    if (!token) throw new McpError("AUTH_FAILED", "No Railway token in credentials");

    switch (toolName) {
      case "deploy":     return this.deploy(args, token, creds);
      case "setEnvVars": return this.setEnvVars(args, token, creds);
      case "getService": return this.getService(args, token);
      default: throw new McpError("TOOL_NOT_FOUND", `Unknown Railway tool: ${toolName}`);
    }
  }

  private async deploy(
    args: Record<string, unknown>,
    token: string,
    creds: IntegrationCredentials,
  ): Promise<Record<string, unknown>> {
    const serviceId = (args["serviceId"] as string | undefined) ?? creds.serviceId ?? "";
    const environmentId = (args["environmentId"] as string | undefined) ?? "";

    const mutation = `
      mutation ServiceInstanceDeploy($serviceId: String!, $environmentId: String!) {
        serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId)
      }
    `;
    const res = await this.gql(token, mutation, { serviceId, environmentId });
    const data = res as { data?: { serviceInstanceDeploy?: boolean }; errors?: unknown[] };
    if (data.errors) {
      throw new McpError("PROVIDER_ERROR", `GraphQL errors: ${JSON.stringify(data.errors)}`);
    }
    return { deployed: data.data?.serviceInstanceDeploy ?? false, serviceId };
  }

  private async setEnvVars(
    args: Record<string, unknown>,
    token: string,
    creds: IntegrationCredentials,
  ): Promise<Record<string, unknown>> {
    const serviceId = (args["serviceId"] as string | undefined) ?? creds.serviceId ?? "";
    const environmentId = (args["environmentId"] as string | undefined) ?? "";
    const envVars = (args["envVars"] as Record<string, string> | undefined) ?? {};

    const variables: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(envVars)) {
      variables[key] = value;
    }

    const mutation = `
      mutation VariableCollectionUpsert($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }
    `;
    const res = await this.gql(token, mutation, {
      input: { projectId: "", serviceId, environmentId, variables },
    });
    const data = res as { errors?: unknown[] };
    if (data.errors) {
      throw new McpError("PROVIDER_ERROR", `GraphQL errors: ${JSON.stringify(data.errors)}`);
    }
    return { set: Object.keys(envVars).length, serviceId };
  }

  private async getService(
    args: Record<string, unknown>,
    token: string,
  ): Promise<Record<string, unknown>> {
    const serviceId = (args["serviceId"] as string | undefined) ?? "";
    const query = `
      query Service($id: String!) {
        service(id: $id) { id name updatedAt }
      }
    `;
    const res = await this.gql(token, query, { id: serviceId });
    const data = res as { data?: { service?: { id?: string; name?: string; updatedAt?: string } } };
    const svc = data.data?.service ?? {};
    return { id: svc.id ?? "", name: svc.name ?? "", updatedAt: svc.updatedAt ?? "" };
  }

  private async gql(
    token: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await httpCall(GQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, ...(variables !== undefined ? { variables } : {}) }),
    });
    return res.data;
  }

  cliCommands(toolName: string, args: Record<string, unknown>): string[] {
    switch (toolName) {
      case "deploy":
        return [
          `railway link ${(args["serviceId"] as string | undefined) ?? "<service-id>"}`,
          `railway up --detach`,
        ];
      case "setEnvVars": {
        const vars = (args["envVars"] as Record<string, string> | undefined) ?? {};
        const setCmd = Object.entries(vars)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        return setCmd ? [`railway variables set ${setCmd}`] : ["# No variables to set"];
      }
      case "getService":
        return [`railway status`];
      default:
        return [`# Unknown Railway tool: ${toolName}`];
    }
  }
}
