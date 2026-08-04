// Entry point for `node --import ./test/register.mjs`: installs the "@/" alias
// resolver before any test module is loaded.

import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL("./test/"));
