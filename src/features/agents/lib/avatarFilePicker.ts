const AVATAR_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

export async function pickAgentAvatarImagePath(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [
      {
        name: "Images",
        extensions: AVATAR_IMAGE_EXTENSIONS,
      },
    ],
  });

  if (Array.isArray(selected)) {
    return typeof selected[0] === "string" ? selected[0] : null;
  }
  return typeof selected === "string" ? selected : null;
}
