import { useMemo } from "react";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import type { RuntimeConfig } from "@/shared/runtime-config/schema";

export type ProfileCapabilityId = "doctor";

type CapabilitySource = { kind: "runtimeConfigSection"; field: "doctor" };

export type ProfileCapabilityRegistry = Record<
  ProfileCapabilityId,
  CapabilitySource
>;

export const PROFILE_CAPABILITY_REGISTRY: ProfileCapabilityRegistry = {
  doctor: { kind: "runtimeConfigSection", field: "doctor" },
};

export type ProfileCapabilityState = Record<ProfileCapabilityId, boolean>;

interface ResolveProfileCapabilitiesInput {
  runtimeConfig?: RuntimeConfig | null;
  runtimeConfigLoaded?: boolean;
}

export function resolveProfileCapabilities({
  runtimeConfig,
  runtimeConfigLoaded = true,
}: ResolveProfileCapabilitiesInput): ProfileCapabilityState {
  const capabilities = {} as ProfileCapabilityState;
  const runtimeConfigReady = runtimeConfigLoaded && runtimeConfig != null;

  for (const id of Object.keys(
    PROFILE_CAPABILITY_REGISTRY,
  ) as ProfileCapabilityId[]) {
    const source = PROFILE_CAPABILITY_REGISTRY[id];
    capabilities[id] =
      !runtimeConfigReady || runtimeConfig[source.field]?.enabled !== false;
  }

  return capabilities;
}

export function useProfileCapabilities(): ProfileCapabilityState {
  const runtimeConfig = useRuntimeConfigStore((state) => state.config);
  const runtimeConfigLoaded = useRuntimeConfigStore((state) => state.loaded);

  return useMemo(
    () =>
      resolveProfileCapabilities({
        runtimeConfig,
        runtimeConfigLoaded,
      }),
    [runtimeConfig, runtimeConfigLoaded],
  );
}

export function useProfileCapability(id: ProfileCapabilityId): boolean {
  return useProfileCapabilities()[id];
}
