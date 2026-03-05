import { z } from "zod/v4";
import { AgentConfigSchema } from "./agent";
import { SkillConfigSchema } from "./skill";
import { SettingsConfigSchema } from "./settings";

// ---------------------------------------------------------------------------
// Remote Server Configuration
// ---------------------------------------------------------------------------

export const RemoteConfigSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535),
  /** Bind to 0.0.0.0 (true) or 127.0.0.1 (false) */
  exposeOnNetwork: z.boolean(),
  /** Token expiry in hours (default 24) */
  tokenExpiryHours: z.number().int().min(1),
  /** Max concurrent remote sessions */
  maxSessions: z.number().int().min(1).max(10),
  /** Allow remote clients to make edits (false = read-only monitoring) */
  allowEdits: z.boolean(),
  /** Auto-stop server after N minutes of inactivity (0 = never) */
  idleTimeoutMinutes: z.number().int().min(0),
});

export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;

export const REMOTE_CONFIG_DEFAULTS: RemoteConfig = {
  enabled: false,
  port: 5175,
  exposeOnNetwork: false,
  tokenExpiryHours: 24,
  maxSessions: 3,
  allowEdits: true,
  idleTimeoutMinutes: 0,
};

// ---------------------------------------------------------------------------
// Authentication Types
// ---------------------------------------------------------------------------

export interface AuthSession {
  sessionId: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  lastActivity: number;
  remoteAddress: string;
  readOnly: boolean;
}

// ---------------------------------------------------------------------------
// REST Endpoint Types
// ---------------------------------------------------------------------------

/** GET /api/health */
export interface HealthResponse {
  status: "ok";
  appVersion: string;
  projectName: string;
  remoteSessions: number;
  maxSessions: number;
}

/** GET /api/auth/qr — data encoded in the QR code */
export interface QrCodeData {
  host: string;
  port: number;
  token: string;
  /** Protocol version for future compat */
  v: 1;
}

/** POST /api/auth/token — request body */
export const TokenAuthRequestSchema = z.object({
  token: z.string().min(1),
});

export type TokenAuthRequest = z.infer<typeof TokenAuthRequestSchema>;

/** POST /api/auth/token — response */
export interface TokenAuthResponse {
  ok: boolean;
  sessionId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Shared Zod Primitives (mirror existing interfaces for wire validation)
// ---------------------------------------------------------------------------

export const NodeKindSchema = z.enum([
  "human", "agent", "skill", "context", "settings", "group", "pipeline", "note",
]);

export const VariableKindSchema = z.enum(["text", "api-key", "password", "note"]);

const NodeVariableSchema = z.object({
  name: z.string(),
  value: z.string(),
  type: VariableKindSchema,
});

/** Variable with sensitive values masked (e.g., "****xxxx" for api-key/password) */
export const RedactedNodeVariableSchema = z.object({
  name: z.string(),
  value: z.string(),
  type: VariableKindSchema,
  redacted: z.boolean(),
});

export type RedactedNodeVariable = z.infer<typeof RedactedNodeVariableSchema>;

const PipelineStepSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  prompt: z.string(),
});

const NodeConfigSchema = z.union([
  AgentConfigSchema,
  SkillConfigSchema,
  SettingsConfigSchema,
]).nullable();

// ---------------------------------------------------------------------------
// Remote Node — serializable AuiNode for the wire
//
// Omits `sourcePath` to avoid leaking filesystem paths.
// Variables with type "api-key" or "password" have values replaced with
// "********" unless the session has elevated access.
// ---------------------------------------------------------------------------

export const RemoteNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: NodeKindSchema,
  parentId: z.string().nullable(),
  team: z.string().nullable(),
  config: NodeConfigSchema,
  promptBody: z.string(),
  tags: z.array(z.string()),
  lastModified: z.number(),
  validationErrors: z.array(z.string()),
  assignedSkills: z.array(z.string()),
  variables: z.array(NodeVariableSchema),
  launchPrompt: z.string(),
  pipelineSteps: z.array(PipelineStepSchema),
});

export type RemoteNode = z.infer<typeof RemoteNodeSchema>;

// ---------------------------------------------------------------------------
// Redacted Remote Node — what the API actually sends to remote clients.
// Sensitive variable values are masked; a `redacted` flag marks them.
// ---------------------------------------------------------------------------

export const RedactedRemoteNodeSchema = RemoteNodeSchema.extend({
  variables: z.array(RedactedNodeVariableSchema),
});

export type RedactedRemoteNode = z.infer<typeof RedactedRemoteNodeSchema>;

/** Redact sensitive variable values in a node for remote transmission */
export function redactNode(node: RemoteNode): RedactedRemoteNode {
  return {
    ...node,
    variables: node.variables.map((v) => {
      if (v.type === "api-key" || v.type === "password") {
        const lastFour = v.value.length > 4 ? v.value.slice(-4) : "";
        return { ...v, value: `****${lastFour}`, redacted: true };
      }
      return { ...v, redacted: false };
    }),
  };
}

// ---------------------------------------------------------------------------
// Tree Metadata for full_sync (mirrors TreeMetadata minus file-only fields)
// ---------------------------------------------------------------------------

export interface RemoteTreeMetadata {
  owner: { name: string; description: string };
  hierarchy: Record<string, string | null>;
  positions: Record<string, { x: number; y: number }>;
  groups?: Array<{
    id: string;
    name: string;
    description: string;
    parentId: string | null;
    team: string | null;
    assignedSkills: string[];
    launchPrompt: string;
    kind?: "group" | "pipeline";
  }>;
  lastModified: number;
  skillNameCache?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// WebSocket Envelope — shared by ALL messages in both directions
// ---------------------------------------------------------------------------

export const RemoteMessageSchema = z.object({
  type: z.string(),
  id: z.string(),
  payload: z.unknown(),
  timestamp: z.number(),
});

export type RemoteMessage = z.infer<typeof RemoteMessageSchema>;

// ---------------------------------------------------------------------------
// Client -> Server Command Payloads (Zod schemas for input validation)
// ---------------------------------------------------------------------------

export const AuthPayloadSchema = z.object({
  token: z.string().min(1),
});

export const GetTreePayloadSchema = z.object({});

export const GetNodePayloadSchema = z.object({
  id: z.string(),
});

export const UpdateNodePayloadSchema = z.object({
  id: z.string(),
  /** Client must send the node's lastModified timestamp it last saw; server rejects on mismatch */
  expectedLastModified: z.number(),
  updates: z.object({
    name: z.string().optional(),
    promptBody: z.string().optional(),
    tags: z.array(z.string()).optional(),
    variables: z.array(NodeVariableSchema).optional(),
    launchPrompt: z.string().optional(),
    config: NodeConfigSchema.optional(),
  }),
});

export const ReparentNodePayloadSchema = z.object({
  id: z.string(),
  newParentId: z.string().nullable(),
});

export const AddNodePayloadSchema = z.object({
  name: z.string().min(1),
  kind: NodeKindSchema,
  parentId: z.string().nullable(),
  config: NodeConfigSchema.optional(),
  promptBody: z.string().optional(),
  tags: z.array(z.string()).optional(),
  variables: z.array(NodeVariableSchema).optional(),
  launchPrompt: z.string().optional(),
});

export const RemoveNodePayloadSchema = z.object({
  id: z.string(),
});

export const DeployPipelinePayloadSchema = z.object({
  id: z.string(),
});

export const PingPayloadSchema = z.object({});

/** Map of client command types to their Zod payload schemas */
export const ClientCommandSchemas = {
  auth: AuthPayloadSchema,
  get_tree: GetTreePayloadSchema,
  get_node: GetNodePayloadSchema,
  update_node: UpdateNodePayloadSchema,
  reparent_node: ReparentNodePayloadSchema,
  add_node: AddNodePayloadSchema,
  remove_node: RemoveNodePayloadSchema,
  deploy_pipeline: DeployPipelinePayloadSchema,
  ping: PingPayloadSchema,
} as const;

export type ClientCommandType = keyof typeof ClientCommandSchemas;

// Inferred payload types for each command
export type AuthPayload = z.infer<typeof AuthPayloadSchema>;
export type GetTreePayload = z.infer<typeof GetTreePayloadSchema>;
export type GetNodePayload = z.infer<typeof GetNodePayloadSchema>;
export type UpdateNodePayload = z.infer<typeof UpdateNodePayloadSchema>;
export type ReparentNodePayload = z.infer<typeof ReparentNodePayloadSchema>;
export type AddNodePayload = z.infer<typeof AddNodePayloadSchema>;
export type RemoveNodePayload = z.infer<typeof RemoveNodePayloadSchema>;
export type DeployPipelinePayload = z.infer<typeof DeployPipelinePayloadSchema>;
export type PingPayload = z.infer<typeof PingPayloadSchema>;

// ---------------------------------------------------------------------------
// Server -> Client Event Payloads
// ---------------------------------------------------------------------------

export interface AuthOkPayload {
  sessionId: string;
  readOnly: boolean;
}

export interface AuthFailPayload {
  reason: string;
}

export interface FullSyncPayload {
  nodes: RedactedRemoteNode[];
  metadata: RemoteTreeMetadata;
}

export interface NodeUpdatedPayload {
  id: string;
  node: RedactedRemoteNode;
}

export interface NodeAddedPayload {
  node: RedactedRemoteNode;
}

export interface NodeRemovedPayload {
  id: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface PongPayload {
  serverTime: number;
}

export type ServerEventType =
  | "auth_ok"
  | "auth_fail"
  | "full_sync"
  | "node_updated"
  | "node_added"
  | "node_removed"
  | "error"
  | "pong";

/** Map of server event types to their payload shapes */
export interface ServerEventPayloads {
  auth_ok: AuthOkPayload;
  auth_fail: AuthFailPayload;
  full_sync: FullSyncPayload;
  node_updated: NodeUpdatedPayload;
  node_added: NodeAddedPayload;
  node_removed: NodeRemovedPayload;
  error: ErrorPayload;
  pong: PongPayload;
}

// ---------------------------------------------------------------------------
// Error Codes
// ---------------------------------------------------------------------------

export type RemoteErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_FAILED"
  | "AUTH_EXPIRED"
  | "SESSION_LIMIT"
  | "RATE_LIMITED"
  | "READ_ONLY"
  | "NOT_FOUND"
  | "INVALID_PAYLOAD"
  | "VERSION_CONFLICT"
  | "INTERNAL_ERROR";

// ---------------------------------------------------------------------------
// Audit Log Entry
// ---------------------------------------------------------------------------

export interface AuditLogEntry {
  timestamp: number;
  sessionId: string;
  remoteAddress: string;
  commandType: ClientCommandType;
  targetNodeId?: string;
  success: boolean;
  errorCode?: RemoteErrorCode;
}

// ---------------------------------------------------------------------------
// Typed Message Helpers (for building RemoteMessage instances)
// ---------------------------------------------------------------------------

/** Build a client -> server command message */
export function buildClientMessage(
  type: ClientCommandType,
  id: string,
  payload: unknown,
): RemoteMessage {
  return { type, id, payload, timestamp: Date.now() };
}

/** Build a server -> client event message */
export function buildServerMessage<K extends ServerEventType>(
  type: K,
  id: string,
  payload: ServerEventPayloads[K],
): RemoteMessage {
  return { type, id, payload, timestamp: Date.now() };
}
