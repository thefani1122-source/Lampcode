export type InterviewStatus =
  | "in_progress"
  | "generating_contract"
  | "awaiting_approval"
  | "approved"
  | "building";

export type TaskAgentType = "frontend" | "backend" | "database" | "security" | "deploy";
export type TaskStatus = "pending" | "in_progress" | "complete" | "failed";

export interface InterviewQuestion {
  id: string;
  question: string;
  options: string[];
  category: string;
}

export interface InterviewAnswer {
  questionId: string;
  selectedOption: string;
  customInput?: string | undefined;
}

export interface SecurityContract {
  appType: string;
  userRoles: string[];
  dataIsolation: string;
  payments: string;
  sensitiveData: string;
  scale: string;
  integrations: string[];
  mandatoryChecks: string[];
}

export interface TaskItem {
  id: string;
  agent: TaskAgentType;
  description: string;
  estimatedMinutes: number;
  dependencies: string[];
  status: TaskStatus;
}

export interface InterviewSession {
  id: string;
  projectId: string;
  userId: string;
  initialPrompt: string;
  currentQuestionIndex: number;
  answers: InterviewAnswer[];
  status: InterviewStatus;
  contract?: SecurityContract | undefined;
  tasks?: TaskItem[] | undefined;
  totalEstimatedMinutes?: number | undefined;
  createdAt: string;
  updatedAt: string;
}
