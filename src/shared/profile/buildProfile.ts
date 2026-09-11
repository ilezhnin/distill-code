export type BuildFeature = "securityMl";

/**
 * Product families backed by external services are positive opt-ins: a normal
 * build has no value for the variable and therefore cannot expose the path.
 */
function readBuildFeatures(): Record<BuildFeature, boolean> {
  return {
    securityMl: import.meta.env.VITE_SECURITY_ML === "1",
  };
}

export function getBuildFeatureState(): Record<BuildFeature, boolean> {
  return readBuildFeatures();
}
