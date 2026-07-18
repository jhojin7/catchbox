import { removeE2eDataDirectory } from "./runtime-directory";

export default function globalSetup() {
  const dataDirectory = process.env.CATCHBOX_E2E_DATA_DIR;
  if (!dataDirectory) throw new Error("CATCHBOX_E2E_DATA_DIR was not set for browser setup");
  return () => removeE2eDataDirectory(dataDirectory);
}
