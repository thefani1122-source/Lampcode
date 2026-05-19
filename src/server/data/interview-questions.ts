import type { InterviewQuestion } from "../types/interview.js";

export const INTERVIEW_QUESTIONS: readonly InterviewQuestion[] = [
  {
    id: "q1",
    category: "target_audience",
    question: "App kiske liye ban rahi hai?",
    options: ["B2C", "B2B", "Internal Tool", "Marketplace", "Custom"],
  },
  {
    id: "q2",
    category: "user_roles",
    question: "User types kya hon ge?",
    options: [
      "Simple (single user type)",
      "Basic Split (Free/Paid)",
      "Role Based (Admin/User)",
      "Role Based (Admin/Editor/Viewer)",
      "Complex (multiple roles + permissions)",
      "Custom",
    ],
  },
  {
    id: "q3",
    category: "data_isolation",
    question: "Data isolation kaise hogi?",
    options: [
      "Private (sirf apna data)",
      "Team Shared (team members share data)",
      "Mixed (private + shared)",
      "Public + Private (kuch public, kuch private)",
      "Fully Public",
      "Custom",
    ],
  },
  {
    id: "q4",
    category: "payments",
    question: "Payments involved hain?",
    options: [
      "Nahi (free app)",
      "One-time Payment",
      "Subscription (monthly/yearly)",
      "Marketplace (buyers & sellers)",
      "Custom",
    ],
  },
  {
    id: "q5",
    category: "sensitive_data",
    question: "Personal/Sensitive data store hoga?",
    options: [
      "Nahi",
      "Basic Personal (name, email)",
      "Sensitive (ID numbers, addresses)",
      "Financial (card/bank info)",
      "Health/Medical",
      "Custom",
    ],
  },
  {
    id: "q6",
    category: "scale",
    question: "App ki expected scale?",
    options: [
      "Personal/MVP (< 100 users)",
      "Small Launch (100 – 1,000 users)",
      "Public Launch (1,000 – 10,000 users)",
      "Scale (10,000+ users)",
      "Custom",
    ],
  },
  {
    id: "q7",
    category: "integrations",
    question: "Third party integrations chahiye?",
    options: [
      "Koi nahi",
      "Email (SendGrid / Resend)",
      "Auth (Google / GitHub OAuth)",
      "Storage (S3 / Cloudinary)",
      "AI (OpenAI / Anthropic)",
      "Analytics (Mixpanel / PostHog)",
      "Custom",
    ],
  },
] as const;

export const TOTAL_QUESTIONS = INTERVIEW_QUESTIONS.length;
