export type ExperimentConfigValue = boolean | number | string;

export type ExperimentConfigControl =
  | {
      type: "boolean";
      labelKey: string;
      descriptionKey?: string;
      defaultValue: boolean;
    }
  | {
      type: "select";
      labelKey: string;
      descriptionKey?: string;
      defaultValue: string;
      options: readonly {
        labelKey: string;
        value: string;
      }[];
    }
  | {
      type: "number";
      labelKey: string;
      descriptionKey?: string;
      defaultValue: number;
      min?: number;
      max?: number;
      step?: number;
    }
  | {
      type: "text";
      labelKey: string;
      descriptionKey?: string;
      defaultValue: string;
      placeholderKey?: string;
      multiline?: boolean;
    };

export interface ExperimentDefinition {
  id: string;
  titleKey: string;
  descriptionKey: string;
  /** Default state for users without an explicit per-experiment override. */
  defaultEnabled?: boolean;
  /** Opt-out of development's global experiment auto-enable behavior. */
  manualEnableOnly?: boolean;
  /** Limit this experiment's Settings controls without changing runtime state. */
  settingsVisibility?: "all" | "dev";
  config?: Record<string, ExperimentConfigControl>;
}

export const BUILDERBOT_SURFACE_EXPERIMENT_ID = "builderbot-surface";

export const VOICE_CONVERSATION_EXPERIMENT_ID = "voice-conversation";

export const TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID =
  "transcript-virtual-renderer";

export const SKILL_DISCOVERY_EXPERIMENT_ID = "skill-discovery";

export const RELATED_PULL_REQUESTS_EXPERIMENT_ID = "related-pull-requests";

export const MEMORY_WIKI_GRAPH_EXPERIMENT_ID = "memory-wiki-graph";
export const EXPERIMENT_DEFINITIONS = [
  {
    id: BUILDERBOT_SURFACE_EXPERIMENT_ID,
    titleKey: "experiments.builderbot.title",
    descriptionKey: "experiments.builderbot.description",
  },
  {
    id: TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID,
    titleKey: "experiments.transcriptVirtualRenderer.title",
    descriptionKey: "experiments.transcriptVirtualRenderer.description",
    defaultEnabled: true,
  },
  {
    id: SKILL_DISCOVERY_EXPERIMENT_ID,
    titleKey: "experiments.skillDiscovery.title",
    descriptionKey: "experiments.skillDiscovery.description",
    // Skill discovery is an opt-in surface because it requires the optional
    // sq-agents CLI and can make remote catalog requests.
    defaultEnabled: false,
  },
  {
    id: VOICE_CONVERSATION_EXPERIMENT_ID,
    titleKey: "experiments.voiceConversation.title",
    descriptionKey: "experiments.voiceConversation.description",
    defaultEnabled: true,
  },
  {
    id: RELATED_PULL_REQUESTS_EXPERIMENT_ID,
    titleKey: "experiments.relatedPullRequests.title",
    descriptionKey: "experiments.relatedPullRequests.description",
  },
  {
    id: MEMORY_WIKI_GRAPH_EXPERIMENT_ID,
    titleKey: "experiments.memoryWikiGraph.title",
    descriptionKey: "experiments.memoryWikiGraph.description",
    // Off unless asked for: the section reads every page of a project's wiki
    // off disk to draw one picture, and a wiki is a thing most projects do
    // not have yet.
    defaultEnabled: false,
  },
] as const satisfies readonly ExperimentDefinition[];
