import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CANCELLED_RESULT = "__DSBOX_FILE_PICKER_CANCELLED__";

export const finderGgufPickerScript = `
try
  set selectedFile to choose file with prompt "Choose a GGUF model file" of type {"gguf"}
  return POSIX path of selectedFile
on error number -128
  return "${CANCELLED_RESULT}"
end try
`.trim();

export interface NativeFilePickerRunner {
  (executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>;
}

const runNativeFilePicker: NativeFilePickerRunner = async (executable, args) => {
  const result = await execFileAsync(executable, [...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30 * 60 * 1000
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function wasNativeCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = `${error.message}\n${"stderr" in error ? String(error.stderr) : ""}`;
  return /user canceled|\(-128\)|execution error.*-128/i.test(details);
}

/**
 * Opens Finder's native file chooser without interpolating any user input into
 * the AppleScript. The selected path is validated by RuntimeManager before it
 * is persisted, so this function deliberately does not read or upload the file.
 */
export async function chooseGgufFileInFinder(
  runner: NativeFilePickerRunner = runNativeFilePicker,
  currentPlatform: NodeJS.Platform = process.platform
): Promise<string | null> {
  if (currentPlatform !== "darwin") {
    throw new Error("Finder file selection is available on macOS only");
  }
  try {
    const { stdout } = await runner("/usr/bin/osascript", ["-e", finderGgufPickerScript]);
    const selectedPath = stdout.trim();
    if (!selectedPath || selectedPath === CANCELLED_RESULT) return null;
    return selectedPath;
  } catch (error) {
    if (wasNativeCancellation(error)) return null;
    throw new Error("The Finder file chooser could not be opened", { cause: error });
  }
}
