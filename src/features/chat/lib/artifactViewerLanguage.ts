import type { BundledLanguage } from "shiki";
import { artifactBasename, fileExtension } from "./artifactViewerTypes";

const EXTENSION_LANGUAGES: Record<string, BundledLanguage> = {
  ".bash": "bash",
  ".bat": "bat",
  ".c": "c",
  ".cc": "cpp",
  ".cmake": "cmake",
  ".cmd": "bat",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".csv": "csv",
  ".cxx": "cpp",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".fs": "fsharp",
  ".go": "go",
  ".graphql": "graphql",
  ".h": "c",
  ".hpp": "cpp",
  ".hs": "haskell",
  ".html": "html",
  ".htm": "html",
  ".ini": "ini",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsonc": "jsonc",
  ".jsx": "jsx",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".less": "less",
  ".lua": "lua",
  ".m": "objective-c",
  ".md": "markdown",
  ".mdx": "mdx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mm": "objective-cpp",
  ".php": "php",
  ".pl": "perl",
  ".pm": "perl",
  ".proto": "proto",
  ".ps1": "powershell",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".scss": "scss",
  ".sh": "bash",
  ".sql": "sql",
  ".svelte": "svelte",
  ".swift": "swift",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".txt": "plaintext",
  ".vue": "vue",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zsh": "bash",
};

const BASENAME_LANGUAGES: Record<string, BundledLanguage> = {
  ".dockerignore": "docker",
  ".editorconfig": "ini",
  ".env": "dotenv",
  ".gitattributes": "git-commit",
  ".gitignore": "gitignore",
  ".npmrc": "ini",
  cmakelists: "cmake",
  dockerfile: "dockerfile",
  gemfile: "ruby",
  justfile: "make",
  makefile: "make",
};

const DEFAULT_LANGUAGE: BundledLanguage = "plaintext";

/** Shiki language id used to highlight a path in the in-app file viewer. */
export function codeLanguageForPath(path: string): BundledLanguage {
  const ext = fileExtension(path);
  if (ext && ext in EXTENSION_LANGUAGES) {
    return EXTENSION_LANGUAGES[ext] ?? DEFAULT_LANGUAGE;
  }

  const name = artifactBasename(path).toLowerCase();
  if (name in BASENAME_LANGUAGES) {
    return BASENAME_LANGUAGES[name] ?? DEFAULT_LANGUAGE;
  }
  if (name.startsWith(".env.")) {
    return "dotenv";
  }
  if (name.endsWith("makefile") || name.endsWith("justfile")) {
    return "make";
  }
  if (name.startsWith("dockerfile")) {
    return "dockerfile";
  }

  return DEFAULT_LANGUAGE;
}
