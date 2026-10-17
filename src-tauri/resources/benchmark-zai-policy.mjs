// The Z.ai benchmark policy for OpenCode 1.18.35, loaded as a plugin from
// OPENCODE_CONFIG_CONTENT with the profile's prompt as its option. OpenCode
// appends its environment block, instructions and skill list to an agent's
// prompt; the profile's own requests carry that prompt alone. Requests of
// other agents (compaction) start with their own prompt and keep it.
export const DistillBenchmarkPolicy = async (_input, options) => {
  const prompt = typeof options?.prompt === "string" ? options.prompt : "";
  if (!prompt) throw new Error("The Distill benchmark policy needs its prompt");
  return {
    "experimental.chat.system.transform": async (_request, output) => {
      const first = output.system[0];
      if (typeof first === "string" && first.startsWith(prompt))
        output.system.splice(0, output.system.length, prompt);
    },
  };
};
