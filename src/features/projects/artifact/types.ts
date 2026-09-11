export type ProjectArtifactMood =
  | "dormant"
  | "awakening"
  | "serene"
  | "active"
  | "energetic"
  | "contemplative";

export type ProjectArtifactContentMode =
  | "planes"
  | "sphere"
  | "cube"
  | "cubeStatic";

export interface ProjectArtifactInput {
  projectId?: string | null;
  name: string;
  prompt?: string | null;
  color?: string | null;
  workingDirs?: string[];
  sessionCount?: number;
  artifact?: ProjectArtifactMetadata | null;
}

export interface ProjectArtifactState {
  seed: number;
  name: string;
  accentColor: string;
  accentCssColor: string;
  mood: ProjectArtifactMood;
  moodIntensity: number;
  contentMode: ProjectArtifactContentMode;
}

export interface ProjectArtifactMetadata {
  seed: number;
  color: string;
  mood: ProjectArtifactMood;
  moodIntensity: number;
  contentMode: ProjectArtifactContentMode;
}

export type ProjectArtifactPinState = { projectId: string };
