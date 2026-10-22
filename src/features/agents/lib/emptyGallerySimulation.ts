/**
 * Dev-only switch that simulates an empty agents gallery so the onboarding
 * empty state can be inspected without deleting real agents.
 *
 * Enable from the devtools console:
 *   localStorage.setItem("flock:dev:emptyAgentsGallery", "1")
 * Disable:
 *   localStorage.removeItem("flock:dev:emptyAgentsGallery")
 *
 * Has no effect in production builds.
 */
const EMPTY_AGENTS_GALLERY_SIMULATION_KEY = "flock:dev:emptyAgentsGallery";

export function isEmptyAgentsGallerySimulated(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }

  try {
    return (
      window.localStorage.getItem(EMPTY_AGENTS_GALLERY_SIMULATION_KEY) != null
    );
  } catch {
    return false;
  }
}
