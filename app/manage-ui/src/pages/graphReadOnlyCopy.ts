const COPY = {
  "outlook-calendar": {
    short: "plugins.graphAdapterShortDescription",
    description: "plugins.graphAdapterDescription",
    example: "plugins.graphAdapterExample",
    explanation: "plugins.graphAdapterExplanation",
    badge: "plugins.graphIndependentReadOnly",
  },
  "outlook-email": {
    short: "plugins.graphEmailShortDescription",
    description: "plugins.graphEmailDescription",
    example: "plugins.graphEmailExample",
    explanation: "plugins.graphEmailExplanation",
    badge: "plugins.graphFamilyIndependentReadOnly",
  },
  sharepoint: {
    short: "plugins.graphSharePointShortDescription",
    description: "plugins.graphSharePointDescription",
    example: "plugins.graphSharePointExample",
    explanation: "plugins.graphSharePointExplanation",
    badge: "plugins.graphFamilyIndependentReadOnly",
  },
  teams: {
    short: "plugins.graphTeamsShortDescription",
    description: "plugins.graphTeamsDescription",
    example: "plugins.graphTeamsExample",
    explanation: "plugins.graphTeamsExplanation",
    badge: "plugins.graphFamilyIndependentReadOnly",
  },
} as const;

export function graphReadOnlyCopy(id: string) {
  return COPY[id as keyof typeof COPY] || COPY["outlook-calendar"];
}
