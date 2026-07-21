import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ConfigStore } from "../server/config.js";
import { EventBus } from "../server/event-bus.js";
import {
  probeEngineCapabilities,
  RuntimeManager
} from "../server/runtime.js";

const execFileAsync = promisify(execFile);

interface RuntimeBridgeInternals {
  engineBinary(directory: string): Promise<string | null>;
  binaryHasExpertMajorV2Runtime(directory: string): Promise<boolean>;
  recordBuildHead(directory: string, binaryName: "hebrus-server" | "ds4-server"): Promise<void>;
  buildStampPath(directory: string): string;
  buildMatchesHead(directory: string): Promise<boolean>;
}

function structuredExecutable(engineId: "ds4" | "hebrus"): string {
  return `#!/bin/sh
if [ "$1" = "--capabilities=json" ]; then
  revision="$(git rev-parse --short=12 HEAD)"
  printf '{"schema_version":1,"engine_id":"${engineId}","build_git_sha":"%s","backend":"metal","executable_role":"server","model_families":["deepseek4","glm-dsa","qwen35moe"],"expert_major":{"version":2,"tensor":"ds4.expert_major.v2","storage_formats":[{"id":"ggml","wire_value":0,"group_sizes":[]},{"id":"mlx-affine4","wire_value":1,"group_sizes":[64]}]}}\\n' "$revision"
  exit 0
fi
exit 2
`;
}

function legacyExecutable(): string {
  return `#!/bin/sh
# ds4.expert_major.v2
# Qwen inference requires a DS4 ExpertMajor v2 GGUF
# Qwen requires ExpertMajor v2 MLX affine4/group-64 payload
# DeepSeek inference requires a DS4 ExpertMajor v2 GGUF
# GLM inference requires a DS4 ExpertMajor v2 GGUF
# embedded expert-major store active
printf '%s\\n' 'engine: unknown option: --capabilities=json' >&2
exit 2
`;
}

async function runtimeFixture(): Promise<{
  root: string;
  repository: string;
  stateHome: string;
  hebrusBinary: string;
  ds4Binary: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "dsbox-runtime-bridge-"));
  const repository = path.join(root, "checkout");
  const stateHome = path.join(root, "state");
  await mkdir(repository, { recursive: true });
  await writeFile(path.join(repository, ".gitignore"), "/hebrus-server\n/ds4-server\n");
  await writeFile(path.join(repository, "Makefile"), "ds4-server hebrus-server:\n\t@true\n");
  await writeFile(path.join(repository, "ds4_expert_store.h"), [
    '#define DS4_EXPERT_STORE_V2_TENSOR "ds4.expert_major.v2"',
    "DS4_EXPERT_STORE_FAMILY_DEEPSEEK4",
    "DS4_EXPERT_STORE_FAMILY_GLM_DSA",
    "DS4_EXPERT_STORE_FAMILY_QWEN35_MOE",
    "DS4_EXPERT_STORE_STORAGE_MLX_AFFINE4"
  ].join("\n"));
  await writeFile(path.join(repository, "ds4.c"), [
    "model_expand_deepseek4_native_expert_store",
    "model_expand_glm_native_expert_store",
    "model_expand_qwen35_expert_store_v2",
    "Qwen requires ExpertMajor v2 MLX affine4/group-64 payload",
    "Qwen inference requires a DS4 ExpertMajor v2 GGUF",
    "DeepSeek inference requires a DS4 ExpertMajor v2 GGUF",
    "GLM inference requires a DS4 ExpertMajor v2 GGUF"
  ].join("\n"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "DSBox Test"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "dsbox-test@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["commit", "--quiet", "-m", "runtime fixture"], { cwd: repository });

  const hebrusBinary = path.join(repository, "hebrus-server");
  const ds4Binary = path.join(repository, "ds4-server");
  await writeFile(hebrusBinary, structuredExecutable("hebrus"), { mode: 0o755 });
  await writeFile(ds4Binary, structuredExecutable("ds4"), { mode: 0o755 });
  return { root, repository, stateHome, hebrusBinary, ds4Binary };
}

function manager(stateHome: string): RuntimeBridgeInternals {
  const store = { homeDirectory: stateHome } as ConfigStore;
  return new RuntimeManager(store, new EventBus()) as unknown as RuntimeBridgeInternals;
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

describe("filesystem runtime bridge smoke", () => {
  it("prefers and admits a real Hebrus executable, then stamps its exact path and hash", async () => {
    const fixture = await runtimeFixture();
    try {
      const runtime = manager(fixture.stateHome);
      const binary = await runtime.engineBinary(fixture.repository);
      expect(binary).toBe(fixture.hebrusBinary);
      await expect(probeEngineCapabilities(binary!, fixture.repository))
        .resolves.toMatchObject({ engine_id: "hebrus", executable_role: "server" });
      await expect(runtime.binaryHasExpertMajorV2Runtime(fixture.repository)).resolves.toBe(true);

      await runtime.recordBuildHead(fixture.repository, "hebrus-server");
      const stamp = JSON.parse(await readFile(runtime.buildStampPath(fixture.repository), "utf8")) as {
        binaryPath: string;
        binarySha256: string;
      };
      expect(stamp.binaryPath).toBe(fixture.hebrusBinary);
      expect(stamp.binarySha256).toBe(await sha256(fixture.hebrusBinary));
      await expect(runtime.buildMatchesHead(fixture.repository)).resolves.toBe(true);

      await appendFile(fixture.hebrusBinary, "# changed after stamp\n");
      await expect(runtime.buildMatchesHead(fixture.repository)).resolves.toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("stamps the explicit ds4-server build target even when a stale executable Hebrus file is present", async () => {
    const fixture = await runtimeFixture();
    try {
      const runtime = manager(fixture.stateHome);
      expect(await runtime.engineBinary(fixture.repository)).toBe(fixture.hebrusBinary);

      await runtime.recordBuildHead(fixture.repository, "ds4-server");
      const stamp = JSON.parse(await readFile(runtime.buildStampPath(fixture.repository), "utf8")) as {
        binaryPath: string;
        binarySha256: string;
      };
      expect(stamp.binaryPath).toBe(fixture.ds4Binary);
      expect(stamp.binarySha256).toBe(await sha256(fixture.ds4Binary));
      await expect(runtime.buildMatchesHead(fixture.repository)).resolves.toBe(false);

      await chmod(fixture.hebrusBinary, 0o644);
      const binary = await runtime.engineBinary(fixture.repository);
      expect(binary).toBe(fixture.ds4Binary);
      await expect(probeEngineCapabilities(binary!, fixture.repository))
        .resolves.toMatchObject({ engine_id: "ds4", executable_role: "server" });
      await expect(runtime.binaryHasExpertMajorV2Runtime(fixture.repository)).resolves.toBe(true);
      await expect(runtime.buildMatchesHead(fixture.repository)).resolves.toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed for a capability-less Hebrus executable but retains the real legacy DS4 fallback", async () => {
    const fixture = await runtimeFixture();
    try {
      await writeFile(fixture.hebrusBinary, legacyExecutable(), { mode: 0o755 });
      await writeFile(fixture.ds4Binary, legacyExecutable(), { mode: 0o755 });
      const runtime = manager(fixture.stateHome);

      expect(await runtime.engineBinary(fixture.repository)).toBe(fixture.hebrusBinary);
      await expect(runtime.binaryHasExpertMajorV2Runtime(fixture.repository))
        .rejects.toThrow(/hebrus-server does not expose the required structured capability contract/);

      await chmod(fixture.hebrusBinary, 0o644);
      expect(await runtime.engineBinary(fixture.repository)).toBe(fixture.ds4Binary);
      await expect(runtime.binaryHasExpertMajorV2Runtime(fixture.repository)).resolves.toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
