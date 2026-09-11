#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const IDENTIFIER_PREFIX = "xyz.block.berd.e2e.";
const RUN_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9]{32,128}$/;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (!argument.startsWith("--")) fail(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (
      ![
        "run-root",
        "run-id",
        "driver-token",
        "config-name",
        "runtime-config",
      ].includes(name)
    ) {
      fail(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function usage() {
  return `Usage: node scripts/e2e-run-contract.mjs --run-root <absolute-path> [options]

Produces the cross-platform isolated Berd E2E environment and Tauri identifier overlay.

Options:
  --run-id <id>          Defaults to the run-root basename
  --driver-token <token> Defaults to a random 64-character token
  --config-name <name>       Defaults to tauri-e2e.config.json
  --runtime-config <path>    Non-secret runtime config copied under the run root
  --help                     Show this help`;
}

function createContract(options) {
  if (!options["run-root"]) fail("--run-root is required");
  const runRoot = path.resolve(options["run-root"]);
  if (!path.isAbsolute(options["run-root"])) {
    fail("--run-root must be an absolute path");
  }

  const runId = options["run-id"] ?? path.basename(runRoot);
  if (!RUN_ID_PATTERN.test(runId)) {
    fail("run ID must be 1-64 ASCII letters, digits, or '-'");
  }
  if (path.basename(runRoot) !== runId) {
    fail(`run root must end with run ID '${runId}'`);
  }

  const driverToken =
    options["driver-token"] ?? randomBytes(32).toString("hex");
  if (!TOKEN_PATTERN.test(driverToken)) {
    fail("driver token must be 32-128 ASCII letters or digits");
  }

  const configName = options["config-name"] ?? "tauri-e2e.config.json";
  if (
    path.basename(configName) !== configName ||
    !configName.endsWith(".json")
  ) {
    fail("config name must be a JSON filename without directory components");
  }

  let runtimeConfig;
  if (options["runtime-config"]) {
    if (!path.isAbsolute(options["runtime-config"])) {
      fail("runtime config must be an absolute path");
    }
    runtimeConfig = path.resolve(options["runtime-config"]);
  }

  return {
    runRoot,
    runId,
    identifier: `${IDENTIFIER_PREFIX}${runId}`,
    driverToken,
    readyFile: path.join(runRoot, "app-test-driver.json"),
    configPath: path.join(runRoot, configName),
    runtimeConfig,
  };
}

async function writeContract(contract) {
  await mkdir(contract.runRoot, { recursive: true });
  const config = {
    identifier: contract.identifier,
    productName: `Berd E2E (${contract.runId})`,
  };
  await writeFile(contract.configPath, `${JSON.stringify(config, null, 2)}\n`, {
    flag: "wx",
  });

  let runtimeConfigPath;
  if (contract.runtimeConfig) {
    runtimeConfigPath = path.join(contract.runRoot, "runtime-config.json");
    const contents = await readFile(contract.runtimeConfig, "utf8");
    JSON.parse(contents);
    await writeFile(runtimeConfigPath, contents, { flag: "wx", mode: 0o600 });
  }

  return {
    BERD_E2E_MODE: "1",
    BERD_E2E_RUN_ROOT: contract.runRoot,
    BERD_E2E_RUN_ID: contract.runId,
    APP_TEST_DRIVER_TOKEN: contract.driverToken,
    TAURI_E2E_CONFIG: contract.configPath,
    APP_TEST_DRIVER_READY_FILE: contract.readyFile,
    ...(runtimeConfigPath
      ? { BERD_E2E_RUNTIME_CONFIG: runtimeConfigPath }
      : {}),
  };
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}

try {
  console.log(JSON.stringify(await writeContract(createContract(options))));
} catch (error) {
  console.error(`e2e-run-contract: ${error.message}`);
  process.exit(1);
}
