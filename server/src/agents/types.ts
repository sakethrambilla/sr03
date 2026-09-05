// The provider boundary. Native SDK and ACP messages are normalized here before the session
// runtime persists them or publishes the existing client-facing events.
import type {
  ApprovalDecision,
  Effort,
  ModelOption,
  PendingApproval,
  PendingQuestion,
  PermissionMode,
  ProviderId,
  SlashCommand,
  Thread,
  ThreadPhase,
  ThreadTask,
  Usage,
} from "../types.ts";

export type AgentEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "turn.active" }
  | { type: "phase"; phase: ThreadPhase | null; taskId?: string }
  | { type: "assistant.delta"; text: string; taskId?: string }
  | { type: "assistant.complete"; text: string; taskId?: string }
  | {
      type: "tool.started";
      callId: string;
      name: string;
      input: unknown;
      mutatesFiles?: boolean;
      taskId?: string;
    }
  | { type: "tool.completed"; callId: string; result: string; isError: boolean; taskId?: string }
  | { type: "approval.requested"; approval: PendingApproval }
  | { type: "question.requested"; question: PendingQuestion }
  | { type: "notice"; text: string }
  | { type: "commands.changed"; commands: SlashCommand[] }
  | { type: "tasks.changed"; tasks: ThreadTask[] }
  | { type: "usage"; usage: Usage }
  | { type: "models.changed"; models: ModelOption[] }
  | { type: "turn.completed"; error?: string; errorCode?: string }
  | { type: "session.error"; message: string };

export type AgentEventSink = (event: AgentEvent) => void;

export interface AgentSettingsPatch {
  model?: string;
  permissionMode?: PermissionMode;
  effort?: Effort;
  fast?: boolean;
}

export interface AgentSession {
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  respondToApproval(id: string, decision: ApprovalDecision): Promise<boolean>;
  respondToQuestion(id: string, answers: Record<string, string[]>): Promise<boolean>;
  applySettings(patch: AgentSettingsPatch): Promise<"applied" | "restart">;
  close(): void;
}

export interface AgentProvider {
  id: ProviderId;
  open(thread: Thread, emit: AgentEventSink, signal: AbortSignal): Promise<AgentSession>;
  listCommands(cwd: string): Promise<SlashCommand[]>;
  readUsage(threadId: string | null): Promise<Usage>;
  forkSession?(sessionId: string, cwd: string): Promise<string>;
  forgetThread?(threadId: string): void;
}
