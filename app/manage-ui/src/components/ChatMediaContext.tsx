import { createContext } from "react";
import type { AgentMediaContext } from "../lib/agentMedia";

export const ChatMediaContext = createContext<AgentMediaContext | undefined>(undefined);
